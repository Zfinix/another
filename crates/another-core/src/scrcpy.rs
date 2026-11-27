use anyhow::{anyhow, Result};
use serde::Deserialize;
use socket2::{Domain, Socket, Type};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Child;

use crate::adb;
use crate::transport::{self, DeviceStream, DirectDevice};

const SCRCPY_SERVER_REMOTE_PATH: &str = "/data/local/tmp/scrcpy-server.jar";

#[derive(Debug, Clone, Deserialize)]
pub struct StreamSettings {
    pub max_size: u32,
    pub max_fps: u32,
    pub video_bit_rate: u32,
    pub video_codec: String,
    pub audio: bool,
    #[serde(default)]
    pub direct_adb: bool,
    #[serde(default)]
    pub low_latency: bool,
    #[serde(default)]
    pub encoder_tuning: EncoderTuning,
    #[serde(default)]
    pub another_server: bool,
    #[serde(default)]
    pub native_video: bool,
    #[serde(default = "default_network_stream")]
    pub network_stream: bool,
}

fn default_network_stream() -> bool {
    true
}

pub const SCRCPY_SERVER_FILE: &str = "scrcpy-server-v2.7";
pub const ANOTHER_SERVER_FILE: &str = "another-server";
const SCRCPY_SERVER_VERSION: &str = "2.7";
const SCRCPY_SERVER_MAIN: &str = "com.genymobile.scrcpy.Server";
const ANOTHER_SERVER_VERSION: &str = "another-1";
const ANOTHER_SERVER_MAIN: &str = "dev.another.server.Main";
const ANOTHER_SERVER_MAX_QUEUED_FRAMES: u32 = 6;

