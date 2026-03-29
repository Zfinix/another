mod adb;
mod audio;
mod commands;
mod control;
mod scrcpy;
mod state;
mod video;

use state::AppState;
use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .setup(|app| {
            if let Ok(dir) = app.path().resource_dir() {
                adb::set_resource_dir(dir);
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
            commands::set_muted,
            commands::wifi_connect,
            commands::wifi_disconnect,
            commands::wifi_enable,
            commands::get_device_ip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
