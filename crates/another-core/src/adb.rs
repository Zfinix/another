use anyhow::{anyhow, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tokio::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();
static REFRESH_RATES: OnceLock<Mutex<HashMap<String, f32>>> = OnceLock::new();

const REFRESH_RATE_KEYS: [&str; 4] = ["fps=", "renderFrameRate ", "refreshRate=", "refreshRate "];

pub fn set_resource_dir(path: PathBuf) {
    let _ = RESOURCE_DIR.set(path);
}

#[derive(Debug, Clone, Serialize)]
pub struct Device {
    pub serial: String,
    pub model: String,
    pub state: String,
}

fn adb_binary_name() -> &'static str {
    if cfg!(windows) { "adb.exe" } else { "adb" }
}

fn adb_path() -> PathBuf {
    let binary = adb_binary_name();

    if let Ok(home) = std::env::var("HOME") {
        let sdk_adb = PathBuf::from(&home).join("Library/Android/sdk/platform-tools").join(binary);
        if sdk_adb.exists() {
            return sdk_adb;
        }
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let sdk_adb = PathBuf::from(&local_app_data).join("Android/Sdk/platform-tools").join(binary);
        if sdk_adb.exists() {
            return sdk_adb;
        }
    }
    if let Ok(android_home) = std::env::var("ANDROID_HOME") {
        let sdk_adb = PathBuf::from(&android_home).join("platform-tools").join(binary);
        if sdk_adb.exists() {
            return sdk_adb;
        }
    }
    if let Some(dir) = RESOURCE_DIR.get() {
        let bundled = dir.join("resources").join(binary);
        if bundled.exists() {
            return bundled;
        }
    }
    PathBuf::from(binary)
}

fn adb_command() -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = Command::new(adb_path());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

async fn run_adb(args: &[&str]) -> Result<Vec<u8>> {
    let output = adb_command()
        .args(args)
        .output()
        .await
        .map_err(|e| anyhow!("Failed to run adb: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("adb {} failed: {}", args.join(" "), stderr));
    }
    Ok(output.stdout)
}

async fn run_adb_text(args: &[&str]) -> Result<String> {
    let stdout = run_adb(args).await?;
    Ok(String::from_utf8_lossy(&stdout).to_string())
}

pub async fn list_devices() -> Result<Vec<Device>> {
    let output = run_adb_text(&["devices", "-l"]).await?;
    let mut devices = Vec::new();

    for line in output.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }
        let serial = parts[0].to_string();
        let state = parts[1].to_string();
        let model = parts
            .iter()
            .find(|p| p.starts_with("model:"))
            .map(|p| p.trim_start_matches("model:").to_string())
            .unwrap_or_else(|| serial.clone());

        devices.push(Device {
            serial,
            model,
            state,
        });
    }
    Ok(devices)
}

pub async fn push_file(serial: &str, local: &str, remote: &str) -> Result<()> {
    run_adb(&["-s", serial, "push", local, remote]).await?;
    Ok(())
}

pub async fn forward_port(serial: &str, local_port: u16, remote: &str) -> Result<()> {
    run_adb(&[
        "-s",
        serial,
        "forward",
        &format!("tcp:{}", local_port),
        remote,
    ])
    .await?;
    Ok(())
}

pub async fn remove_forward(serial: &str, local_port: u16) -> Result<()> {
    let _ = run_adb(&[
        "-s",
        serial,
        "forward",
        "--remove",
        &format!("tcp:{}", local_port),
    ])
    .await;
    Ok(())
}

pub async fn shell(serial: &str, cmd: &str) -> Result<tokio::process::Child> {
    let child = adb_command()
        .args(["-s", serial, "shell", cmd])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| anyhow!("Failed to spawn adb shell: {}", e))?;
    Ok(child)
}

pub async fn shell_text(serial: &str, cmd: &str) -> Result<String> {
    run_adb_text(&["-s", serial, "shell", cmd]).await
}

pub async fn reverse(serial: &str, remote: &str, local_port: u16) -> Result<()> {
    run_adb(&[
        "-s",
        serial,
        "reverse",
        remote,
        &format!("tcp:{}", local_port),
    ])
    .await?;
    Ok(())
}

pub async fn remove_reverse(serial: &str, remote: &str) -> Result<()> {
    let _ = run_adb(&["-s", serial, "reverse", "--remove", remote]).await;
    Ok(())
}

/// Kills both the scrcpy server and the Another server. The brackets keep the pattern from matching the shell that
/// runs it.
pub const KILL_SERVERS_CMD: &str = "pkill -f '[c]om.genymobile.scrcpy.Server|[d]ev.another.server.Main'";

pub async fn kill_mirror_servers(serial: &str) {
    let _ = run_adb(&["-s", serial, "shell", KILL_SERVERS_CMD]).await;
    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
}

pub async fn exec_out_screencap(serial: &str) -> Result<Vec<u8>> {
    run_adb(&["-s", serial, "exec-out", "screencap", "-p"]).await
}

