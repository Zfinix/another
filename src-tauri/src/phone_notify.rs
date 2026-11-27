use anyhow::{anyhow, Result};
use base64::Engine;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::sel;
use std::path::{Path, PathBuf};
use std::sync::Once;
use tauri::{AppHandle, Manager};

static PRESENT_IN_FRONT: Once = Once::new();

unsafe extern "C-unwind" fn should_present(_: *mut AnyObject, _: Sel, _: *mut AnyObject, _: *mut AnyObject) -> Bool {
    Bool::YES
}

/// mac-notification-sys's delegate leaves out `shouldPresentNotification:`, so macOS hides banners while
/// Another is the frontmost app. Adding it keeps phone notifications visible while you mirror.
fn present_in_front() {
    PRESENT_IN_FRONT.call_once(|| {
        let Some(class) = AnyClass::get(c"NotificationCenterDelegate") else {
            return;
        };
        unsafe {
            let imp: Imp = std::mem::transmute(
                should_present as unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject) -> Bool,
            );
            objc2::ffi::class_addMethod(
                class as *const AnyClass as *mut AnyClass,
                sel!(userNotificationCenter:shouldPresentNotification:),
                imp,
                c"B@:@@".as_ptr(),
            );
        }
    });
}

/// Shows a phone notification as a native macOS notification, with the phone app's own icon on the left.
pub fn show(app: &AppHandle, title: &str, subtitle: &str, body: &str, package: &str, icon: Option<&str>) -> Result<()> {
    let bundle = if tauri::is_dev() { "com.apple.Terminal".to_string() } else { app.config().identifier.clone() };
    let _ = mac_notification_sys::set_application(&bundle);
    present_in_front();

    let icon_path = icon.and_then(|png| cached_icon(app, package, png).ok());
    let icon_path = icon_path.as_deref().and_then(Path::to_str);

    let mut notification = mac_notification_sys::Notification::new();
    notification.title(title).subtitle(subtitle).message(body).asynchronous(true);
    if let Some(path) = icon_path {
        notification.app_icon(path);
    }
    notification.send().map(|_| ()).map_err(|e| anyhow!("{e}"))
}

fn cached_icon(app: &AppHandle, package: &str, png: &str) -> Result<PathBuf> {
    let dir = app.path().app_cache_dir()?.join("app-icons");
    let path = dir.join(format!("{package}.png"));
    if !path.exists() {
        std::fs::create_dir_all(&dir)?;
        std::fs::write(&path, base64::engine::general_purpose::STANDARD.decode(png)?)?;
    }
    Ok(path)
}
