use anyhow::Result;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

pub fn show(app: &AppHandle, title: &str, subtitle: &str, body: &str, _package: &str, _icon: Option<&str>) -> Result<()> {
    app.notification()
        .builder()
        .title(format!("{subtitle} · {title}"))
        .body(body)
        .show()?;
    Ok(())
}