impl StreamSettings {
    pub fn server_file(&self) -> &'static str {
        if self.another_server {
            ANOTHER_SERVER_FILE
        } else {
            SCRCPY_SERVER_FILE
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncoderTuning {
    #[default]
    Default,
    ConstantBitrate,
    ConstantBitrateDropFrames,
    IntraRefresh,
    HighProfile,
}

impl EncoderTuning {
    fn codec_options(self) -> &'static str {
        match self {
            EncoderTuning::Default => "",
            EncoderTuning::ConstantBitrate => ",bitrate-mode=2",
            EncoderTuning::ConstantBitrateDropFrames => ",bitrate-mode=3",
            EncoderTuning::IntraRefresh => ",intra-refresh-period=60",
            EncoderTuning::HighProfile => ",profile=8",
        }
    }
}

impl Default for StreamSettings {
    fn default() -> Self {
        Self {
            max_size: 1024,
            max_fps: 60,
            video_bit_rate: 8000000,
            video_codec: "h264".to_string(),
            audio: false,
            direct_adb: false,
            low_latency: false,
            encoder_tuning: EncoderTuning::Default,
            another_server: false,
            native_video: false,
            network_stream: true,
        }
    }
}

pub struct ConnectedStreams {
    pub video_socket: DeviceStream,
    pub audio_socket: Option<DeviceStream>,
    pub control_socket: DeviceStream,
    pub screen_width: u32,
    pub screen_height: u32,
}

pub enum ServerHandle {
    Process(tokio::process::Child),
    Direct(DirectDevice),
}

impl ServerHandle {
    pub async fn kill(&mut self) -> Result<()> {
        match self {
            ServerHandle::Process(child) => Ok(child.kill().await?),
            ServerHandle::Direct(device) => {
                device.close();
                Ok(())
            }
        }
    }
}

const LOW_LATENCY_CODEC_OPTIONS: &str = "latency=1,priority=0,max-bframes=0";
const KILL_SERVER_CMD: &str = "pkill -f com.genymobile.scrcpy.Server";
const DIRECT_OPEN_TIMEOUT: Duration = Duration::from_secs(10);
const DIRECT_OPEN_RETRY: Duration = Duration::from_millis(50);
const NETWORK_PORT_BASE: u16 = 27200;
const NETWORK_PORT_RANGE: u16 = 800;
const NETWORK_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const NETWORK_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(2);
const NETWORK_TOKEN_LEN: usize = 16;

fn codec_options(settings: &StreamSettings) -> String {
    if !settings.low_latency {
        return String::new();
    }
    let operating_rate = if settings.max_fps > 0 {
        format!(",operating-rate:float={}", settings.max_fps)
    } else {
        String::new()
    };
    format!(
        " video_codec_options={}{}{}",
        LOW_LATENCY_CODEC_OPTIONS,
        operating_rate,
        settings.encoder_tuning.codec_options()
    )
}

fn server_command(settings: &StreamSettings, tunnel_forward: bool) -> String {
    let audio_args = if settings.audio {
        "audio=true audio_codec=raw"
    } else {
        "audio=false"
    };

    format!(
        "CLASSPATH={path} app_process / {main} {version} \
         tunnel_forward={tunnel_forward} \
         {audio_args} \
         control=true \
         video_codec={codec} \
         max_size={max_size} \
         max_fps={max_fps} \
         video_bit_rate={bitrate} \
         send_device_meta=true \
         send_dummy_byte={tunnel_forward} \
         log_level=info{codec_options}{queue}",
        path = SCRCPY_SERVER_REMOTE_PATH,
        main = if settings.another_server {
            ANOTHER_SERVER_MAIN
        } else {
            SCRCPY_SERVER_MAIN
        },
        version = if settings.another_server {
            ANOTHER_SERVER_VERSION
        } else {
            SCRCPY_SERVER_VERSION
        },
        tunnel_forward = tunnel_forward,
        audio_args = audio_args,
        codec = settings.video_codec,
        max_size = settings.max_size,
        max_fps = settings.max_fps,
        bitrate = settings.video_bit_rate,
        codec_options = codec_options(settings),
        queue = if settings.another_server {
            format!(" max_queued_frames={} send_clock=true", ANOTHER_SERVER_MAX_QUEUED_FRAMES)
        } else {
            String::new()
        },
    )
}

pub async fn start_server(
    serial: &str,
    server_path: &str,
    port: u16,
    settings: &StreamSettings,
) -> Result<(ConnectedStreams, ServerHandle)> {
    let mut settings = settings.clone();
    if let Some(rate) = adb::peak_refresh_rate(serial).await {
        let cap = rate.round() as u32;
        if cap > 0 && (settings.max_fps == 0 || settings.max_fps > cap) {
            eprintln!(
                "[scrcpy] capping max_fps {} to the display's {} Hz",
                settings.max_fps, cap
            );
            settings.max_fps = cap;
        }
    }
    let settings = &settings;

    if settings.another_server && settings.network_stream {
        if let Some(host) = network_host(serial) {
            match start_network(serial, host, server_path, settings).await {
                Ok(started) => return Ok(started),
                Err(e) => eprintln!(
                    "[scrcpy] direct network stream to {} failed, falling back to adb: {}",
                    host, e
                ),
            }
        }
    }

    if let Some(address) = settings
        .direct_adb
        .then(|| transport::direct_address(serial))
        .flatten()
    {
        match start_direct(&address, server_path, settings).await {
            Ok(started) => return Ok(started),
            Err(e) => eprintln!(
                "[scrcpy] direct adb to {} failed, falling back to the adb server: {}",
                address, e
            ),
        }
    }
    start_via_adb_server(serial, server_path, port, settings).await
}

async fn start_direct(
    address: &str,
    server_path: &str,
    settings: &StreamSettings,
) -> Result<(ConnectedStreams, ServerHandle)> {
    let mut device = DirectDevice::connect(address).await?;

    let _ = device.exec(KILL_SERVER_CMD).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    device.push(server_path, SCRCPY_SERVER_REMOTE_PATH).await?;
    device
        .spawn_logged(&server_command(settings, true), "scrcpy-server")
        .await?;

    let started = tokio::time::Instant::now();
    let mut video_socket = loop {
        match device.open_stream("localabstract:scrcpy").await {
            Ok(stream) => break stream,
            Err(_) if started.elapsed() < DIRECT_OPEN_TIMEOUT => {
                tokio::time::sleep(DIRECT_OPEN_RETRY).await
            }
            Err(e) => return Err(anyhow!("Timeout waiting for video connection: {}", e)),
        }
    };
    let audio_socket = if settings.audio {
        Some(device.open_stream("localabstract:scrcpy").await?)
    } else {
        None
    };
    let control_socket = device.open_stream("localabstract:scrcpy").await?;

    let mut dummy = [0u8; 1];
    video_socket.read_exact(&mut dummy).await?;

    let streams = read_stream_meta(video_socket, audio_socket, control_socket).await?;
    Ok((streams, ServerHandle::Direct(device)))
}

/// The host of a device connected over the network (`host:port`), which the Another server can stream to directly.
pub fn network_host(serial: &str) -> Option<&str> {
    if serial.starts_with("emulator-") {
        return None;
    }
    let (host, port) = serial.rsplit_once(':')?;
    port.parse::<u16>().ok()?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    (!host.is_empty() && !host.contains(char::is_whitespace)).then_some(host)
}

/// Starts the Another server listening on a TCP port of the phone and connects to it straight over Wi-Fi or the
/// tailnet, so video does not wait on adb's per-write acknowledgements. Each socket opens with a per-session token.
async fn start_network(
    serial: &str,
    host: &str,
    server_path: &str,
    settings: &StreamSettings,
) -> Result<(ConnectedStreams, ServerHandle)> {
    let mut secret = [0u8; NETWORK_TOKEN_LEN + 2];
    getrandom::getrandom(&mut secret).map_err(|e| anyhow!("No randomness for the session token: {}", e))?;
    let token = &secret[..NETWORK_TOKEN_LEN];
    let port = NETWORK_PORT_BASE
        + u16::from_be_bytes([secret[NETWORK_TOKEN_LEN], secret[NETWORK_TOKEN_LEN + 1]]) % NETWORK_PORT_RANGE;
    let token_hex: String = token.iter().map(|b| format!("{:02x}", b)).collect();

    adb::push_file(serial, server_path, SCRCPY_SERVER_REMOTE_PATH).await?;
    let command = format!(
        "{} listen_port={} token={}",
        server_command(settings, false),
        port,
        token_hex
    );
    let mut process = adb::shell(serial, &command).await?;
    forward_logs(&mut process);

    let connected = async {
        let started = tokio::time::Instant::now();
        let video = connect_with_token(host, port, token, started).await?;
        let audio = if settings.audio {
            Some(connect_with_token(host, port, token, started).await?)
        } else {
            None
        };
        let control = connect_with_token(host, port, token, started).await?;
        read_stream_meta(video, audio, control).await
    }
    .await;

    match connected {
        Ok(streams) => {
            eprintln!("[scrcpy] streaming directly from {}:{}", host, port);
            Ok((streams, ServerHandle::Process(process)))
        }
        Err(e) => {
            let _ = process.kill().await;
            Err(e)
        }
    }
}

async fn connect_with_token(
    host: &str,
    port: u16,
    token: &[u8],
    started: tokio::time::Instant,
) -> Result<DeviceStream> {
    loop {
        let attempt = tokio::time::timeout(NETWORK_ATTEMPT_TIMEOUT, TcpStream::connect((host, port))).await;
        match attempt {
            Ok(Ok(mut stream)) => {
                stream.set_nodelay(true)?;
                stream.write_all(token).await?;
                return Ok(Box::new(stream));
            }
            _ if started.elapsed() < NETWORK_CONNECT_TIMEOUT => tokio::time::sleep(DIRECT_OPEN_RETRY).await,
            Ok(Err(e)) => return Err(anyhow!("Could not reach {}:{}: {}", host, port, e)),
            Err(_) => return Err(anyhow!("Timed out reaching {}:{}", host, port)),
        }
    }
}

fn forward_logs(process: &mut Child) {
    if let Some(stdout) = process.stdout.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[scrcpy-server] {}", line);
            }
        });
    }
    if let Some(stderr) = process.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[scrcpy-server stderr] {}", line);
            }
        });
    }
}

