mod audio;
mod commands;
mod state;
#[cfg(target_os = "macos")]
mod native_video;
#[cfg(not(target_os = "macos"))]
#[path = "native_video_stub.rs"]
mod native_video;
#[cfg(target_os = "macos")]
mod phone_notify;
#[cfg(not(target_os = "macos"))]
#[path = "phone_notify_stub.rs"]
mod phone_notify;
mod remote;
mod stream_ws;
mod video;

use remote::RemoteState;
use serde_json::{json, Value};
use state::AppState;
use std::sync::Arc;
use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::webview::{PageLoadEvent, Webview};
use tauri::{AppHandle, Emitter, EventTarget, LogicalSize, Manager, RunEvent, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

/// `--profile <file>` applies a saved profile at launch and `--connect <serial>` connects to a device.
/// Both go out as one command, so the connect uses the profile's settings.
fn launch_commands(args: &[String]) -> Vec<Value> {
    let mut profile = None;
    let mut connect = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--profile" => {
                let Some(path) = iter.next() else { continue };
                match std::fs::read_to_string(path)
                    .map_err(anyhow::Error::from)
                    .and_then(|text| Ok(serde_json::from_str::<Value>(&text)?))
                    .and_then(|value| another_core::profile::validate(&value))
                {
                    Ok(value) => profile = Some(value),
                    Err(e) => eprintln!("[launch] ignoring profile {}: {}", path, e),
                }
            }
            "--connect" => {
                if let Some(serial) = iter.next() {
                    connect = Some(serial.clone());
                }
            }
            _ => {}
        }
    }
    let command = match (profile, connect) {
        (Some(profile), connect) => json!({ "action": "apply", "profile": profile, "connect": connect }),
        (None, Some(serial)) => json!({ "action": "connect", "serial": serial }),
        (None, None) => return Vec::new(),
    };
    match remote::normalize_command(command) {
        Ok(command) => vec![command],
        Err(e) => {
            eprintln!("[launch] {}", e);
            Vec::new()
        }
    }
}

/// `another://connect?serial=X`, `another://set?native_video=true&connect=X` and
/// `another://apply?profile=<base64url JSON>&connect=X`, as one command so a connect uses the new settings.
fn deep_link_command(url: &tauri::Url) -> anyhow::Result<Value> {
    use base64::Engine;
    let pairs: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let connect = pairs.iter().find(|(k, _)| k == "connect" || k == "serial").map(|(_, v)| v.clone());
    let profile = match url.host_str().unwrap_or_default() {
        "connect" => return remote::normalize_command(json!({ "action": "connect", "serial": connect })),
        "set" => {
            let assignments = pairs.iter().filter(|(k, _)| k != "connect" && k != "serial");
            another_core::profile::from_assignments(assignments.map(|(k, v)| (k.as_str(), v.as_str())))?
        }
        "apply" => {
            let encoded = pairs
                .iter()
                .find(|(k, _)| k == "profile")
                .map(|(_, v)| v.clone())
                .ok_or_else(|| anyhow::anyhow!("another://apply needs a profile"))?;
            let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded.trim_end_matches('='))?;
            serde_json::from_slice(&bytes)?
        }
        other => return Err(anyhow::anyhow!("Unknown deep link action '{}'", other)),
    };
    let command = remote::normalize_command(json!({ "action": "apply", "profile": profile, "connect": connect }))?;
    if command["profile"].get("stream").is_none() && command["profile"].get("dev").is_none() {
        return match connect {
            Some(serial) => remote::normalize_command(json!({ "action": "connect", "serial": serial })),
            None => Err(anyhow::anyhow!("The link does not change anything")),
        };
    }
    Ok(command)
}

fn open_deep_links(app: &AppHandle, urls: &[tauri::Url]) {
    for url in urls {
        match deep_link_command(url) {
            Ok(command) => remote::dispatch(app, remote::ask_first(command)),
            Err(e) => eprintln!("[deep-link] {}: {}", url, e),
        }
    }
}

const MAIN_WINDOW: (f64, f64) = (1120.0, 760.0);
const MAIN_MIN: (f64, f64) = (720.0, 520.0);

