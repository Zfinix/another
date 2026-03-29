use anyhow::{anyhow, Result};
use serde::Deserialize;
use socket2::{Domain, Socket, Type};
use std::net::SocketAddr;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

use crate::adb;

const SCRCPY_SERVER_REMOTE_PATH: &str = "/data/local/tmp/scrcpy-server.jar";

#[derive(Debug, Clone, Deserialize)]
pub struct StreamSettings {
    pub max_size: u32,
    pub max_fps: u32,
    pub video_bit_rate: u32,
    pub video_codec: String,
    pub audio: bool,
}

impl Default for StreamSettings {
    fn default() -> Self {
        Self {
            max_size: 1024,
            max_fps: 60,
            video_bit_rate: 8000000,
            video_codec: "h264".to_string(),
            audio: false,
        }
    }
}

pub struct ConnectedStreams {
    pub video_socket: TcpStream,
    pub audio_socket: Option<TcpStream>,
    pub control_socket: TcpStream,
    pub screen_width: u32,
    pub screen_height: u32,
}

pub async fn start_server(
    serial: &str,
    server_path: &str,
    port: u16,
    settings: &StreamSettings,
) -> Result<(ConnectedStreams, tokio::process::Child)> {
    adb::kill_scrcpy_server(serial).await;
    adb::remove_forward(serial, port).await?;

    adb::push_file(serial, server_path, SCRCPY_SERVER_REMOTE_PATH).await?;

    let addr: SocketAddr = format!("127.0.0.1:{}", port).parse()?;
    let socket = Socket::new(Domain::IPV4, Type::STREAM, None)?;
    socket.set_reuse_address(true)?;
    socket.set_nonblocking(true)?;
    socket.bind(&addr.into())?;
    socket.listen(4)?;
    let listener = TcpListener::from_std(socket.into())?;

    adb::reverse(serial, "localabstract:scrcpy", port).await?;

    let audio_args = if settings.audio {
        "audio=true audio_codec=raw"
    } else {
        "audio=false"
    };

    let server_cmd = format!(
        "CLASSPATH={path} app_process / com.genymobile.scrcpy.Server 2.7 \
         tunnel_forward=false \
         {audio_args} \
         control=true \
         video_codec={codec} \
         max_size={max_size} \
         max_fps={max_fps} \
         video_bit_rate={bitrate} \
         send_device_meta=true \
         send_dummy_byte=false \
         log_level=info",
        path = SCRCPY_SERVER_REMOTE_PATH,
        audio_args = audio_args,
        codec = settings.video_codec,
        max_size = settings.max_size,
        max_fps = settings.max_fps,
        bitrate = settings.video_bit_rate,
    );

    let mut server_process = adb::shell(serial, &server_cmd).await?;

    let stdout = server_process.stdout.take();
    if let Some(stdout) = stdout {
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[scrcpy-server] {}", line);
            }
        });
    }

    let stderr = server_process.stderr.take();
    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[scrcpy-server stderr] {}", line);
            }
        });
    }

    let (mut video_socket, _) = tokio::time::timeout(
        tokio::time::Duration::from_secs(10),
        listener.accept(),
    )
    .await
    .map_err(|_| anyhow!("Timeout waiting for video connection"))?
    .map_err(|e| anyhow!("Accept failed: {}", e))?;

    let audio_socket = if settings.audio {
        let (mut audio_sock, _) = tokio::time::timeout(
            tokio::time::Duration::from_secs(5),
            listener.accept(),
        )
        .await
        .map_err(|_| anyhow!("Timeout waiting for audio connection"))?
        .map_err(|e| anyhow!("Accept failed: {}", e))?;

        let mut audio_codec_buf = [0u8; 4];
        audio_sock.read_exact(&mut audio_codec_buf).await?;

        Some(audio_sock)
    } else {
        None
    };

    let (control_socket, _) = tokio::time::timeout(
        tokio::time::Duration::from_secs(5),
        listener.accept(),
    )
    .await
    .map_err(|_| anyhow!("Timeout waiting for control connection"))?
    .map_err(|e| anyhow!("Accept failed: {}", e))?;

    let mut device_name_buf = [0u8; 64];
    video_socket.read_exact(&mut device_name_buf).await?;

    let mut codec_buf = [0u8; 4];
    video_socket.read_exact(&mut codec_buf).await?;

    let mut size_buf = [0u8; 8];
    video_socket.read_exact(&mut size_buf).await?;
    let screen_width = u32::from_be_bytes([size_buf[0], size_buf[1], size_buf[2], size_buf[3]]);
    let screen_height = u32::from_be_bytes([size_buf[4], size_buf[5], size_buf[6], size_buf[7]]);

    drop(listener);

    Ok((
        ConnectedStreams {
            video_socket,
            audio_socket,
            control_socket,
            screen_width,
            screen_height,
        },
        server_process,
    ))
}

pub async fn stop_server(serial: &str, _port: u16) {
    let _ = adb::remove_reverse(serial, "localabstract:scrcpy").await;
    adb::kill_scrcpy_server(serial).await;
}