async fn read_stream_meta(
    mut video_socket: DeviceStream,
    mut audio_socket: Option<DeviceStream>,
    control_socket: DeviceStream,
) -> Result<ConnectedStreams> {
    if let Some(audio) = audio_socket.as_mut() {
        let mut audio_codec_buf = [0u8; 4];
        audio.read_exact(&mut audio_codec_buf).await?;
    }

    let mut device_name_buf = [0u8; 64];
    video_socket.read_exact(&mut device_name_buf).await?;

    let mut codec_buf = [0u8; 4];
    video_socket.read_exact(&mut codec_buf).await?;

    let mut size_buf = [0u8; 8];
    video_socket.read_exact(&mut size_buf).await?;
    let screen_width = u32::from_be_bytes([size_buf[0], size_buf[1], size_buf[2], size_buf[3]]);
    let screen_height = u32::from_be_bytes([size_buf[4], size_buf[5], size_buf[6], size_buf[7]]);

    Ok(ConnectedStreams {
        video_socket,
        audio_socket,
        control_socket,
        screen_width,
        screen_height,
    })
}

async fn start_via_adb_server(
    serial: &str,
    server_path: &str,
    port: u16,
    settings: &StreamSettings,
) -> Result<(ConnectedStreams, ServerHandle)> {
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

    let server_cmd = server_command(settings, false);

    let mut server_process = adb::shell(serial, &server_cmd).await?;
    forward_logs(&mut server_process);

    let (video_socket, _) = tokio::time::timeout(
        tokio::time::Duration::from_secs(10),
        listener.accept(),
    )
    .await
    .map_err(|_| anyhow!("Timeout waiting for video connection"))?
    .map_err(|e| anyhow!("Accept failed: {}", e))?;

    let audio_socket = if settings.audio {
        let (audio_sock, _) = tokio::time::timeout(
            tokio::time::Duration::from_secs(5),
            listener.accept(),
        )
        .await
        .map_err(|_| anyhow!("Timeout waiting for audio connection"))?
        .map_err(|e| anyhow!("Accept failed: {}", e))?;

        Some(Box::new(audio_sock) as DeviceStream)
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

    drop(listener);

    let streams = read_stream_meta(
        Box::new(video_socket),
        audio_socket,
        Box::new(control_socket),
    )
    .await?;
    Ok((streams, ServerHandle::Process(server_process)))
}

pub async fn stop_server(serial: &str, _port: u16) {
    let _ = adb::remove_reverse(serial, "localabstract:scrcpy").await;
    adb::kill_scrcpy_server(serial).await;
}

#[cfg(test)]
mod tests {
    use super::{codec_options, network_host, EncoderTuning, StreamSettings};

    fn settings(low_latency: bool, encoder_tuning: EncoderTuning) -> StreamSettings {
        StreamSettings {
            low_latency,
            encoder_tuning,
            ..StreamSettings::default()
        }
    }

    #[test]
    fn no_codec_options_without_low_latency() {
        assert_eq!(codec_options(&settings(false, EncoderTuning::ConstantBitrate)), "");
    }

    #[test]
    fn low_latency_sets_latency_and_priority() {
        assert_eq!(
            codec_options(&settings(true, EncoderTuning::Default)),
            " video_codec_options=latency=1,priority=0,max-bframes=0,operating-rate:float=60"
        );
    }

    #[test]
    fn another_server_uses_its_own_main_class_and_queue() {
        let settings = StreamSettings {
            another_server: true,
            ..StreamSettings::default()
        };
        let command = super::server_command(&settings, true);
        assert!(command.contains("app_process / dev.another.server.Main another-1 "));
        assert!(command.contains(" max_queued_frames=6"));
    }

    #[test]
    fn network_host_accepts_only_network_serials() {
        assert_eq!(network_host("192.168.1.154:5555"), Some("192.168.1.154"));
        assert_eq!(network_host("pixel.tail1234.ts.net:5555"), Some("pixel.tail1234.ts.net"));
        assert_eq!(network_host("[fd7a:115c::1]:5555"), Some("fd7a:115c::1"));
        assert_eq!(network_host("emulator-5554"), None);
        assert_eq!(network_host("9B051FFBA0057Z"), None);
        assert_eq!(network_host("adb-9B05._adb-tls-connect._tcp"), None);
    }

    #[test]
    fn stock_server_keeps_the_scrcpy_main_class() {
        let command = super::server_command(&StreamSettings::default(), false);
        assert!(command.contains("app_process / com.genymobile.scrcpy.Server 2.7 "));
        assert!(!command.contains("max_queued_frames"));
    }

    #[test]
    fn tuning_appends_its_option() {
        assert_eq!(
            codec_options(&settings(true, EncoderTuning::ConstantBitrateDropFrames)),
            " video_codec_options=latency=1,priority=0,max-bframes=0,operating-rate:float=60,bitrate-mode=3"
        );
    }
}
