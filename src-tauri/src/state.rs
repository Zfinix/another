use crate::audio::AudioHandle;
use another_core::transport::DeviceStream;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub struct ScrcpySession {
    pub id: u64,
    pub device_serial: String,
    pub control_socket: Arc<Mutex<DeviceStream>>,
    pub screen_width: u32,
    pub screen_height: u32,
    pub shutdown: Arc<tokio::sync::Notify>,
    pub audio: Option<Arc<AudioHandle>>,
    pub live_video_control: bool,
}

pub struct McpServerState {
    pub cancel: Option<CancellationToken>,
    pub port: u16,
}

/// A phone whose `stay_on_while_plugged_in` setting Another changed, with the value to put back.
pub struct StayOn {
    pub serial: String,
    pub previous: String,
}

pub struct AppState {
    pub session: Arc<Mutex<Option<ScrcpySession>>>,
    pub mcp: Arc<Mutex<McpServerState>>,
    pub stay_on: Arc<Mutex<Option<StayOn>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            session: Arc::new(Mutex::new(None)),
            mcp: Arc::new(Mutex::new(McpServerState {
                cancel: None,
                port: 7070,
            })),
            stay_on: Arc::new(Mutex::new(None)),
        }
    }
}
