use another_core::{adb, control, macro_engine, scrcpy};
use another_core::scrcpy::StreamSettings;
use crate::audio::{self, AudioHandle};
use crate::state::{apply_audio_focus, AppState, ScrcpySession};
use crate::native_video;
use crate::remote::RemoteState;
use crate::stream_ws;
use crate::video::{self, FrameEvent};
use base64::Engine;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[tauri::command]
pub async fn list_devices() -> Result<Vec<adb::Device>, String> {
    adb::list_devices().await.map_err(|e| e.to_string())
}

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);
const VIEWER_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Stops the session shown in a window, if there is one.
pub async fn end_session(state: &AppState, label: &str) {
    let session = state.sessions.lock().await.remove(label);
    if let Some(session) = session {
        session.shutdown.notify_one();
        scrcpy::stop_server(&session.device_serial, session.port.port).await;
    }
}

#[tauri::command]
pub async fn connect_device(
    app: AppHandle,
    window: WebviewWindow,
    serial: String,
    on_frame: Channel<FrameEvent>,
    settings: StreamSettings,
    state: State<'_, AppState>,
) -> Result<(u32, u32, Option<String>, bool), String> {
    let label = window.label().to_string();
    end_session(&state, &label).await;

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    let server_path = resource_dir.join("resources").join(settings.server_file());
    let server_path_str = server_path.to_string_lossy().to_string();

    let lease = state
        .lease_port()
        .ok_or("Too many phones are mirroring at once. Close one and try again")?;
    let port = lease.port;

    let native = if settings.native_video {
        match native_video::NativeVideo::attach(window.clone(), on_frame.clone()) {
            Ok(native) => Some(native),
            Err(e) => {
                eprintln!("[native-video] falling back to the web renderer: {}", e);
                None
            }
        }
    } else {
        None
    };
    let native_active = native.is_some();

    let ws_endpoint = if settings.low_latency && !native_active {
        Some(
            stream_ws::bind()
                .await
                .map_err(|e| format!("Failed to open the video stream: {}", e))?,
        )
    } else {
        None
    };
    let ws_url = ws_endpoint.as_ref().map(|endpoint| endpoint.url.clone());

    let (streams, mut server_process) =
        scrcpy::start_server(&serial, &server_path_str, port, &settings)
            .await
            .map_err(|e| format!("Could not start mirroring: {}", e))?;

    let shutdown = Arc::new(tokio::sync::Notify::new());
    let control_socket = Arc::new(Mutex::new(streams.control_socket));

    let audio_handle = if let Some(audio_socket) = streams.audio_socket {
        let handle = AudioHandle::new()
            .map_err(|e| format!("Could not play the phone audio: {}", e))?;
        let handle = Arc::new(handle);
        let audio_shutdown = shutdown.clone();
        let audio_ref = handle.clone();
        tokio::spawn(async move {
            audio::stream_audio(audio_socket, audio_ref, audio_shutdown).await;
        });
        Some(handle)
    } else {
        None
    };

    let session_id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    let session = ScrcpySession {
        id: session_id,
        device_serial: serial.clone(),
        control_socket: control_socket.clone(),
        screen_width: streams.screen_width,
        screen_height: streams.screen_height,
        shutdown: shutdown.clone(),
        audio: audio_handle,
        muted: false,
        live_video_control: settings.another_server,
        port: lease,
    };

    let width = streams.screen_width;
    let height = streams.screen_height;

    {
        let mut sessions = state.sessions.lock().await;
        if let Some(replaced) = sessions.insert(label.clone(), session) {
            replaced.shutdown.notify_one();
        }
        let mut focus = state.audio_focus.lock().await;
        let focus_is_stale = focus.as_ref().is_none_or(|current| !sessions.contains_key(current));
        if focus_is_stale || window.is_focused().unwrap_or(false) {
            *focus = Some(label.clone());
        }
        apply_audio_focus(&sessions, focus.as_deref());
    }

    let sessions_arc = state.sessions.clone();
    let serial_clone = serial.clone();

    let video_codec = if settings.video_codec == "h265" {
        video::VideoCodec::H265
    } else {
        video::VideoCodec::H264
    };

    tokio::spawn(async move {
        let ws = match ws_endpoint {
            Some(endpoint) => endpoint.accept(VIEWER_CONNECT_TIMEOUT).await.map(Some),
            None => Ok(None),
        };
        match ws {
            Ok(ws) => {
                video::stream_video(streams.video_socket, on_frame, ws, native, shutdown.clone(), video_codec)
                    .await
            }
            Err(e) => {
                let _ = on_frame.send(FrameEvent::Disconnected {
                    reason: e.to_string(),
                });
            }
        }
        let _ = server_process.kill().await;
        let mut sessions = sessions_arc.lock().await;
        if sessions.get(&label).is_some_and(|current| current.id == session_id) {
            let ended = sessions.remove(&label);
            drop(sessions);
            scrcpy::stop_server(&serial_clone, port).await;
            drop(ended);
        }
    });

    Ok((width, height, ws_url, native_active))
}

