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
    #[cfg_attr(target_os = "macos", expect(unused_mut))]
    let mut cmd = Command::new(adb_path());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    // macOS discovers phones through Bonjour; elsewhere adb needs its own mDNS backend for QR pairing.
    #[cfg(not(target_os = "macos"))]
    cmd.env("ADB_MDNS_OPENSCREEN", "1");
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
        let stdout = String::from_utf8_lossy(&output.stdout);
        eprintln!("[adb] {} failed: {}", args.join(" "), stderr.trim());
        return Err(anyhow!("{}", failure_reason(&stderr, &stdout)));
    }
    Ok(output.stdout)
}

/// The one line of adb output that says what went wrong, without the `adb: error:` prefixes.
fn failure_reason(stderr: &str, stdout: &str) -> String {
    let line = stderr
        .lines()
        .chain(stdout.lines())
        .map(str::trim)
        .find(|line| line.contains("Failure [") || line.contains("error"))
        .or_else(|| stderr.lines().chain(stdout.lines()).map(str::trim).find(|line| !line.is_empty()))
        .unwrap_or("adb stopped unexpectedly");
    let mut reason = line;
    for prefix in ["adb: error:", "adb:", "error:"] {
        if let Some(rest) = reason.strip_prefix(prefix) {
            reason = rest.trim();
        }
    }
    reason.to_string()
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

pub const DOWNLOADS_DIR: &str = "/sdcard/Download/";

pub async fn install_apk(serial: &str, path: &str) -> Result<()> {
    run_adb(&["-s", serial, "install", "-r", "-t", path]).await.map_err(|e| {
        let msg = e.to_string();
        match msg.find("Failure [") {
            Some(at) => anyhow!("{}", msg[at..].trim_end()),
            None => e,
        }
    })?;
    Ok(())
}

/// Pushes every path in one adb call, then asks the media scanner to index them so they show up in Files and Photos.
pub async fn push_to_downloads(serial: &str, paths: &[String]) -> Result<()> {
    let mut args = vec!["-s", serial, "push"];
    args.extend(paths.iter().map(String::as_str));
    args.push(DOWNLOADS_DIR);
    run_adb(&args).await?;

    let scans: Vec<String> = paths
        .iter()
        .filter_map(|p| std::path::Path::new(p).file_name()?.to_str())
        .map(|name| {
            let uri = format!("file://{DOWNLOADS_DIR}{name}").replace('\'', "'\\''");
            format!("am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d '{uri}' >/dev/null")
        })
        .collect();
    if !scans.is_empty() {
        let _ = run_adb(&["-s", serial, "shell", &scans.join("; ")]).await;
    }
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

pub async fn kill_scrcpy_server(serial: &str) {
    let _ = run_adb(&[
        "-s",
        serial,
        "shell",
        "pkill -f com.genymobile.scrcpy.Server",
    ])
    .await;
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
        eprintln!("[adb] connect {} failed: {}", address, output.trim());
        Err(anyhow!("{}", failure_reason("", &output)))
    }
}

/// Pairs with a phone's Wireless debugging pairing code (Android 11 and up).
pub async fn pair(address: &str, code: &str) -> Result<()> {
    let output = run_adb_text(&["pair", address, code]).await?;
    if output.contains("Successfully paired") {
        Ok(())
    } else {
        eprintln!("[adb] pair {} failed: {}", address, output.trim());
        Err(anyhow!("Pairing failed: {}", failure_reason("", &output)))
    }
}

pub const PAIRING_SERVICE: &str = "_adb-tls-pairing._tcp";
pub const CONNECT_SERVICE: &str = "_adb-tls-connect._tcp";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MdnsService {
    pub name: String,
    pub kind: String,
    pub address: String,
}

impl MdnsService {
    pub fn host(&self) -> &str {
        self.address.rsplit_once(':').map_or(self.address.as_str(), |(host, _)| host)
    }
}

/// The text a phone scans from Wireless debugging, Pair device with QR code. The phone then
/// advertises a pairing service named `name` that accepts `password`.
pub fn pairing_qr_payload(name: &str, password: &str) -> String {
    format!("WIFI:T:ADB;S:{};P:{};;", name, password)
}

/// Parses `adb mdns services`: one `name  type  host:port` line per service.
pub fn parse_mdns_services(output: &str) -> Vec<MdnsService> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let (name, kind, address) = (parts.next()?, parts.next()?, parts.next()?);
            let kind = kind.trim_end_matches('.');
            kind.starts_with("_adb").then(|| MdnsService {
                name: name.to_string(),
                kind: kind.to_string(),
                address: address.to_string(),
            })
        })
        .collect()
}

