use another_core::{adb, control, macro_engine, scrcpy};
use another_core::scrcpy::StreamSettings;
use crate::audio::{self, AudioHandle};
use crate::state::{AppState, ScrcpySession};
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
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[tauri::command]
pub async fn list_devices() -> Result<Vec<adb::Device>, String> {
    adb::list_devices().await.map_err(|e| e.to_string())
}

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);
const VIEWER_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[tauri::command]
pub async fn connect_device(
    app: AppHandle,
    serial: String,
    on_frame: Channel<FrameEvent>,
    settings: StreamSettings,
    state: State<'_, AppState>,
) -> Result<(u32, u32, Option<String>, bool), String> {
    {
        let mut session = state.session.lock().await;
        if let Some(s) = session.take() {
            s.shutdown.notify_one();
            scrcpy::stop_server(&s.device_serial, 27183).await;
        }
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    let server_path = resource_dir.join("resources").join(settings.server_file());
    let server_path_str = server_path.to_string_lossy().to_string();

    let port: u16 = 27183;

    let native = if settings.native_video {
        let window = app
            .get_webview_window("main")
            .or_else(|| app.webview_windows().into_values().next());
        match window.map(|w| native_video::NativeVideo::attach(w, on_frame.clone())) {
            Some(Ok(native)) => Some(native),
            Some(Err(e)) => {
                eprintln!("[native-video] falling back to the web renderer: {}", e);
                None
            }
            None => None,
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
            .map_err(|e| format!("Failed to start scrcpy server: {}", e))?;

    let shutdown = Arc::new(tokio::sync::Notify::new());
    let control_socket = Arc::new(Mutex::new(streams.control_socket));

    let audio_handle = if let Some(audio_socket) = streams.audio_socket {
        let handle = AudioHandle::new()
            .map_err(|e| format!("Failed to init audio: {}", e))?;
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
        live_video_control: settings.another_server,
    };

    let width = streams.screen_width;
    let height = streams.screen_height;

    {
        let mut s = state.session.lock().await;
        *s = Some(session);
    }

    let session_arc = state.session.clone();
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
        let mut s = session_arc.lock().await;
        if s.as_ref().is_some_and(|current| current.id == session_id) {
            *s = None;
            drop(s);
            scrcpy::stop_server(&serial_clone, port).await;
        }
    });

    Ok((width, height, ws_url, native_active))
}

const NATIVE_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

#[tauri::command]
pub async fn native_latency_probe(x: f64, y: f64, state: State<'_, AppState>) -> Result<f64, String> {
    let (socket, width, height) = {
        let session = state.session.lock().await;
        let session = session.as_ref().ok_or("Not connected")?;
        (session.control_socket.clone(), session.screen_width, session.screen_height)
    };
    let px = (x * width as f64) as u32;
    let py = (y * height as f64) as u32;
    let seen = native_video::arm_probe(x, y).map_err(|e| e.to_string())?;
    let started = std::time::Instant::now();
    let pressed = control::inject_touch(&socket, "down", px, py, width as u16, height as u16).await;
    let result = tokio::task::spawn_blocking(move || seen.recv_timeout(NATIVE_PROBE_TIMEOUT)).await;
    native_video::disarm_probe();
    let _ = control::inject_touch(&socket, "up", px, py, width as u16, height as u16).await;
    pressed.map_err(|e| e.to_string())?;
    match result {
        Ok(Ok(shown)) => Ok(shown.duration_since(started).as_secs_f64() * 1000.0),
        _ => Err("The tap never showed up on screen".into()),
    }
}

#[tauri::command]
pub fn set_native_video_frame(x: f64, y: f64, width: f64, height: f64) {
    native_video::set_frame(x, y, width, height);
}

#[tauri::command]
pub async fn disconnect_device(state: State<'_, AppState>) -> Result<(), String> {
    let mut session = state.session.lock().await;
    if let Some(s) = session.take() {
        s.shutdown.notify_one();
        scrcpy::stop_server(&s.device_serial, 27183).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_muted(muted: bool, state: State<'_, AppState>) -> Result<(), String> {
    let session = state.session.lock().await;
    let session = session.as_ref().ok_or("Not connected")?;
    if let Some(audio) = &session.audio {
        if muted {
            audio.sink.set_volume(0.0);
        } else {
            audio.sink.set_volume(1.0);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn send_touch(
    action: String,
    x: f64,
    y: f64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session = state.session.lock().await;
    let session = session.as_ref().ok_or("Not connected")?;
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
    keycode: u32,
    action: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session = state.session.lock().await;
    let session = session.as_ref().ok_or("Not connected")?;
    control::inject_keycode(&session.control_socket, &action, keycode, 0, 0)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn send_text(text: String, state: State<'_, AppState>) -> Result<(), String> {
    let session = state.session.lock().await;
    let session = session.as_ref().ok_or("Not connected")?;
    control::inject_text(&session.control_socket, &text)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn send_scroll(
    x: f64,
    y: f64,
    dx: f64,
    dy: f64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session = state.session.lock().await;
    let session = session.as_ref().ok_or("Not connected")?;
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
pub async fn take_screenshot(state: State<'_, AppState>) -> Result<String, String> {
    let session = state.session.lock().await;
    let session = session.as_ref().ok_or("Not connected")?;
    let png_data = adb::exec_out_screencap(&session.device_serial)
        .await
        .map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&png_data))
}

#[tauri::command]
pub async fn press_button(button: String, state: State<'_, AppState>) -> Result<(), String> {
    let session = state.session.lock().await;
    let session = session.as_ref().ok_or("Not connected")?;
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
pub async fn update_screen_size(width: u32, height: u32, state: State<'_, AppState>) -> Result<(), String> {
    let mut session = state.session.lock().await;
    let session = session.as_mut().ok_or("Not connected")?;
    session.screen_width = width;
    session.screen_height = height;
    Ok(())
}

#[tauri::command]
pub async fn rotate_device(state: State<'_, AppState>) -> Result<(), String> {
    let session = state.session.lock().await;
    let session = session.as_ref().ok_or("Not connected")?;
    control::rotate_device(&session.control_socket)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn wake_screen(state: State<'_, AppState>) -> Result<(), String> {
    let session = state.session.lock().await;
    let session = session.as_ref().ok_or("Not connected")?;

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
    events: Vec<macro_engine::TimedEvent>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (socket, sw, sh) = {
        let session = state.session.lock().await;
        let session = session.as_ref().ok_or("Not connected")?;
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

#[tauri::command]
pub async fn wifi_enable(serial: String) -> Result<String, String> {
    let ip = adb::get_device_ip(&serial)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Device is not connected to WiFi. Connect it to the same network as this computer.".to_string())?;

    adb::tcpip(&serial, 5555)
        .await
        .map_err(|e| e.to_string())?;

    let addr = format!("{}:5555", ip);
    let mut connected = false;
    for _ in 0..5 {
        tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;
        if adb::connect_device(&addr).await.is_ok() {
            connected = true;
            break;
        }
    }

    if !connected {
        return Err(format!("Could not connect to {} -- make sure both devices are on the same WiFi network", addr));
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

async fn live_control_socket(state: &State<'_, AppState>) -> Result<Arc<Mutex<another_core::transport::DeviceStream>>, String> {
    let session = state.session.lock().await;
    let session = session.as_ref().ok_or("Not connected")?;
    if !session.live_video_control {
        return Err("Live video control needs the Another server".into());
    }
    Ok(session.control_socket.clone())
}

#[tauri::command]
pub async fn set_video_bit_rate(bit_rate: u32, state: State<'_, AppState>) -> Result<(), String> {
    let socket = live_control_socket(&state).await?;
    control::set_video_bit_rate(&socket, bit_rate)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_video_size(max_size: u32, max_fps: u32, state: State<'_, AppState>) -> Result<(), String> {
    let serial = state
        .session
        .lock()
        .await
        .as_ref()
        .map(|session| session.device_serial.clone())
        .ok_or("Not connected")?;
    let socket = live_control_socket(&state).await?;
    let peak = adb::peak_refresh_rate(&serial).await.map_or(u32::MAX, |rate| rate.round() as u32);
    let max_size = max_size.min(u32::from(u16::MAX)) as u16;
    let max_fps = max_fps.min(peak).min(u32::from(u16::MAX)) as u16;
    control::set_video_size(&socket, max_size, max_fps)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn request_key_frame(state: State<'_, AppState>) -> Result<(), String> {
    let socket = live_control_socket(&state).await?;
    control::request_key_frame(&socket).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_show_touches(enabled: bool, state: State<'_, AppState>) -> Result<bool, String> {
    let serial = {
        let session = state.session.lock().await;
        session.as_ref().ok_or("Not connected")?.device_serial.clone()
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