/// A mirror window that reloads starts over with nothing connected, so the session it showed is
/// ended and its video layer removed; otherwise the last frame lingers. The main window never shows
/// a session, but keeps a size its layout fits in.
fn reset_after_page_load(webview: &Webview) {
    let label = webview.label().to_string();
    if label.starts_with(commands::MIRROR_LABEL_PREFIX) {
        native_video::detach(&label);
        video::set_record_feed(&label, false);
        let app = webview.app_handle().clone();
        let page = app.state::<AppState>().page_loaded(&label);
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            commands::end_session_before_page(&state, &label, page).await;
        });
        return;
    }
    let window = webview.window();
    let too_small = match (window.inner_size(), window.scale_factor()) {
        (Ok(size), Ok(scale)) => {
            let size = size.to_logical::<f64>(scale);
            size.width < MAIN_MIN.0 || size.height < MAIN_MIN.1
        }
        _ => false,
    };
    let _ = window.set_min_size(Some(LogicalSize::new(MAIN_MIN.0, MAIN_MIN.1)));
    if too_small {
        let _ = window.set_size(LogicalSize::new(MAIN_WINDOW.0, MAIN_WINDOW.1));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .manage(AppState::new())
        .manage(Arc::new(RemoteState::default()))
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                reset_after_page_load(webview);
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let remote_state = app.state::<Arc<RemoteState>>().inner().clone();
            remote::start(handle.clone(), remote_state);

            let args: Vec<String> = std::env::args().collect();
            for command in launch_commands(&args) {
                remote::dispatch(&handle, command);
            }

            let links = handle.clone();
            app.deep_link().on_open_url(move |event| open_deep_links(&links, &event.urls()));
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                open_deep_links(&handle, &urls);
            }

            if let Ok(dir) = app.path().resource_dir() {
                another_core::adb::set_resource_dir(dir);
            }

            let device_menu = SubmenuBuilder::new(app, "Device")
                .text("disconnect", "Disconnect")
                .separator()
                .text("home", "Home")
                .text("back", "Back")
                .text("recents", "Recents")
                .separator()
                .text("volume_up", "Volume Up")
                .text("volume_down", "Volume Down")
                .separator()
                .text("power", "Power")
                .build()?;

            let view_menu = SubmenuBuilder::new(app, "View")
                .text("always_on_top", "Always on Top")
                .separator()
                .text("screenshot", "Screenshot")
                .separator()
                .text("toggle_theme", "Toggle Theme")
                .text("settings", "Settings")
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&device_menu, &view_menu])
                .build()?;

            app.set_menu(menu)?;

            Ok(())
        })
        .on_menu_event(|app, event| {
            // Only the focused window acts, so Home reaches one phone rather than every mirror.
            let label = app
                .webview_windows()
                .into_values()
                .find(|window| window.is_focused().unwrap_or(false))
                .map_or_else(|| "main".to_string(), |window| window.label().to_string());
            let _ = app.emit_to(EventTarget::webview_window(label), "menu-event", event.id().0.as_str());
        })
        .on_window_event(|window, event| {
            let label = window.label().to_string();
            if !label.starts_with(commands::MIRROR_LABEL_PREFIX) {
                return;
            }
            let app = window.app_handle().clone();
            match event {
                WindowEvent::Focused(true) => {
                    tauri::async_runtime::spawn(async move {
                        let state = app.state::<AppState>();
                        let sessions = state.sessions.lock().await;
                        let mut focus = state.audio_focus.lock().await;
                        *focus = Some(label);
                        state::apply_audio_focus(&sessions, focus.as_deref());
                    });
                }
                WindowEvent::Destroyed => {
                    native_video::forget(&label);
                    video::set_record_feed(&label, false);
                    tauri::async_runtime::spawn(async move {
                        let state = app.state::<AppState>();
                        commands::end_session(&state, &label).await;
                        let _ = app.emit("mirror-closed", label);
                    });
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_devices,
            commands::connect_device,
            commands::disconnect_device,
            commands::send_touch,
            commands::send_key,
            commands::send_text,
            commands::send_scroll,
            commands::take_screenshot,
            commands::press_button,
            commands::rotate_device,
            commands::update_screen_size,
            commands::set_muted,
            commands::wake_screen,
            commands::play_macro,
            commands::get_default_macros_dir,
            commands::list_macro_files,
            commands::load_macro_file,
            commands::save_macro_file,
            commands::delete_macro_file,
            commands::rename_macro_file,
            commands::save_macros_order,
            commands::save_file,
            commands::save_bytes,
            commands::wifi_connect,
            commands::wifi_disconnect,
            commands::tailnet_status,
            commands::wifi_enable,
            commands::get_device_ip,
            commands::start_mcp_server,
            commands::stop_mcp_server,
            commands::get_mcp_status,
            commands::log_perf,
            commands::set_show_touches,
            commands::set_video_bit_rate,
            commands::set_video_size,
            commands::request_key_frame,
            commands::set_native_video_frame,
            commands::native_latency_probe,
            commands::report_ui_state,
            commands::take_pending_commands,
            commands::read_text_file,
            commands::device_screenshot,
            commands::adb_pair,
            commands::qr_pair_start,
            commands::qr_pair_wait,
            commands::qr_pair_cancel,
            commands::phone_notifications,
            commands::app_icons,
            commands::notify_phone,
            commands::open_phone_app,
            commands::set_stay_on,
            commands::list_files,
            commands::delete_file,
            commands::cli_status,
            commands::install_cli,
            commands::device_info,
            commands::device_facts,
            commands::open_mirror,
            commands::close_mirror,
            commands::send_files,
            commands::set_record_feed,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = &event {
                let state = app.state::<AppState>();
                let sessions = state.sessions.clone();
                let mcp = state.mcp.clone();
                let stay_on = state.stay_on.clone();
                tauri::async_runtime::block_on(async {
                    let ended: Vec<_> = sessions.lock().await.drain().map(|(_, session)| session).collect();
                    for session in ended {
                        session.shutdown.notify_one();
                        another_core::scrcpy::stop_server(&session.device_serial, session.port.port).await;
                    }
                    commands::restore_all_stay_on(&stay_on).await;
                    if let Some(ct) = mcp.lock().await.cancel.take() {
                        ct.cancel();
                    }
                    another_core::adb::kill_server().await;
                });
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn link(url: &str) -> anyhow::Result<Value> {
        deep_link_command(&tauri::Url::parse(url).unwrap())
    }

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn set_link_applies_settings_and_connects_in_one_command() {
        let command = link("another://set?native_video=true&max_size=1920&adaptive_network=false&connect=ABC").unwrap();
        assert_eq!(command["action"], "apply");
        assert_eq!(command["profile"]["dev"]["nativeVideo"], true);
        assert_eq!(command["profile"]["stream"]["max_size"], 1920);
        assert_eq!(command["profile"]["stream"]["adaptive_network"], false);
        assert_eq!(command["connect"], "ABC");
    }

    #[test]
    fn apply_link_decodes_a_base64url_profile() {
        let profile = json!({ "version": 1, "dev": { "encoderTuning": "intra_refresh" } });
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(profile.to_string());
        let command = link(&format!("another://apply?profile={}", encoded)).unwrap();
        assert_eq!(command["profile"]["dev"]["encoderTuning"], "intra_refresh");
        assert!(command.get("connect").is_none());
    }

    #[test]
    fn connect_link_and_bad_links() {
        assert_eq!(link("another://connect?serial=XYZ").unwrap(), json!({ "action": "connect", "serial": "XYZ" }));
        assert_eq!(link("another://set?connect=XYZ").unwrap(), json!({ "action": "connect", "serial": "XYZ" }));
        assert!(link("another://connect").is_err());
        assert!(link("another://connect?serial=").is_err());
        assert!(link("another://set").is_err());
        assert!(link("another://wipe").is_err());
        assert!(link("another://set?resolution=4k").is_err());
        assert!(link("another://apply").is_err());
    }

    #[test]
    fn links_always_ask_first() {
        let command = link("another://connect?serial=XYZ").unwrap();
        assert_eq!(remote::ask_first(command.clone()), json!({ "action": "link", "command": command }));
    }

    #[test]
    fn launch_flags_send_profile_and_device_together() {
        let path = std::env::temp_dir().join(format!("another-launch-{}.json", std::process::id()));
        std::fs::write(&path, r#"{ "version": 1, "stream": { "max_size": 1920 } }"#).unwrap();
        let commands = launch_commands(&args(&["Another", "--profile", path.to_str().unwrap(), "--connect", "SER"]));
        std::fs::remove_file(&path).unwrap();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0]["action"], "apply");
        assert_eq!(commands[0]["profile"]["stream"]["max_size"], 1920);
        assert_eq!(commands[0]["connect"], "SER");
    }

    #[test]
    fn launch_flags_skip_unreadable_profiles() {
        let commands = launch_commands(&args(&["Another", "--profile", "/nonexistent/profile.json", "--connect", "SER"]));
        assert_eq!(commands, vec![json!({ "action": "connect", "serial": "SER" })]);
        assert!(launch_commands(&args(&["Another"])).is_empty());
    }
}