pub async fn dump_ui_hierarchy(serial: &str) -> Result<String> {
    let output =
        run_adb_text(&["-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"]).await?;

    if let Some(end) = output.rfind("</hierarchy>") {
        let xml = &output[..end + "</hierarchy>".len()];
        if let Some(start) = xml.find('<') {
            return Ok(xml[start..].to_string());
        }
    }

    Err(anyhow!("Failed to parse UI hierarchy output"))
}

pub async fn kill_server() {
    let mut cmd = Command::new(adb_path());
    cmd.args(["kill-server"]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let _ = cmd.output().await;
}

pub async fn connect_device(address: &str) -> Result<()> {
    let output = run_adb_text(&["connect", address]).await?;
    if output.contains("connected") || output.contains("already connected") {
        Ok(())
    } else {
        Err(anyhow!("Failed to connect: {}", output.trim()))
    }
}

/// Pairs with a phone's Wireless debugging pairing code (Android 11 and up).
pub async fn pair(address: &str, code: &str) -> Result<()> {
    let output = run_adb_text(&["pair", address, code]).await?;
    if output.contains("Successfully paired") {
        Ok(())
    } else {
        Err(anyhow!("{}", output.trim()))
    }
}

pub async fn notifications(serial: &str) -> Result<Vec<crate::notifications::PhoneNotification>> {
    let output = run_adb_text(&["-s", serial, "shell", "dumpsys", "notification", "--noredact"]).await?;
    Ok(crate::notifications::parse_dumpsys(&output))
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct DeviceInfo {
    pub manufacturer: String,
    pub model: String,
    pub market_name: String,
    pub android_version: String,
    pub avd_name: String,
    pub avd_device: String,
    pub avd_manufacturer: String,
}

const INFO_PROPS: [&str; 5] = [
    "ro.product.manufacturer",
    "ro.product.model",
    "ro.product.marketname",
    "ro.product.vendor.marketname",
    "ro.build.version.release",
];

const KEYCODE_WAKEUP: &str = "224";
const KEYCODE_SLEEP: &str = "223";
const WAKE_SETTLE: std::time::Duration = std::time::Duration::from_millis(900);

async fn screen_awake(serial: &str) -> Result<bool> {
    Ok(shell_text(serial, "dumpsys power").await?.contains("mWakefulness=Awake"))
}

async fn keyguard_showing(serial: &str) -> Result<bool> {
    let window = shell_text(serial, "dumpsys window").await?;
    Ok(window.contains("isKeyguardShowing=true") || window.contains("mShowingLockscreen=true"))
}

/// A screenshot of the lock screen, or `None` when the phone is unlocked and in use, or has no
/// lock screen. A sleeping phone is woken just long enough for the capture, then put back to sleep.
pub async fn lock_screen_capture(serial: &str) -> Result<Option<Vec<u8>>> {
    if screen_awake(serial).await? {
        if keyguard_showing(serial).await? {
            return exec_out_screencap(serial).await.map(Some);
        }
        return Ok(None);
    }
    let capture = async {
        run_adb(&["-s", serial, "shell", "input", "keyevent", KEYCODE_WAKEUP]).await?;
        tokio::time::sleep(WAKE_SETTLE).await;
        if keyguard_showing(serial).await? {
            exec_out_screencap(serial).await.map(Some)
        } else {
            Ok(None)
        }
    }
    .await;
    let slept = run_adb(&["-s", serial, "shell", "input", "keyevent", KEYCODE_SLEEP]).await;
    let capture = capture?;
    slept?;
    Ok(capture)
}

/// Who made the phone and what it is called, read in one round trip. Emulators also report the
/// device profile from their AVD config, such as `pixel_8`.
pub async fn device_info(serial: &str) -> Result<DeviceInfo> {
    let command = INFO_PROPS.iter().map(|p| format!("echo \"$(getprop {p})\"")).collect::<Vec<_>>().join(";");
    let output = shell_text(serial, &command).await?;
    let mut values = output.lines().map(|l| l.trim().to_string());
    let mut next = || values.next().unwrap_or_default();
    let manufacturer = next();
    let model = next();
    let market_name = next();
    let vendor_market_name = next();
    let mut info = DeviceInfo {
        manufacturer,
        model,
        market_name: if market_name.is_empty() { vendor_market_name } else { market_name },
        android_version: next(),
        ..DeviceInfo::default()
    };
    if serial.starts_with("emulator-") {
        if let Ok(name) = emulator_avd_name(serial).await {
            if let Some((device, maker)) = avd_profile(&name) {
                info.avd_device = device;
                info.avd_manufacturer = maker;
            }
            info.avd_name = name;
        }
    }
    Ok(info)
}

fn avd_home() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("ANDROID_AVD_HOME") {
        return Some(PathBuf::from(dir));
    }
    if let Ok(dir) = std::env::var("ANDROID_USER_HOME") {
        return Some(PathBuf::from(dir).join("avd"));
    }
    std::env::var("HOME").ok().map(|home| PathBuf::from(home).join(".android").join("avd"))
}

/// Reads `hw.device.name` and `hw.device.manufacturer` from an AVD's config.ini.
pub fn avd_profile(avd_name: &str) -> Option<(String, String)> {
    let config = std::fs::read_to_string(avd_home()?.join(format!("{avd_name}.avd")).join("config.ini")).ok()?;
    let value = |key: &str| {
        config
            .lines()
            .find_map(|line| line.strip_prefix(key).and_then(|rest| rest.trim_start().strip_prefix('=')))
            .map(|v| v.trim().to_string())
    };
    Some((value("hw.device.name")?, value("hw.device.manufacturer").unwrap_or_default()))
}

/// The AVD name of an emulator, such as `Pixel_9_API_36`.
pub async fn emulator_avd_name(serial: &str) -> Result<String> {
    let output = run_adb_text(&["-s", serial, "emu", "avd", "name"]).await?;
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && *line != "OK")
        .map(str::to_string)
        .ok_or_else(|| anyhow!("The emulator did not report its name"))
}