pub async fn mdns_services() -> Result<Vec<MdnsService>> {
    Ok(parse_mdns_services(&run_adb_text(&["mdns", "services"]).await?))
}

pub async fn notifications(serial: &str) -> Result<Vec<crate::notifications::PhoneNotification>> {
    let output = run_adb_text(&["-s", serial, "shell", "dumpsys", "notification", "--noredact"]).await?;
    Ok(crate::notifications::parse_dumpsys(&output))
}

const ICON_SERVER_REMOTE_PATH: &str = "/data/local/tmp/another-icons.jar";
const ICON_SERVER_MAIN: &str = "dev.another.server.AppIcons";

fn is_package_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
}

/// Reads each app's launcher icon from the phone through the Another server, as base64 PNG keyed by package.
pub async fn app_icons(serial: &str, packages: &[String]) -> Result<HashMap<String, String>> {
    let packages: Vec<&str> = packages.iter().map(String::as_str).filter(|p| is_package_name(p)).collect();
    if packages.is_empty() {
        return Ok(HashMap::new());
    }
    let server = RESOURCE_DIR
        .get()
        .map(|dir| dir.join("resources").join(crate::scrcpy::ANOTHER_SERVER_FILE))
        .filter(|path| path.exists())
        .ok_or_else(|| anyhow!("The Another server is missing from this build"))?;
    push_file(serial, &server.to_string_lossy(), ICON_SERVER_REMOTE_PATH).await?;
    let command = format!(
        "CLASSPATH={ICON_SERVER_REMOTE_PATH} app_process / {ICON_SERVER_MAIN} {}",
        packages.join(" ")
    );
    let output = run_adb_text(&["-s", serial, "shell", &command]).await?;
    Ok(parse_app_icons(&output))
}

fn parse_app_icons(output: &str) -> HashMap<String, String> {
    output
        .lines()
        .filter_map(|line| line.trim().split_once(' '))
        .filter(|(pkg, png)| is_package_name(pkg) && !png.is_empty() && !png.contains(' '))
        .map(|(pkg, png)| (pkg.to_string(), png.to_string()))
        .collect()
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
    run_adb(&["-s", serial, "shell", "input", "keyevent", KEYCODE_WAKEUP]).await?;
    tokio::time::sleep(WAKE_SETTLE).await;
    let capture = if keyguard_showing(serial).await? {
        exec_out_screencap(serial).await.map(Some)
    } else {
        Ok(None)
    };
    run_adb(&["-s", serial, "shell", "input", "keyevent", KEYCODE_SLEEP]).await?;
    capture
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

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct DeviceFacts {
    pub battery_percent: Option<u32>,
    pub charging: bool,
    pub battery_full: bool,
    pub storage_total_kb: Option<u64>,
    pub storage_free_kb: Option<u64>,
    pub memory_kb: Option<u64>,
    pub screen_width: Option<u32>,
    pub screen_height: Option<u32>,
    pub refresh_hz: Option<u32>,
}

const FACTS_COMMAND: &str =
    "echo @battery; dumpsys battery; echo @storage; df -k /data; echo @memory; cat /proc/meminfo; echo @display; wm size";
const BATTERY_STATUS_CHARGING: &str = "2";
const BATTERY_STATUS_FULL: &str = "5";

fn sections(output: &str) -> HashMap<&str, Vec<&str>> {
    let mut found: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut current = "";
    for line in output.lines() {
        if let Some(name) = line.strip_prefix('@') {
            current = name.trim();
        } else if !line.trim().is_empty() {
            found.entry(current).or_default().push(line.trim());
        }
    }
    found
}

fn field<'a>(lines: &[&'a str], key: &str) -> Option<&'a str> {
    lines.iter().find_map(|line| line.strip_prefix(key)?.strip_prefix(':').map(str::trim))
}

