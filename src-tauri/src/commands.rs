use crate::adb;
use crate::audio::{self, AudioHandle};
use crate::control;
use crate::scrcpy::{self, StreamSettings};
use crate::state::{AppState, ScrcpySession};
use crate::video::{self, FrameEvent};
use base64::Engine;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

#[tauri::command]
pub async fn list_devices() -> Result<Vec<adb::Device>, String> {
    adb::list_devices().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn connect_device(
    app: AppHandle,
    serial: String,
    on_frame: Channel<FrameEvent>,
    settings: StreamSettings,
    state: State<'_, AppState>,
) -> Result<(u32, u32), String> {
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
    let server_path = resource_dir
        .join("resources")
        .join("scrcpy-server-v2.7");
    let server_path_str = server_path.to_string_lossy().to_string();

    let port: u16 = 27183;

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

    let session = ScrcpySession {
        device_serial: serial.clone(),
        control_socket: control_socket.clone(),
        screen_width: streams.screen_width,
        screen_height: streams.screen_height,
        shutdown: shutdown.clone(),
        audio: audio_handle,
    };

    let width = streams.screen_width;
    let height = streams.screen_height;

    {
        let mut s = state.session.lock().await;
        *s = Some(session);
    }

    let session_arc = state.session.clone();
    let serial_clone = serial.clone();

    tokio::spawn(async move {
        video::stream_video(streams.video_socket, on_frame, shutdown.clone()).await;
        scrcpy::stop_server(&serial_clone, port).await;
        let _ = server_process.kill().await;
        let mut s = session_arc.lock().await;
        *s = None;
    });

    Ok((width, height))
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
pub async fn wifi_connect(address: String) -> Result<(), String> {
    adb::connect_device(&address).await.map_err(|e| e.to_string())
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