const NATIVE_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

#[tauri::command]
pub async fn native_latency_probe(window: WebviewWindow, x: f64, y: f64, state: State<'_, AppState>) -> Result<f64, String> {
    let (socket, width, height) = {
        let sessions = state.sessions.lock().await;
        let session = sessions.get(window.label()).ok_or("Not connected")?;
        (session.control_socket.clone(), session.screen_width, session.screen_height)
    };
    let px = (x * width as f64) as u32;
    let py = (y * height as f64) as u32;
    let seen = native_video::arm_probe(window.label(), x, y).map_err(|e| e.to_string())?;
    let started = std::time::Instant::now();
    let pressed = control::inject_touch(&socket, "down", px, py, width as u16, height as u16).await;
    let result = tokio::task::spawn_blocking(move || seen.recv_timeout(NATIVE_PROBE_TIMEOUT)).await;
    native_video::disarm_probe(window.label());
    let _ = control::inject_touch(&socket, "up", px, py, width as u16, height as u16).await;
    pressed.map_err(|e| e.to_string())?;
    match result {
        Ok(Ok(shown)) => Ok(shown.duration_since(started).as_secs_f64() * 1000.0),
        _ => Err("The tap never showed up on screen".into()),
    }
}

#[tauri::command]
pub fn set_native_video_frame(window: WebviewWindow, x: f64, y: f64, width: f64, height: f64) {
    native_video::set_frame(window.label(), x, y, width, height);
}

#[tauri::command]
pub async fn disconnect_device(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    native_video::detach(window.label());
    end_session(&state, window.label()).await;
    Ok(())
}

#[tauri::command]
pub async fn set_muted(window: WebviewWindow, muted: bool, state: State<'_, AppState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions.get_mut(window.label()).ok_or("Not connected")?;
    session.muted = muted;
    let focus = state.audio_focus.lock().await;
    apply_audio_focus(&sessions, focus.as_deref());
    Ok(())
}

