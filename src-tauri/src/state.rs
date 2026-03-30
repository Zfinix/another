use crate::audio::AudioHandle;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub struct ScrcpySession {
    pub device_serial: String,
    pub control_socket: Arc<Mutex<TcpStream>>,
    pub screen_width: u32,
    pub screen_height: u32,
    pub shutdown: Arc<tokio::sync::Notify>,
    pub audio: Option<Arc<AudioHandle>>,
}

pub struct McpServerState {
    pub cancel: Option<CancellationToken>,
    pub port: u16,
}

pub struct AppState {
    pub session: Arc<Mutex<Option<ScrcpySession>>>,
    pub mcp: Arc<Mutex<McpServerState>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            session: Arc::new(Mutex::new(None)),
            mcp: Arc::new(Mutex::new(McpServerState {
                cancel: None,
                port: 7070,
            })),
        }
    }
}