/// Parses the output of [`FACTS_COMMAND`]. Missing or unreadable sections stay `None`.
pub fn parse_device_facts(output: &str) -> DeviceFacts {
    let sections = sections(output);
    let empty = Vec::new();
    let section = |name: &str| sections.get(name).unwrap_or(&empty);
    let mut facts = DeviceFacts::default();

    let battery = section("battery");
    let level: Option<u32> = field(battery, "level").and_then(|v| v.parse().ok());
    let scale: u32 = field(battery, "scale").and_then(|v| v.parse().ok()).filter(|s| *s > 0).unwrap_or(100);
    facts.battery_percent = level.map(|l| (l * 100 / scale).min(100));
    let status = field(battery, "status");
    facts.charging = status == Some(BATTERY_STATUS_CHARGING);
    facts.battery_full = status == Some(BATTERY_STATUS_FULL);

    // df wraps long filesystem names onto their own line, so the numbers are read from the end.
    if let Some(last) = section("storage").last() {
        let columns: Vec<&str> = last.split_whitespace().collect();
        if columns.len() >= 5 {
            let at = |back: usize| columns[columns.len() - back].parse::<u64>().ok();
            facts.storage_total_kb = at(5);
            facts.storage_free_kb = at(3);
        }
    }

    facts.memory_kb = field(section("memory"), "MemTotal")
        .and_then(|v| v.split_whitespace().next())
        .and_then(|v| v.parse().ok());

    let display = section("display");
    if let Some((w, h)) = field(display, "Physical size").and_then(|v| v.split_once('x')) {
        facts.screen_width = w.trim().parse().ok();
        facts.screen_height = h.trim().parse().ok();
    }
    facts
}

/// Battery, storage, memory and display, read in one round trip.
pub async fn device_facts(serial: &str) -> Result<DeviceFacts> {
    let mut facts = parse_device_facts(&shell_text(serial, FACTS_COMMAND).await?);
    facts.refresh_hz = peak_refresh_rate(serial).await.map(|rate| rate.round() as u32);
    Ok(facts)
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
    use super::{failure_reason, parse_mdns_services, parse_peak_refresh_rate, CONNECT_SERVICE, PAIRING_SERVICE};

    #[test]
    fn parses_device_facts() {
        let output = "@battery\nCurrent Battery Service state:\n  AC powered: false\n  USB powered: true\n  status: 2\n  level: 84\n  scale: 100\n\
                      @storage\nFilesystem      1K-blocks    Used Available Use% Mounted on\n/dev/block/dm-48\n 115164944 60104768  55060176  53% /data\n\
                      @memory\nMemTotal:        7841284 kB\nMemFree:          301234 kB\n\
                      @display\nPhysical size: 1080x2400\nOverride size: 720x1600\n";
        let facts = super::parse_device_facts(output);
        assert_eq!(facts.battery_percent, Some(84));
        assert!(facts.charging);
        assert_eq!(facts.storage_total_kb, Some(115164944));
        assert_eq!(facts.storage_free_kb, Some(55060176));
        assert_eq!(facts.memory_kb, Some(7841284));
        assert_eq!((facts.screen_width, facts.screen_height), (Some(1080), Some(2400)));
    }

    #[test]
    fn parses_app_icons_and_skips_log_lines() {
        let output = "[server] INFO: Device: [Google] google sdk_gphone64\ncom.google.android.gm iVBORw0KGgo=\n\ncom.ubercab iVBORw0KGgoAAAA\nnot a package! abc\n";
        let icons = super::parse_app_icons(output);
        assert_eq!(icons.len(), 2);
        assert_eq!(icons["com.google.android.gm"], "iVBORw0KGgo=");
        assert_eq!(icons["com.ubercab"], "iVBORw0KGgoAAAA");
    }

    #[test]
    fn device_facts_tolerate_missing_sections() {
        let facts = super::parse_device_facts("@battery\n@storage\ndf: /data: Permission denied\n");
        assert_eq!(facts, super::DeviceFacts::default());
    }

    #[test]
    fn parses_pairing_and_connect_services() {
        let output = "List of discovered mdns services\n\
                      adb-2B1A0BCC-kXlYVe\t_adb-tls-connect._tcp\t192.168.1.10:41335\n\
                      another-Qh9c2x\t_adb-tls-pairing._tcp.\t192.168.1.10:37891\n";
        let services = parse_mdns_services(output);
        assert_eq!(services.len(), 2);
        assert_eq!(services[0].kind, CONNECT_SERVICE);
        assert_eq!(services[1].kind, PAIRING_SERVICE);
        assert_eq!(services[1].name, "another-Qh9c2x");
        assert_eq!(services[1].host(), "192.168.1.10");
    }

    #[test]
    fn failure_reason_keeps_only_the_error_line() {
        assert_eq!(failure_reason("adb: error: device offline\n", ""), "device offline");
        assert_eq!(
            failure_reason("Performing Streamed Install\nadb: failed to install a.apk: Failure [INSTALL_FAILED_OLDER_SDK]", ""),
            "failed to install a.apk: Failure [INSTALL_FAILED_OLDER_SDK]"
        );
        assert_eq!(failure_reason("", "failed to connect to 10.0.0.2:5555"), "failed to connect to 10.0.0.2:5555");
        assert_eq!(failure_reason("", ""), "adb stopped unexpectedly");
    }

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
