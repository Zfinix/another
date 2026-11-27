use another_core::transport::DeviceStream;
use anyhow::Result;
use rodio::{OutputStream, Sink, Source};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

const FLAG_CONFIG: u64 = 1 << 63;
const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
const BYTES_PER_FRAME: usize = 2 * CHANNELS as usize;
const SAMPLES_PER_MS: usize = SAMPLE_RATE as usize * CHANNELS as usize / 1000;
/// Audio held back before playback starts, and again after the buffer runs dry, to absorb network jitter.
const TARGET_BUFFER: usize = 60 * SAMPLES_PER_MS;
/// Past this backlog the oldest audio is dropped back to the target so latency stays bounded.
const MAX_BUFFER: usize = 250 * SAMPLES_PER_MS;
const PULL_CHUNK: usize = 5 * SAMPLES_PER_MS;

struct JitterBuffer {
    samples: VecDeque<i16>,
    buffering: bool,
}

impl JitterBuffer {
    fn new() -> Self {
        Self {
            samples: VecDeque::with_capacity(MAX_BUFFER + PULL_CHUNK),
            buffering: true,
        }
    }

    /// Queues little-endian PCM and returns how many samples of stale backlog were dropped.
    fn push(&mut self, pcm: &[u8]) -> usize {
        let whole_frames = pcm.len() - pcm.len() % BYTES_PER_FRAME;
        self.samples.extend(
            pcm[..whole_frames]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|&bytes| i16::from_le_bytes(bytes)),
        );

        let mut dropped = 0;
        if self.samples.len() > MAX_BUFFER {
            dropped = self.samples.len() - TARGET_BUFFER;
            self.samples.drain(..dropped);
        }
        if self.buffering && self.samples.len() >= TARGET_BUFFER {
            self.buffering = false;
        }
        dropped
    }

    fn pull(&mut self, out: &mut Vec<i16>) {
        out.clear();
        if !self.buffering {
            let available = self.samples.len().min(PULL_CHUNK);
            let available = available - available % CHANNELS as usize;
            if available == 0 {
                self.buffering = true;
            } else {
                out.extend(self.samples.drain(..available));
                return;
            }
        }
        out.resize(PULL_CHUNK, 0);
    }
}

/// An endless source that plays whatever the jitter buffer holds and silence while it refills.
struct JitterSource {
    buffer: Arc<Mutex<JitterBuffer>>,
    chunk: Vec<i16>,
    position: usize,
}

impl Iterator for JitterSource {
    type Item = i16;

    fn next(&mut self) -> Option<i16> {
        if self.position >= self.chunk.len() {
            match self.buffer.lock() {
                Ok(mut buffer) => buffer.pull(&mut self.chunk),
                Err(_) => {
                    self.chunk.clear();
                    self.chunk.resize(PULL_CHUNK, 0);
                }
            }
            self.position = 0;
        }
        let sample = self.chunk[self.position];
        self.position += 1;
        Some(sample)
    }
}

impl Source for JitterSource {
    fn current_frame_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> u16 {
        CHANNELS
    }

