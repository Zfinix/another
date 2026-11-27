mod audio;
mod commands;
mod state;
#[cfg(target_os = "macos")]
mod native_video;
#[cfg(target_os = "macos")]
mod window_blur;
#[cfg(not(target_os = "macos"))]
#[path = "window_blur_stub.rs"]
mod window_blur;
#[cfg(not(target_os = "macos"))]
#[path = "native_video_stub.rs"]
mod native_video;
mod remote;
mod stream_ws;
mod video;

use remote::RemoteState;
use serde_json::{json, Value};
use state::AppState;
use std::sync::Arc;
use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_plugin_deep_link::DeepLinkExt;

/// `--profile <file>` applies a saved profile at launch and `--connect <serial>` connects to a device.
fn launch_commands(args: &[String]) -> Vec<Value> {
    let mut commands = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--profile" => {
                let Some(path) = iter.next() else { continue };
                match std::fs::read_to_string(path)
                    .map_err(anyhow::Error::from)
                    .and_then(|text| Ok(serde_json::from_str::<Value>(&text)?))
                    .and_then(|profile| remote::normalize_command(json!({ "action": "apply", "profile": profile })))
                {
                    Ok(command) => commands.push(command),
                    Err(e) => eprintln!("[launch] ignoring profile {}: {}", path, e),
                }
            }
            "--connect" => {
                if let Some(serial) = iter.next() {
                    commands.push(json!({ "action": "connect", "serial": serial }));
                }
            }
            _ => {}
        }
    }
    commands
}

/// `another://connect?serial=X`, `another://set?native_video=true&connect=X` and
/// `another://apply?profile=<base64url JSON>&connect=X`.
fn deep_link_commands(url: &tauri::Url) -> anyhow::Result<Vec<Value>> {
    use base64::Engine;
    let pairs: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let connect = pairs.iter().find(|(k, _)| k == "connect" || k == "serial").map(|(_, v)| v.clone());
    let action = url.host_str().unwrap_or_default();
    let mut commands = Vec::new();
    match action {
        "connect" => {}
        "set" => {
            let assignments = pairs.iter().filter(|(k, _)| k != "connect" && k != "serial");
            let profile = another_core::profile::from_assignments(assignments.map(|(k, v)| (k.as_str(), v.as_str())))?;
            commands.push(json!({ "action": "apply", "profile": profile }));
        }
        "apply" => {
            let encoded = pairs
                .iter()
                .find(|(k, _)| k == "profile")
                .map(|(_, v)| v.clone())
                .ok_or_else(|| anyhow::anyhow!("another://apply needs a profile"))?;
            let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded.trim_end_matches('='))?;
            let profile: Value = serde_json::from_slice(&bytes)?;
            commands.push(remote::normalize_command(json!({ "action": "apply", "profile": profile }))?);
        }
        other => return Err(anyhow::anyhow!("Unknown deep link action '{}'", other)),
    }
    if let Some(serial) = connect {
        commands.push(json!({ "action": "connect", "serial": serial }));
    }
    Ok(commands)
}

fn open_deep_links(app: &AppHandle, urls: &[tauri::Url]) {
    for url in urls {
        match deep_link_commands(url) {
            Ok(commands) => commands.into_iter().for_each(|command| remote::dispatch(app, command)),
            Err(e) => eprintln!("[deep-link] {}: {}", url, e),
        }
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
            let _ = app.emit("menu-event", event.id().0.as_str());
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
            commands::open_phone_app,
            commands::set_stay_on,
            commands::list_files,
            commands::delete_file,
            commands::cli_status,
            commands::install_cli,
            commands::set_window_blur,
            commands::device_info,
            commands::device_facts,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = &event {
                let state = app.state::<AppState>();
                let session = state.session.clone();
                let mcp = state.mcp.clone();
                tauri::async_runtime::block_on(async {
                    if let Some(s) = session.lock().await.take() {
                        s.shutdown.notify_one();
                        another_core::scrcpy::stop_server(&s.device_serial, 27183).await;
                    }
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

    fn link(url: &str) -> anyhow::Result<Vec<Value>> {
        deep_link_commands(&tauri::Url::parse(url).unwrap())
    }

    #[test]
    fn set_link_applies_settings_then_connects() {
        let commands = link("another://set?native_video=true&max_size=1920&connect=ABC").unwrap();
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0]["action"], "apply");
        assert_eq!(commands[0]["profile"]["dev"]["nativeVideo"], true);
        assert_eq!(commands[0]["profile"]["stream"]["max_size"], 1920);
        assert_eq!(commands[1], json!({ "action": "connect", "serial": "ABC" }));
    }

    #[test]
    fn apply_link_decodes_a_base64url_profile() {
        let profile = json!({ "version": 1, "dev": { "encoderTuning": "intra_refresh" } });
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(profile.to_string());
        let commands = link(&format!("another://apply?profile={}", encoded)).unwrap();
        assert_eq!(commands[0]["profile"]["dev"]["encoderTuning"], "intra_refresh");
    }

    #[test]
    fn connect_link_and_bad_links() {
        assert_eq!(link("another://connect?serial=XYZ").unwrap(), vec![json!({ "action": "connect", "serial": "XYZ" })]);
        assert!(link("another://wipe").is_err());
        assert!(link("another://set?resolution=4k").is_err());
        assert!(link("another://apply").is_err());
    }

    #[test]
    fn launch_flags_queue_connect_and_skip_unreadable_profiles() {
        let args: Vec<String> = ["Another", "--profile", "/nonexistent/profile.json", "--connect", "SER"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(launch_commands(&args), vec![json!({ "action": "connect", "serial": "SER" })]);
    }
}
