use crate::video::{FrameEvent, VideoCodec};
use anyhow::{anyhow, Result};
use tauri::ipc::Channel;
use tauri::WebviewWindow;

pub struct NativeVideo;

impl NativeVideo {
    pub fn attach(_window: WebviewWindow, _channel: Channel<FrameEvent>) -> Result<Self> {
        Err(anyhow!("Native video is only available on macOS"))
    }

    pub fn configure(&mut self, _codec: VideoCodec, _parameter_sets: &[&[u8]]) -> Result<()> {
        Ok(())
    }

    pub fn decode(&mut self, _avcc: &[u8], _pts: u64, _recv_ms: f64, _capture_ms: Option<f64>) -> Result<()> {
        Ok(())
    }
}

pub fn set_frame(_x: f64, _y: f64, _width: f64, _height: f64) {}

pub fn detach() {}

pub fn arm_probe(_x: f64, _y: f64) -> Result<std::sync::mpsc::Receiver<std::time::Instant>> {
    Err(anyhow!("Native video is only available on macOS"))
}

pub fn disarm_probe() {}
