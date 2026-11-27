use crate::audio::AudioHandle;
use another_core::transport::DeviceStream;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

const FIRST_SERVER_PORT: u16 = 27183;
const SERVER_PORTS: u16 = 64;

pub struct ScrcpySession {
    pub id: u64,
    pub device_serial: String,
    pub control_socket: Arc<Mutex<DeviceStream>>,
    pub screen_width: u32,
    pub screen_height: u32,
    pub shutdown: Arc<tokio::sync::Notify>,
    pub audio: Option<Arc<AudioHandle>>,
    pub muted: bool,
    pub live_video_control: bool,
    pub port: PortLease,
}

/// A local port for one session's server tunnel, handed back when the session is dropped.
pub struct PortLease {
    pub port: u16,
    ports: Arc<std::sync::Mutex<HashSet<u16>>>,
}

impl Drop for PortLease {
    fn drop(&mut self) {
        if let Ok(mut ports) = self.ports.lock() {
            ports.remove(&self.port);
        }
    }
}

pub struct McpServerState {
    pub cancel: Option<CancellationToken>,
    pub port: u16,
}

pub struct AppState {
    /// Mirroring sessions, keyed by the label of the window that shows them.
    pub sessions: Arc<Mutex<HashMap<String, ScrcpySession>>>,
    /// The mirror window whose phone is heard; the others stay silent.
    pub audio_focus: Arc<Mutex<Option<String>>>,
    pub mcp: Arc<Mutex<McpServerState>>,
    /// Phones whose `stay_on_while_plugged_in` setting Another changed, with the value to put back.
    pub stay_on: Arc<Mutex<HashMap<String, String>>>,
    ports: Arc<std::sync::Mutex<HashSet<u16>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            audio_focus: Arc::new(Mutex::new(None)),
            mcp: Arc::new(Mutex::new(McpServerState {
                cancel: None,
                port: 7070,
            })),
            stay_on: Arc::new(Mutex::new(HashMap::new())),
            ports: Arc::new(std::sync::Mutex::new(HashSet::new())),
        }
    }

    pub fn lease_port(&self) -> Option<PortLease> {
        let mut ports = self.ports.lock().ok()?;
        let port = (FIRST_SERVER_PORT..FIRST_SERVER_PORT + SERVER_PORTS).find(|port| !ports.contains(port))?;
        ports.insert(port);
        Some(PortLease {
            port,
            ports: self.ports.clone(),
        })
    }
}

/// Plays the focused window's phone and silences the rest, honouring each window's mute.
pub fn apply_audio_focus(sessions: &HashMap<String, ScrcpySession>, focus: Option<&str>) {
    for (label, session) in sessions {
        if let Some(audio) = &session.audio {
            let audible = !session.muted && focus == Some(label.as_str());
            audio.sink.set_volume(if audible { 1.0 } else { 0.0 });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leases_distinct_ports_and_reuses_released_ones() {
        let state = AppState::new();
        let first = state.lease_port().unwrap();
        let second = state.lease_port().unwrap();
        assert_ne!(first.port, second.port);
        let freed = first.port;
        drop(first);
        assert_eq!(state.lease_port().unwrap().port, freed);
    }
}