pub async fn launch_app(serial: &str, package: &str) -> Result<()> {
    run_adb(&["-s", serial, "shell", "monkey", "-p", package, "-c", "android.intent.category.LAUNCHER", "1"]).await?;
    Ok(())
}

/// Sets `stay_on_while_plugged_in` and returns the value it replaced, so the caller can restore it.
pub async fn set_stay_on(serial: &str, value: &str) -> Result<String> {
    let previous = run_adb_text(&["-s", serial, "shell", "settings", "get", "global", "stay_on_while_plugged_in"]).await?;
    run_adb(&["-s", serial, "shell", "settings", "put", "global", "stay_on_while_plugged_in", value]).await?;
    Ok(previous.trim().to_string())
}

pub async fn tcpip(serial: &str, port: u16) -> Result<()> {
    run_adb(&["-s", serial, "tcpip", &port.to_string()]).await?;
    Ok(())
}

pub async fn disconnect_device(address: &str) -> Result<()> {
    run_adb(&["disconnect", address]).await?;
    Ok(())
}

pub async fn get_device_ip(serial: &str) -> Result<Option<String>> {
    if let Ok(output) = run_adb_text(&["-s", serial, "shell", "ip", "route"]).await {
        for line in output.lines() {
            if line.contains("wlan") {
                if let Some(idx) = line.find("src ") {
                    if let Some(ip) = line[idx + 4..].split_whitespace().next() {
                        return Ok(Some(ip.to_string()));
                    }
                }
            }
        }
    }

    if let Ok(output) = run_adb_text(&[
        "-s", serial, "shell", "ip", "-f", "inet", "addr", "show", "wlan0",
    ])
    .await
    {
        for line in output.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("inet ") {
                if let Some(ip) = rest.split('/').next() {
                    return Ok(Some(ip.to_string()));
                }
            }
        }
    }

    Ok(None)
}

pub fn parse_peak_refresh_rate(dumpsys_display: &str) -> Option<f32> {
    let mut peak: Option<f32> = None;
    for key in REFRESH_RATE_KEYS {
        for (idx, _) in dumpsys_display.match_indices(key) {
            let rest = &dumpsys_display[idx + key.len()..];
            let end = rest
                .find(|c: char| !(c.is_ascii_digit() || c == '.'))
                .unwrap_or(rest.len());
            if let Ok(rate) = rest[..end].parse::<f32>() {
                if rate > 0.0 && peak.is_none_or(|p| rate > p) {
                    peak = Some(rate);
                }
            }
        }
    }
    peak
}

pub async fn peak_refresh_rate(serial: &str) -> Option<f32> {
    let cache = REFRESH_RATES.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(rate) = cache.lock().ok()?.get(serial) {
        return Some(*rate);
    }
    let output = run_adb_text(&["-s", serial, "shell", "dumpsys", "display"]).await.ok()?;
    let rate = parse_peak_refresh_rate(&output)?;
    cache.lock().ok()?.insert(serial.to_string(), rate);
    Some(rate)
}

#[cfg(test)]
mod tests {
    use super::parse_peak_refresh_rate;

    #[test]
    fn picks_the_highest_supported_mode() {
        let dump = "DisplayModeRecord{mMode={id=1, width=1080, height=2400, fps=60.0}}\n\
                    DisplayModeRecord{mMode={id=2, width=1080, height=2400, fps=120.00001}}";
        assert_eq!(parse_peak_refresh_rate(dump).map(f32::round), Some(120.0));
    }

    #[test]
    fn reads_render_frame_rate_and_older_fields() {
        assert_eq!(parse_peak_refresh_rate("renderFrameRate 90.0"), Some(90.0));
        assert_eq!(parse_peak_refresh_rate("mRefreshRate=60.0 refreshRate=60.0"), Some(60.0));
    }

    #[test]
    fn unknown_output_gives_none() {
        assert_eq!(parse_peak_refresh_rate("Display Devices: size=1"), None);
    }
}