#[tauri::command]
pub async fn send_touch(
    window: WebviewWindow,
    action: String,
    x: f64,
    y: f64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions.get(window.label()).ok_or("Not connected")?;
    let px = (x * session.screen_width as f64) as u32;
    let py = (y * session.screen_height as f64) as u32;
    control::inject_touch(
        &session.control_socket,
        &action,
        px,
        py,
        session.screen_width as u16,
        session.screen_height as u16,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn send_key(
    window: WebviewWindow,
    keycode: u32,
    action: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions.get(window.label()).ok_or("Not connected")?;
    control::inject_keycode(&session.control_socket, &action, keycode, 0, 0)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn send_text(window: WebviewWindow, text: String, state: State<'_, AppState>) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions.get(window.label()).ok_or("Not connected")?;
    control::inject_text(&session.control_socket, &text)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn send_scroll(
    window: WebviewWindow,
    x: f64,
    y: f64,
    dx: f64,
    dy: f64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions.get(window.label()).ok_or("Not connected")?;
    let px = (x * session.screen_width as f64) as u32;
    let py = (y * session.screen_height as f64) as u32;
    let sx = (dx * 120.0) as i16;
    let sy = (dy * 120.0) as i16;
    control::inject_scroll(
        &session.control_socket,
        px,
        py,
        session.screen_width as u16,
        session.screen_height as u16,
        sx,
        sy,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn take_screenshot(window: WebviewWindow, state: State<'_, AppState>) -> Result<String, String> {
    let sessions = state.sessions.lock().await;
    let session = sessions.get(window.label()).ok_or("Not connected")?;
    let png_data = adb::exec_out_screencap(&session.device_serial)
        .await
        .map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&png_data))
}

#[tauri::command]
pub async fn press_button(window: WebviewWindow, button: String, state: State<'_, AppState>) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions.get(window.label()).ok_or("Not connected")?;
    let keycode = match button.as_str() {
        "home" => control::KEYCODE_HOME,
        "back" => control::KEYCODE_BACK,
        "recents" => control::KEYCODE_APP_SWITCH,
        "power" => control::KEYCODE_POWER,
        "volume_up" => control::KEYCODE_VOLUME_UP,
        "volume_down" => control::KEYCODE_VOLUME_DOWN,
        _ => return Err(format!("Unknown button: {}", button)),
    };
    control::inject_keycode(&session.control_socket, "down", keycode, 0, 0)
        .await
        .map_err(|e| e.to_string())?;
    control::inject_keycode(&session.control_socket, "up", keycode, 0, 0)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_screen_size(window: WebviewWindow, width: u32, height: u32, state: State<'_, AppState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions.get_mut(window.label()).ok_or("Not connected")?;
    session.screen_width = width;
    session.screen_height = height;
    Ok(())
}

#[tauri::command]
pub async fn rotate_device(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions.get(window.label()).ok_or("Not connected")?;
    control::rotate_device(&session.control_socket)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn wake_screen(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions.get(window.label()).ok_or("Not connected")?;

    let is_on = adb::shell(&session.device_serial, "dumpsys power | grep 'Display Power'")
        .await
        .map_err(|e| e.to_string())?
        .wait_with_output()
        .await
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("state=ON"))
        .unwrap_or(true);

    if !is_on {
        control::inject_keycode(
            &session.control_socket,
            "down",
            control::KEYCODE_WAKEUP,
            0,
            0,
        )
        .await
        .map_err(|e| e.to_string())?;
        control::inject_keycode(
            &session.control_socket,
            "up",
            control::KEYCODE_WAKEUP,
            0,
            0,
        )
        .await
        .map_err(|e| e.to_string())?;
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }

    Ok(())
}

#[tauri::command]
pub async fn play_macro(
    window: WebviewWindow,
    events: Vec<macro_engine::TimedEvent>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (socket, sw, sh) = {
        let sessions = state.sessions.lock().await;
        let session = sessions.get(window.label()).ok_or("Not connected")?;
        (
            session.control_socket.clone(),
            session.screen_width,
            session.screen_height,
        )
    };
    macro_engine::play_events(&events, &socket, sw, sh)
        .await
        .map_err(|e| e.to_string())
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn macro_path(dir: &str, name: &str) -> PathBuf {
    PathBuf::from(dir).join(format!("{}.json", sanitize_filename(name)))
}

#[derive(Serialize)]
pub struct MacroInfo {
    pub name: String,
    pub event_count: usize,
}

#[tauri::command]
pub async fn get_default_macros_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("macros");
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn list_macro_files(dir: String) -> Result<Vec<MacroInfo>, String> {
    let path = PathBuf::from(&dir);
    if !path.exists() {
        return Ok(Vec::new());
    }

    let order_path = path.join("_order.json");
    let order: Vec<String> = if order_path.exists() {
        let data = tokio::fs::read_to_string(&order_path)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Vec::new()
    };

    let mut entries = tokio::fs::read_dir(&path)
        .await
        .map_err(|e| e.to_string())?;

    let mut macros: Vec<MacroInfo> = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let fname = entry.file_name().to_string_lossy().to_string();
        if !fname.ends_with(".json") || fname == "_order.json" {
            continue;
        }
        let data = match tokio::fs::read_to_string(entry.path()).await {
            Ok(d) => d,
            Err(_) => continue,
        };
        let m: macro_engine::Macro = match serde_json::from_str(&data) {
            Ok(m) => m,
            Err(_) => continue,
        };
        macros.push(MacroInfo {
            name: m.name,
            event_count: m.events.len(),
        });
    }

    if !order.is_empty() {
        macros.sort_by_key(|m| {
            order
                .iter()
                .position(|n| n == &m.name)
                .unwrap_or(usize::MAX)
        });
    }

    Ok(macros)
}

#[tauri::command]
pub async fn load_macro_file(
    dir: String,
    name: String,
) -> Result<macro_engine::Macro, String> {
    let path = macro_path(&dir, &name);
    let data = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read macro: {}", e))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse macro: {}", e))
}

#[tauri::command]
pub async fn save_macro_file(
    dir: String,
    macro_data: macro_engine::Macro,
) -> Result<(), String> {
    let path = PathBuf::from(&dir);
    tokio::fs::create_dir_all(&path)
        .await
        .map_err(|e| e.to_string())?;

    let file_path = macro_path(&dir, &macro_data.name);
    let json = serde_json::to_string_pretty(&macro_data).map_err(|e| e.to_string())?;
    tokio::fs::write(&file_path, json)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_macro_file(dir: String, name: String) -> Result<(), String> {
    let path = macro_path(&dir, &name);
    if path.exists() {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn rename_macro_file(
    dir: String,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    let old_path = macro_path(&dir, &old_name);
    if !old_path.exists() {
        return Err(format!("Macro '{}' not found", old_name));
    }

    let data = tokio::fs::read_to_string(&old_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut m: macro_engine::Macro =
        serde_json::from_str(&data).map_err(|e| e.to_string())?;
    m.name = new_name.clone();

    let new_path = macro_path(&dir, &new_name);
    let json = serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?;
    tokio::fs::write(&new_path, json)
        .await
        .map_err(|e| e.to_string())?;

    if old_path != new_path {
        tokio::fs::remove_file(&old_path)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn save_macros_order(dir: String, order: Vec<String>) -> Result<(), String> {
    let path = PathBuf::from(&dir);
    tokio::fs::create_dir_all(&path)
        .await
        .map_err(|e| e.to_string())?;

    let order_path = path.join("_order.json");
    let json = serde_json::to_string_pretty(&order).map_err(|e| e.to_string())?;
    tokio::fs::write(&order_path, json)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_file(path: String, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;
    let file_path = PathBuf::from(&path);
    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    tokio::fs::write(&file_path, bytes)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
pub async fn wifi_connect(address: String) -> Result<(), String> {
    adb::connect_device(&address).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tailnet_status() -> Result<another_core::tailnet::TailnetStatus, String> {
    another_core::tailnet::status().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn wifi_disconnect(address: String) -> Result<(), String> {
    adb::disconnect_device(&address).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_device_ip(serial: String) -> Result<Option<String>, String> {
    adb::get_device_ip(&serial).await.map_err(|e| e.to_string())
}

const DEFAULT_WIFI_PORT: u16 = 5555;

#[tauri::command]
pub async fn wifi_enable(serial: String, port: Option<u16>) -> Result<String, String> {
    let port = port.unwrap_or(DEFAULT_WIFI_PORT);
    let ip = adb::get_device_ip(&serial)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Device is not connected to WiFi. Connect it to the same network as this computer.".to_string())?;

    adb::tcpip(&serial, port)
        .await
        .map_err(|e| e.to_string())?;

    let addr = format!("{}:{}", ip, port);
    let mut connected = false;
    for _ in 0..5 {
        tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;
        if adb::connect_device(&addr).await.is_ok() {
            connected = true;
            break;
        }
    }

    if !connected {
        return Err(format!("Could not connect to {}. Make sure the phone and this computer are on the same Wi-Fi", addr));
    }

    Ok(addr)
}

#[tauri::command]
pub async fn start_mcp_server(
    port: u16,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut mcp = state.mcp.lock().await;

    if mcp.cancel.is_some() {
        return Ok(());
    }

    let scrcpy_server_path = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| {
            dir.join("resources")
                .join(scrcpy::SCRCPY_SERVER_FILE)
                .to_string_lossy()
                .to_string()
        });

    let ct = CancellationToken::new();
    mcp.cancel = Some(ct.clone());
    mcp.port = port;

    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            if let Err(e) = another_mcp::start_sse_server(port, scrcpy_server_path, ct).await {
                eprintln!("[mcp] server error: {}", e);
            }
        });
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_mcp_server(state: State<'_, AppState>) -> Result<(), String> {
    let mut mcp = state.mcp.lock().await;
    if let Some(ct) = mcp.cancel.take() {
        ct.cancel();
    }
    Ok(())
}

async fn live_control_socket(window: &WebviewWindow, state: &State<'_, AppState>) -> Result<Arc<Mutex<another_core::transport::DeviceStream>>, String> {
    let sessions = state.sessions.lock().await;
    let session = sessions.get(window.label()).ok_or("Not connected")?;
    if !session.live_video_control {
        return Err("Live video control needs the Another server".into());
    }
    Ok(session.control_socket.clone())
}

#[tauri::command]
pub async fn set_video_bit_rate(window: WebviewWindow, bit_rate: u32, state: State<'_, AppState>) -> Result<(), String> {
    let socket = live_control_socket(&window, &state).await?;
    control::set_video_bit_rate(&socket, bit_rate)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_video_size(window: WebviewWindow, max_size: u32, max_fps: u32, state: State<'_, AppState>) -> Result<(), String> {
    let serial = state
        .sessions
        .lock()
        .await
        .get(window.label())
        .map(|session| session.device_serial.clone())
        .ok_or("Not connected")?;
    let socket = live_control_socket(&window, &state).await?;
    let peak = adb::peak_refresh_rate(&serial).await.map_or(u32::MAX, |rate| rate.round() as u32);
    let max_size = max_size.min(u32::from(u16::MAX)) as u16;
    let max_fps = max_fps.min(peak).min(u32::from(u16::MAX)) as u16;
    control::set_video_size(&socket, max_size, max_fps)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn request_key_frame(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    let socket = live_control_socket(&window, &state).await?;
    control::request_key_frame(&socket).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_show_touches(window: WebviewWindow, enabled: bool, state: State<'_, AppState>) -> Result<bool, String> {
    let serial = {
        let sessions = state.sessions.lock().await;
        sessions.get(window.label()).ok_or("Not connected")?.device_serial.clone()
    };
    let previous = adb::shell_text(&serial, "settings get system show_touches")
        .await
        .map_err(|e| e.to_string())?;
    adb::shell_text(
        &serial,
        &format!("settings put system show_touches {}", u8::from(enabled)),
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(previous.trim() == "1")
}

#[tauri::command]
pub fn log_perf(stats: serde_json::Value, remote: State<'_, Arc<RemoteState>>) {
    remote.record_perf(&stats);
    eprintln!("[perf] {}", stats);
}

#[tauri::command]
pub fn report_ui_state(state: serde_json::Value, remote: State<'_, Arc<RemoteState>>) {
    remote.set_ui(state);
}

#[tauri::command]
pub fn take_pending_commands(remote: State<'_, Arc<RemoteState>>) -> Vec<serde_json::Value> {
    remote.take_pending()
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
pub async fn get_mcp_status(state: State<'_, AppState>) -> Result<bool, String> {
    let mcp = state.mcp.lock().await;
    Ok(mcp.cancel.is_some())
}

#[tauri::command]
pub async fn device_screenshot(serial: String) -> Result<Option<String>, String> {
    let png = adb::lock_screen_capture(&serial).await.map_err(|e| e.to_string())?;
    Ok(png
        .filter(|data| !data.is_empty())
        .map(|data| base64::engine::general_purpose::STANDARD.encode(&data)))
}

#[tauri::command]
pub async fn adb_pair(address: String, code: String) -> Result<(), String> {
    adb::pair(&address, &code).await.map_err(|e| e.to_string())
}

const QR_NAME_PREFIX: &str = "another-";
const QR_NAME_LEN: usize = 8;
const QR_PASSWORD_LEN: usize = 12;
/// No 0/O or 1/l/I, so the values stay readable in logs.
const QR_ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const QR_SCAN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);
const QR_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const QR_POLL: std::time::Duration = std::time::Duration::from_millis(800);

/// The pairing name of the QR code on screen. Cleared when the dialog closes, which stops the wait.
static QR_SESSION: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[derive(Serialize)]
pub struct QrPairing {
    name: String,
    password: String,
    size: usize,
    modules: Vec<bool>,
}

fn random_text(len: usize) -> Result<String, String> {
    let mut bytes = vec![0u8; len];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes
        .iter()
        .map(|b| QR_ALPHABET[*b as usize % QR_ALPHABET.len()] as char)
        .collect())
}

fn qr_session_is(name: &str) -> bool {
    QR_SESSION
        .lock()
        .map(|session| session.as_deref() == Some(name))
        .unwrap_or(false)
}

/// Makes a new pairing code for Wireless debugging, Pair device with QR code.
#[tauri::command]
pub fn qr_pair_start() -> Result<QrPairing, String> {
    let name = format!("{}{}", QR_NAME_PREFIX, random_text(QR_NAME_LEN)?);
    let password = random_text(QR_PASSWORD_LEN)?;
    let code = qrcode::QrCode::new(adb::pairing_qr_payload(&name, &password)).map_err(|e| e.to_string())?;
    let modules = code
        .to_colors()
        .into_iter()
        .map(|color| color == qrcode::Color::Dark)
        .collect();
    if let Ok(mut session) = QR_SESSION.lock() {
        *session = Some(name.clone());
    }
    Ok(QrPairing {
        name,
        password,
        size: code.width(),
        modules,
    })
}

#[tauri::command]
pub fn qr_pair_cancel() {
    if let Ok(mut session) = QR_SESSION.lock() {
        *session = None;
    }
}

#[derive(Serialize)]
pub struct QrPaired {
    serial: String,
    host: String,
}

/// Waits for the phone that scanned the code, pairs with it and connects.
#[tauri::command]
pub async fn qr_pair_wait(name: String, password: String) -> Result<QrPaired, String> {
    let result = qr_pair(&name, &password).await;
    if qr_session_is(&name) {
        qr_pair_cancel();
    }
    result
}

async fn qr_pair(name: &str, password: &str) -> Result<QrPaired, String> {
    let deadline = std::time::Instant::now() + QR_SCAN_TIMEOUT;
    let pairing = loop {
        if !qr_session_is(name) {
            return Err("Cancelled".to_string());
        }
        let services = adb::mdns_services().await.map_err(|e| {
            eprintln!("[qr-pair] mdns services failed: {}", e);
            "This computer cannot find phones on Wi-Fi. Use a pairing code instead".to_string()
        })?;
        if let Some(service) = services
            .into_iter()
            .find(|s| s.kind == adb::PAIRING_SERVICE && s.name == name)
        {
            break service;
        }
        if std::time::Instant::now() >= deadline {
            return Err("The code expired. Make a new one and scan it again".to_string());
        }
        tokio::time::sleep(QR_POLL).await;
    };

    let known: std::collections::HashSet<String> = adb::list_devices()
        .await
        .map(|devices| devices.into_iter().map(|d| d.serial).collect())
        .unwrap_or_default();
    adb::pair(&pairing.address, password).await.map_err(|e| e.to_string())?;

    let host = pairing.host().to_string();
    let deadline = std::time::Instant::now() + QR_CONNECT_TIMEOUT;
    loop {
        if !qr_session_is(name) {
            return Err("Cancelled".to_string());
        }
        if let Ok(devices) = adb::list_devices().await {
            let joined = devices.into_iter().find(|d| {
                d.state == "device"
                    && !known.contains(&d.serial)
                    && (d.serial.starts_with(&host) || d.serial.contains(adb::CONNECT_SERVICE))
            });
            if let Some(device) = joined {
                return Ok(QrPaired { serial: device.serial, host });
            }
        }
        if let Ok(services) = adb::mdns_services().await {
            let connect = services
                .into_iter()
                .find(|s| s.kind == adb::CONNECT_SERVICE && s.host() == host);
            if let Some(service) = connect {
                if adb::connect_device(&service.address).await.is_ok() {
                    return Ok(QrPaired { serial: service.address, host });
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err("Paired, but the phone did not connect. Turn Wireless debugging off and on, then try again".to_string());
        }
        tokio::time::sleep(QR_POLL).await;
    }
}

#[tauri::command]
pub async fn phone_notifications(
    serial: String,
) -> Result<Vec<another_core::notifications::PhoneNotification>, String> {
    adb::notifications(&serial).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_phone_app(serial: String, package: String) -> Result<(), String> {
    adb::launch_app(&serial, &package).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_stay_on(serial: String, value: String) -> Result<String, String> {
    adb::set_stay_on(&serial, &value).await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified_ms: u64,
}

#[tauri::command]
pub async fn list_files(dir: String, prefix: String) -> Result<Vec<FileEntry>, String> {
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut files: Vec<FileEntry> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if !name.starts_with(&prefix) {
                return None;
            }
            let meta = entry.metadata().ok()?;
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64);
            Some(FileEntry { path: entry.path().to_string_lossy().into_owned(), name, size: meta.len(), modified_ms })
        })
        .collect();
    files.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(files)
}

#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn device_info(serial: String) -> Result<adb::DeviceInfo, String> {
    adb::device_info(&serial).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn device_facts(serial: String) -> Result<adb::DeviceFacts, String> {
    adb::device_facts(&serial).await.map_err(|e| e.to_string())
}

const CLI_NAME: &str = "another-cli";
const CLI_COMMAND: &str = "another";
const CLI_INSTALL_DIR: &str = "/usr/local/bin";

fn cli_link() -> PathBuf {
    PathBuf::from(CLI_INSTALL_DIR).join(CLI_COMMAND)
}

/// True when the `another` link on the PATH points at a copy of this app's CLI.
fn link_is_ours(link: &std::path::Path) -> bool {
    std::fs::read_link(link)
        .map(|target| target.file_name().is_some_and(|name| name == CLI_NAME))
        .unwrap_or(false)
}

fn bundled_cli() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = exe
        .parent()
        .ok_or("The app has no folder")?
        .join(CLI_NAME);
    if path.exists() {
        Ok(path)
    } else {
        Err(format!("{} is not bundled with this build of Another", CLI_NAME))
    }
}

/// Where the `another` command is installed on the PATH, if this app installed it.
#[tauri::command]
pub async fn cli_status() -> Option<String> {
    let link = cli_link();
    (link.exists() && link_is_ours(&link)).then(|| link.to_string_lossy().into_owned())
}

/// Links the bundled CLI into /usr/local/bin as `another`, asking for an administrator password
/// through macOS only when the folder is not writable.
#[cfg(unix)]
#[tauri::command]
pub async fn install_cli() -> Result<String, String> {
    let source = bundled_cli()?;
    let link = cli_link();
    if link.symlink_metadata().is_ok() && !link_is_ours(&link) {
        return Err(format!("{} already has a different command named {}", CLI_INSTALL_DIR, CLI_COMMAND));
    }
    let direct = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(CLI_INSTALL_DIR)?;
        if link.symlink_metadata().is_ok() {
            std::fs::remove_file(&link)?;
        }
        std::os::unix::fs::symlink(&source, &link)
    })();
    match direct {
        Ok(()) => Ok(link.to_string_lossy().into_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            let quote = |p: &std::path::Path| p.to_string_lossy().replace('\'', "'\\''");
            let shell = format!(
                "mkdir -p '{dir}' && ln -sf '{src}' '{dst}'",
                dir = CLI_INSTALL_DIR,
                src = quote(&source),
                dst = quote(&link),
            );
            let script = format!(
                "do shell script \"{}\" with prompt \"Another wants to add the another command to your Terminal.\" with administrator privileges",
                shell.replace('\\', "\\\\").replace('"', "\\\"")
            );
            let output = tokio::process::Command::new("osascript")
                .args(["-e", &script])
                .output()
                .await
                .map_err(|e| e.to_string())?;
            if output.status.success() {
                Ok(link.to_string_lossy().into_owned())
            } else {
                let message = String::from_utf8_lossy(&output.stderr);
                if message.contains("-128") {
                    Err("Cancelled".to_string())
                } else {
                    Err(message.trim().to_string())
                }
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(not(unix))]
#[tauri::command]
pub async fn install_cli() -> Result<String, String> {
    Err(format!("Add the folder that holds {} to your PATH to use it as {}", CLI_NAME, CLI_COMMAND))
}

#[tauri::command]
pub async fn set_window_blur(window: tauri::WebviewWindow, percent: u32) -> Result<(), String> {
    crate::window_blur::set_blur(&window, percent).map_err(|e| e.to_string())
}

pub const MIRROR_LABEL_PREFIX: &str = "mirror-";
const MIRROR_DEFAULT_SIZE: (f64, f64) = (420.0, 860.0);
/// The phone view's minimum plus the window chrome around it in `MirrorScreen`.
const MIRROR_MIN_SIZE: (f64, f64) = (336.0, 300.0);
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHTS: (f64, f64) = (28.0, 28.0);

/// One window per phone, so the label is derived from the serial.
pub fn mirror_label(serial: &str) -> String {
    let safe: String = serial
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    format!("{}{}", MIRROR_LABEL_PREFIX, safe)
}

#[derive(serde::Deserialize)]
pub struct WindowBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Opens the phone's mirror window, or brings it forward when it is already open.
#[tauri::command]
pub async fn open_mirror(
    app: AppHandle,
    serial: String,
    title: String,
    details: serde_json::Map<String, serde_json::Value>,
    bounds: Option<WindowBounds>,
) -> Result<(), String> {
    let label = mirror_label(&serial);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.show();
        return window.set_focus().map_err(|e| e.to_string());
    }
    let mut identity = details;
    identity.insert("serial".into(), serial.clone().into());
    identity.insert("title".into(), title.clone().into());
    let identity = serde_json::Value::Object(identity);
    let mut builder = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title(&title)
        .initialization_script(format!("window.__ANOTHER_MIRROR__ = {};", identity))
        .min_inner_size(MIRROR_MIN_SIZE.0, MIRROR_MIN_SIZE.1)
        .resizable(true)
        .accept_first_mouse(true);
    builder = match bounds {
        Some(b) => builder.inner_size(b.width, b.height).position(b.x, b.y),
        None => builder.inner_size(MIRROR_DEFAULT_SIZE.0, MIRROR_DEFAULT_SIZE.1).center(),
    };
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(TRAFFIC_LIGHTS.0, TRAFFIC_LIGHTS.1));
    }
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// Closes a phone's mirror window, which ends its session.
#[tauri::command]
pub async fn close_mirror(app: AppHandle, serial: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&mirror_label(&serial)) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod mirror_tests {
    use super::mirror_label;

    #[test]
    fn mirror_labels_only_use_safe_characters() {
        assert_eq!(mirror_label("192.168.1.24:5555"), "mirror-192_168_1_24_5555");
        assert_eq!(mirror_label("emulator-5554"), "mirror-emulator-5554");
        assert_eq!(mirror_label("adb-R58M._adb-tls-connect._tcp"), "mirror-adb-R58M__adb-tls-connect__tcp");
    }
}
