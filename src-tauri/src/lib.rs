mod audio;
mod commands;
mod state;
mod video;

use state::AppState;
use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new())
        .setup(|app| {
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
            commands::wifi_enable,
            commands::get_device_ip,
            commands::start_mcp_server,
            commands::stop_mcp_server,
            commands::get_mcp_status,
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