    fn sample_rate(&self) -> u32 {
        SAMPLE_RATE
    }

    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

pub struct AudioHandle {
    pub sink: Arc<Sink>,
    buffer: Arc<Mutex<JitterBuffer>>,
    _shutdown_tx: std::sync::mpsc::Sender<()>,
}

impl AudioHandle {
    pub fn new() -> Result<Self> {
        let (shutdown_tx, shutdown_rx) = std::sync::mpsc::channel::<()>();
        let (sink_tx, sink_rx) = std::sync::mpsc::sync_channel::<Arc<Sink>>(1);

        std::thread::spawn(move || {
            let Ok((_stream, handle)) = OutputStream::try_default() else {
                eprintln!("[audio] failed to open output stream");
                return;
            };
            let Ok(sink) = Sink::try_new(&handle) else {
                eprintln!("[audio] failed to create sink");
                return;
            };
            let sink = Arc::new(sink);
            let _ = sink_tx.send(sink);
            let _ = shutdown_rx.recv();
        });

        let sink = sink_rx
            .recv()
            .map_err(|_| anyhow::anyhow!("Failed to initialize audio output"))?;

        let buffer = Arc::new(Mutex::new(JitterBuffer::new()));
        sink.append(JitterSource {
            buffer: buffer.clone(),
            chunk: Vec::with_capacity(PULL_CHUNK),
            position: 0,
        });

        Ok(Self {
            sink,
            buffer,
            _shutdown_tx: shutdown_tx,
        })
    }
}

pub async fn stream_audio(
    mut audio_socket: DeviceStream,
    audio: Arc<AudioHandle>,
    shutdown: Arc<Notify>,
) {
    let result = tokio::select! {
        r = receive_loop(&mut audio_socket, &audio.buffer) => r,
        _ = shutdown.notified() => Ok(()),
    };

    if let Err(e) = result {
        eprintln!("[audio] stream ended: {}", e);
    }
}

async fn receive_loop(socket: &mut DeviceStream, buffer: &Mutex<JitterBuffer>) -> Result<()> {
    let mut data = Vec::new();

    loop {
        let mut header = [0u8; 12];
        socket.read_exact(&mut header).await?;

        let pts_flags = u64::from_be_bytes(header[0..8].try_into()?);
        let is_config = pts_flags & FLAG_CONFIG != 0;
        let size = u32::from_be_bytes(header[8..12].try_into()?) as usize;

        if size == 0 {
            continue;
        }

        data.resize(size, 0);
        socket.read_exact(&mut data).await?;

        if is_config {
            continue;
        }

        let dropped = buffer
            .lock()
            .map_err(|_| anyhow::anyhow!("Audio buffer lock poisoned"))?
            .push(&data);
        if dropped > 0 {
            eprintln!("[audio] dropped {} ms of backlog", dropped / SAMPLES_PER_MS);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm(samples: usize) -> Vec<u8> {
        (0..samples).flat_map(|i| (i as i16 + 1).to_le_bytes()).collect()
    }

    #[test]
    fn plays_silence_until_the_target_is_buffered() {
        let mut buffer = JitterBuffer::new();
        let mut out = Vec::new();
        buffer.push(&pcm(TARGET_BUFFER - CHANNELS as usize));
        buffer.pull(&mut out);
        assert!(out.iter().all(|&s| s == 0));

        buffer.push(&pcm(CHANNELS as usize));
        buffer.pull(&mut out);
        assert_eq!(out.len(), PULL_CHUNK);
        assert!(out.iter().all(|&s| s != 0));
    }

    #[test]
    fn rebuffers_after_running_dry() {
        let mut buffer = JitterBuffer::new();
        let mut out = Vec::new();
        buffer.push(&pcm(TARGET_BUFFER));
        while !buffer.samples.is_empty() {
            buffer.pull(&mut out);
        }
        buffer.pull(&mut out);
        assert!(buffer.buffering);

        buffer.push(&pcm(PULL_CHUNK));
        buffer.pull(&mut out);
        assert!(out.iter().all(|&s| s == 0));
    }

    #[test]
    fn trims_a_backlog_to_the_target_without_stopping() {
        let mut buffer = JitterBuffer::new();
        buffer.push(&pcm(MAX_BUFFER));
        let dropped = buffer.push(&pcm(PULL_CHUNK));
        assert_eq!(dropped, MAX_BUFFER + PULL_CHUNK - TARGET_BUFFER);
        assert_eq!(buffer.samples.len(), TARGET_BUFFER);
        assert!(!buffer.buffering);
    }

    #[test]
    fn ignores_a_trailing_partial_frame() {
        let mut buffer = JitterBuffer::new();
        let mut bytes = pcm(4);
        bytes.push(7);
        buffer.push(&bytes);
        assert_eq!(buffer.samples.len(), 4);
    }
}
