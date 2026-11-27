use anyhow::Result;
use tauri::WebviewWindow;

pub fn set_blur(_window: &WebviewWindow, _percent: u32) -> Result<()> {
    Ok(())
}
