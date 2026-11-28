use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use tokio::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const ADB_PORT: u16 = 5555;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TailnetPeer {
    pub name: String,
    pub dns_name: String,
    /// `ip:5555`, ready for `adb connect`.
    pub address: String,
    pub online: bool,
    /// True when WireGuard reaches the peer directly instead of through a DERP relay.
    pub direct: bool,
    pub relay: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TailnetStatus {
    pub running: bool,
    pub peers: Vec<TailnetPeer>,
}

#[cfg(target_os = "macos")]
const TAILSCALE_PATHS: &[&str] = &[
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];
#[cfg(windows)]
const TAILSCALE_PATHS: &[&str] = &[r"C:\Program Files\Tailscale\tailscale.exe"];
#[cfg(not(any(target_os = "macos", windows)))]
const TAILSCALE_PATHS: &[&str] = &["/usr/bin/tailscale", "/usr/local/bin/tailscale"];

/// Apps started from Finder or the Start menu get a minimal PATH, so the usual install locations
/// are tried first.
fn tailscale_path() -> PathBuf {
    TAILSCALE_PATHS
        .iter()
        .map(PathBuf::from)
        .find(|path| path.exists())
        .unwrap_or_else(|| PathBuf::from("tailscale"))
}

/// The Android devices on this computer's tailnet.
pub async fn status() -> Result<TailnetStatus> {
    let mut cmd = Command::new(tailscale_path());
    cmd.args(["status", "--json"]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .await
        .map_err(|e| anyhow!("Tailscale is not installed: {}", e))?;
    if output.stdout.is_empty() {
        return Err(anyhow!(
            "tailscale status failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_status(&String::from_utf8_lossy(&output.stdout))
}

pub fn parse_status(json: &str) -> Result<TailnetStatus> {
    let root: Value = serde_json::from_str(json)?;
    let running = root["BackendState"].as_str() == Some("Running");
    let mut peers: Vec<TailnetPeer> = root["Peer"]
        .as_object()
        .map(|peers| peers.values().filter_map(android_peer).collect())
        .unwrap_or_default();
    peers.sort_by(|a, b| b.online.cmp(&a.online).then_with(|| a.name.cmp(&b.name)));
    Ok(TailnetStatus { running, peers })
}

fn android_peer(peer: &Value) -> Option<TailnetPeer> {
    if !peer["OS"].as_str()?.eq_ignore_ascii_case("android") {
        return None;
    }
    let ips: Vec<&str> = peer["TailscaleIPs"].as_array()?.iter().filter_map(Value::as_str).collect();
    let ip = ips.iter().find(|ip| ip.contains('.')).or_else(|| ips.first())?;
    let address = if ip.contains(':') {
        format!("[{}]:{}", ip, ADB_PORT)
    } else {
        format!("{}:{}", ip, ADB_PORT)
    };
    Some(TailnetPeer {
        name: peer["HostName"].as_str().unwrap_or(ip).to_string(),
        dns_name: peer["DNSName"].as_str().unwrap_or_default().trim_end_matches('.').to_string(),
        address,
        online: peer["Online"].as_bool().unwrap_or(false),
        direct: !peer["CurAddr"].as_str().unwrap_or_default().is_empty(),
        relay: peer["Relay"].as_str().unwrap_or_default().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::parse_status;

    const STATUS: &str = r#"{
        "BackendState": "Running",
        "Peer": {
            "nodekey:a": {
                "HostName": "pixel-4-xl", "DNSName": "pixel-4-xl.tail1234.ts.net.", "OS": "android",
                "TailscaleIPs": ["100.101.1.2", "fd7a:115c:a1e0::1"], "Online": true,
                "CurAddr": "192.168.1.154:41641", "Relay": "lhr"
            },
            "nodekey:b": {
                "HostName": "old-phone", "DNSName": "old-phone.tail1234.ts.net.", "OS": "android",
                "TailscaleIPs": ["100.101.1.3"], "Online": false, "CurAddr": "", "Relay": "fra"
            },
            "nodekey:c": {
                "HostName": "laptop", "OS": "macOS", "TailscaleIPs": ["100.101.1.4"], "Online": true
            }
        }
    }"#;

    #[test]
    fn keeps_android_peers_online_first() {
        let status = parse_status(STATUS).unwrap();
        assert!(status.running);
        let names: Vec<&str> = status.peers.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["pixel-4-xl", "old-phone"]);
    }

    #[test]
    fn reads_address_and_network_path() {
        let status = parse_status(STATUS).unwrap();
        let pixel = &status.peers[0];
        assert_eq!(pixel.address, "100.101.1.2:5555");
        assert_eq!(pixel.dns_name, "pixel-4-xl.tail1234.ts.net");
        assert!(pixel.direct);
        let old = &status.peers[1];
        assert!(!old.direct);
        assert_eq!(old.relay, "fra");
    }

    #[test]
    fn stopped_backend_is_not_running() {
        let status = parse_status(r#"{"BackendState": "Stopped", "Peer": null}"#).unwrap();
        assert!(!status.running);
        assert!(status.peers.is_empty());
    }
}
