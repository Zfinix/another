use anyhow::Result;
use rodio::{buffer::SamplesBuffer, OutputStream, Sink};
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;
use tokio::sync::Notify;

const FLAG_CONFIG: u64 = 1 << 63;

pub struct AudioHandle {
    pub sink: Arc<Sink>,
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

        Ok(Self {
            sink,
            _shutdown_tx: shutdown_tx,
        })
    }
}

pub async fn stream_audio(
    mut audio_socket: TcpStream,
    audio: Arc<AudioHandle>,
    shutdown: Arc<Notify>,
) {
    let result = tokio::select! {
        r = playback_loop(&mut audio_socket, &audio.sink) => r,
        _ = shutdown.notified() => Ok(()),
    };

    if let Err(e) = result {
        eprintln!("[audio] stream ended: {}", e);
    }
}

async fn playback_loop(socket: &mut TcpStream, sink: &Sink) -> Result<()> {
    let mut packet_count: u64 = 0;

    loop {
        let mut header = [0u8; 12];
        socket.read_exact(&mut header).await?;

        let pts_flags = u64::from_be_bytes(header[0..8].try_into()?);
        let is_config = pts_flags & FLAG_CONFIG != 0;
        let size = u32::from_be_bytes(header[8..12].try_into()?) as usize;

        if size == 0 {
            continue;
        }

        let mut data = vec![0u8; size];
        socket.read_exact(&mut data).await?;

        if is_config {
            eprintln!("[audio] config packet: {} bytes", size);
            continue;
        }

        packet_count += 1;
        if packet_count <= 3 || packet_count % 500 == 0 {
            eprintln!(
                "[audio] packet #{}: {} bytes, sink queue: {}",
                packet_count,
                size,
                sink.len()
            );
        }

        let samples: Vec<i16> = data
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect();

        if samples.is_empty() {
            continue;
        }

        if sink.len() > 8 {
            sink.clear();
        }

        let source = SamplesBuffer::new(2, 48000, samples);
        sink.append(source);
    }
}
