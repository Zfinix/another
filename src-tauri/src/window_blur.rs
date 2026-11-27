//! Adjustable blur behind the window on macOS, through the private CoreGraphics call
//! `CGSSetWindowBackgroundBlurRadius` that iTerm2 also uses. AppKit only offers fixed materials.

use anyhow::{anyhow, Result};
use objc2::msg_send;
use objc2::runtime::AnyObject;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::sync::OnceLock;
use tauri::WebviewWindow;

type SetBlurRadius = unsafe extern "C" fn(u32, u32, u32) -> i32;
type DefaultConnection = unsafe extern "C" fn() -> u32;

const RTLD_LAZY: c_int = 0x1;
const FRAMEWORK: &CStr = c"/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices";
const MAX_RADIUS: u32 = 64;
/// A radius of 0 can switch the blur off for good on some macOS versions, so the lowest is 1.
const MIN_RADIUS: u32 = 1;

extern "C" {
    fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

struct Functions {
    set_blur: SetBlurRadius,
    connection: DefaultConnection,
}

fn functions() -> Option<&'static Functions> {
    static FUNCTIONS: OnceLock<Option<Functions>> = OnceLock::new();
    FUNCTIONS
        .get_or_init(|| unsafe {
            let handle = dlopen(FRAMEWORK.as_ptr(), RTLD_LAZY);
            if handle.is_null() {
                return None;
            }
            let set_blur = dlsym(handle, c"CGSSetWindowBackgroundBlurRadius".as_ptr());
            let connection = dlsym(handle, c"CGSDefaultConnectionForThread".as_ptr());
            if set_blur.is_null() || connection.is_null() {
                return None;
            }
            Some(Functions {
                set_blur: std::mem::transmute::<*mut c_void, SetBlurRadius>(set_blur),
                connection: std::mem::transmute::<*mut c_void, DefaultConnection>(connection),
            })
        })
        .as_ref()
}

/// Maps 0 to 100 percent onto the blur radius macOS accepts.
pub fn radius_for(percent: u32) -> u32 {
    let percent = percent.min(100);
    (percent * MAX_RADIUS / 100).max(MIN_RADIUS)
}

pub async fn set_blur(window: &WebviewWindow, percent: u32) -> Result<()> {
    let functions = functions().ok_or_else(|| anyhow!("This macOS version does not allow a custom window blur"))?;
    let ns_window = window.ns_window().map_err(|e| anyhow!("No native window: {}", e))? as usize;
    let radius = radius_for(percent);
    let set_blur = functions.set_blur;
    let connection = functions.connection;
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let result = unsafe {
                let ns_window = ns_window as *mut AnyObject;
                match ns_window.as_ref() {
                    Some(win) => {
                        let number: isize = msg_send![win, windowNumber];
                        set_blur(connection(), number as u32, radius)
                    }
                    None => -1,
                }
            };
            let _ = tx.send(result);
        })
        .map_err(|e| anyhow!("Could not reach the main thread: {}", e))?;
    match rx.await {
        Ok(0) => Ok(()),
        Ok(code) => Err(anyhow!("macOS refused the blur radius ({})", code)),
        Err(_) => Err(anyhow!("The blur was not applied")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn radius_for_never_returns_zero() {
        assert_eq!(radius_for(0), MIN_RADIUS);
    }

    #[test]
    fn radius_for_scales_and_clamps_percent() {
        assert_eq!(radius_for(50), 32);
        assert_eq!(radius_for(100), MAX_RADIUS);
        assert_eq!(radius_for(250), MAX_RADIUS);
    }
}
