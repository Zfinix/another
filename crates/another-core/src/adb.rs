use anyhow::{anyhow, Result};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::OnceLock;
use tokio::process::Command;

static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

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

    if let Some(dir) = RESOURCE_DIR.get() {
        let bundled = dir.join("resources").join(binary);
        if bundled.exists() {
            return bundled;
        }
    }
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
    PathBuf::from(binary)
}

async fn run_adb(args: &[&str]) -> Result<Vec<u8>> {
    let output = Command::new(adb_path())
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
    let child = Command::new(adb_path())
        .args(["-s", serial, "shell", cmd])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| anyhow!("Failed to spawn adb shell: {}", e))?;
    Ok(child)
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

pub async fn connect_device(address: &str) -> Result<()> {
    let output = run_adb_text(&["connect", address]).await?;
    if output.contains("connected") || output.contains("already connected") {
        Ok(())
    } else {
        Err(anyhow!("Failed to connect: {}", output.trim()))
    }
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
