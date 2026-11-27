use crate::native_video::NativeVideo;
use crate::stream_ws::VideoSocket;
use another_core::h264;
use another_core::transport::DeviceStream;
use anyhow::Result;
use base64::Engine;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use tauri::ipc::Channel;
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

const FLAG_CONFIG: u64 = 1 << 63;
const FLAG_KEY_FRAME: u64 = 1 << 62;
/// The Another server marks a config packet with every pts bit set to carry its clock instead.
const CLOCK_PTS: u64 = FLAG_KEY_FRAME - 1;
const CLOCK_PAYLOAD_SIZE: usize = 8;
/// Caps the packets kept since the last key frame, so a stream without key frames cannot grow it
/// forever. Both servers send a key frame at least every 10 s, which this covers up to 240 fps.
const MAX_KEPT_PACKETS: usize = 2400;

static RECORDING: AtomicBool = AtomicBool::new(false);
static RECORD_FEED: Mutex<Option<Weak<Mutex<RecordFeed>>>> = Mutex::new(None);

/// While on, the native renderer also sends the stream to the webview so it can be recorded there.
pub fn set_record_feed(enabled: bool) {
    RECORDING.store(enabled, Ordering::Relaxed);
    let feed = RECORD_FEED.lock().ok().and_then(|feed| feed.as_ref().and_then(Weak::upgrade));
    if let Some(feed) = feed {
        if let Ok(mut feed) = feed.lock() {
            feed.set_feeding(enabled);
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
pub enum VideoCodec {
    H264,
    H265,
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", content = "data")]
pub enum FrameEvent {
    #[serde(rename = "config")]
    Config { codec: String, description: String },
    #[serde(rename = "packet")]
    Packet {
        key: bool,
        data: String,
        timestamp: u64,
        recv_ms: f64,
        capture_ms: Option<f64>,
    },
    #[serde(rename = "record_config")]
    RecordConfig { codec: String, description: String },
    #[serde(rename = "record_packet")]
    RecordPacket { key: bool, data: String, timestamp: u64 },
    #[serde(rename = "disconnected")]
    Disconnected { reason: String },
    #[serde(rename = "native_size")]
    NativeSize { width: u32, height: u32 },
    #[serde(rename = "native_stats")]
    NativeStats {
        fps: u32,
        decode_ms: f64,
        kbps: u32,
        lag_ms: f64,
        lag_max_ms: f64,
        lag_min_ms: f64,
        screen_ms: f64,
        screen_max_ms: f64,
        arrive_ms: f64,
    },
}

/// Mirrors the native stream to the webview while a recording runs. Packets since the last key
/// frame are kept, so a recording that starts mid-stream can decode right away.
struct RecordFeed {
    channel: Channel<FrameEvent>,
    config: Option<(String, String)>,
    kept: Vec<(bool, u64, Vec<u8>)>,
    feeding: bool,
}

impl RecordFeed {
    fn register(channel: Channel<FrameEvent>) -> Arc<Mutex<Self>> {
        let feed = Arc::new(Mutex::new(Self {
            channel,
            config: None,
            kept: Vec::new(),
            feeding: RECORDING.load(Ordering::Relaxed),
        }));
        if let Ok(mut active) = RECORD_FEED.lock() {
            *active = Some(Arc::downgrade(&feed));
        }
        feed
    }

    fn set_feeding(&mut self, feeding: bool) {
        if feeding {
            self.send_config();
            for (key, pts, avcc) in &self.kept {
                send_record_packet(&self.channel, *key, *pts, avcc);
            }
        }
        self.feeding = feeding;
    }

    fn send_config(&self) {
        if let Some((codec, description)) = &self.config {
            let _ = self.channel.send(FrameEvent::RecordConfig {
                codec: codec.clone(),
                description: description.clone(),
            });
        }
    }

    fn configure(&mut self, codec: String, description: &[u8]) {
        let description = base64::engine::general_purpose::STANDARD.encode(description);
        self.config = Some((codec, description));
        self.kept.clear();
        if self.feeding {
            self.send_config();
        }
    }

    fn packet(&mut self, key: bool, pts: u64, avcc: Vec<u8>) {
        if self.feeding {
            send_record_packet(&self.channel, key, pts, &avcc);
        }
        if key || self.kept.len() >= MAX_KEPT_PACKETS {
            self.kept.clear();
        }
        if key || !self.kept.is_empty() {
            self.kept.push((key, pts, avcc));
        }
    }
}

fn send_record_packet(channel: &Channel<FrameEvent>, key: bool, pts: u64, avcc: &[u8]) {
    let _ = channel.send(FrameEvent::RecordPacket {
        key,
        data: base64::engine::general_purpose::STANDARD.encode(avcc),
        timestamp: pts,
    });
}

fn epoch_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

pub async fn stream_video(
    mut video_socket: DeviceStream,
    channel: Channel<FrameEvent>,
    mut ws: Option<VideoSocket>,
    mut native: Option<NativeVideo>,
    shutdown: Arc<Notify>,
    codec: VideoCodec,
) {
    let result = tokio::select! {
        r = forward_loop(&mut video_socket, &channel, ws.as_mut(), native.as_mut(), codec) => r,
        _ = shutdown.notified() => Ok(()),
    };
    if let Some(ws) = ws {
        ws.close().await;
    }

    if let Err(e) = result {
        let _ = channel.send(FrameEvent::Disconnected {
            reason: e.to_string(),
        });
    }
}

async fn forward_loop(
    socket: &mut DeviceStream,
    channel: &Channel<FrameEvent>,
    mut ws: Option<&mut VideoSocket>,
    mut native: Option<&mut NativeVideo>,
    codec: VideoCodec,
) -> Result<()> {
    let mut clock_offset_ms: Option<f64> = None;
    let record = native.is_some().then(|| RecordFeed::register(channel.clone()));
    loop {
        let mut header = [0u8; 12];
        socket.read_exact(&mut header).await?;

        let pts_flags = u64::from_be_bytes(header[0..8].try_into()?);
        let is_config = pts_flags & FLAG_CONFIG != 0;
        let is_key = pts_flags & FLAG_KEY_FRAME != 0;
        let pts = pts_flags & !(FLAG_CONFIG | FLAG_KEY_FRAME);

        let size = u32::from_be_bytes(header[8..12].try_into()?) as usize;
        if size == 0 {
            continue;
        }

        let mut data = vec![0u8; size];
        socket.read_exact(&mut data).await?;
        let recv_ms = epoch_ms();

        if is_config && pts == CLOCK_PTS && data.len() == CLOCK_PAYLOAD_SIZE {
            let device_us = u64::from_be_bytes(data[..CLOCK_PAYLOAD_SIZE].try_into()?);
            let offset = recv_ms - device_us as f64 / 1000.0;
            clock_offset_ms = Some(clock_offset_ms.map_or(offset, |best| best.min(offset)));
            continue;
        }
        let capture_ms = (!is_config)
            .then_some(clock_offset_ms)
            .flatten()
            .map(|offset| pts as f64 / 1000.0 + offset);

        if is_config {
            let nals = split_nals(&data);
            let (codec_str, desc) = match codec {
                VideoCodec::H264 => parse_h264_config(&nals),
                VideoCodec::H265 => parse_h265_config(&nals),
            };
            if let Some(native) = native.as_deref_mut() {
                let sets = parameter_sets(&nals, codec);
                let refs: Vec<&[u8]> = sets.iter().map(Vec::as_slice).collect();
                if let Err(e) = native.configure(codec, &refs) {
                    eprintln!("[native-video] {}", e);
                }
                if let Some(mut record) = record.as_ref().and_then(|r| r.lock().ok()) {
                    record.configure(codec_str, &desc);
                }
                continue;
            }
            if let Some(ws) = ws.as_deref_mut() {
                ws.send_config(&codec_str, &desc).await?;
                continue;
            }
            let _ = channel.send(FrameEvent::Config {
                codec: codec_str,
                description: base64::engine::general_purpose::STANDARD.encode(&desc),
            });
        } else {
            let avcc = nals_to_avcc(&data, codec);
            if let Some(native) = native.as_deref_mut() {
                if let Err(e) = native.decode(&avcc, pts, recv_ms, capture_ms) {
                    eprintln!("[native-video] {}", e);
                }
                if let Some(mut record) = record.as_ref().and_then(|r| r.lock().ok()) {
                    record.packet(is_key, pts, avcc);
                }
                continue;
            }
            if let Some(ws) = ws.as_deref_mut() {
                ws.send_packet(is_key, pts, recv_ms, capture_ms, &avcc).await?;
                continue;
            }
            let _ = channel.send(FrameEvent::Packet {
                key: is_key,
                data: base64::engine::general_purpose::STANDARD.encode(&avcc),
                timestamp: pts,
                recv_ms,
                capture_ms,
            });
        }
    }
}

fn parse_h264_config(nals: &[&[u8]]) -> (String, Vec<u8>) {
    let mut sps_list: Vec<Vec<u8>> = Vec::new();
    let mut pps_list: Vec<Vec<u8>> = Vec::new();
    let mut codec = String::from("avc1.42001e");

    for nal in nals {
        if nal.is_empty() {
            continue;
        }
        let nal_type = nal[0] & 0x1F;
        if nal_type == 7 && nal.len() >= 4 {
            codec = format!("avc1.{:02x}{:02x}{:02x}", nal[1], nal[2], nal[3]);
            sps_list.push(without_reordering(nal));
        } else if nal_type == 8 {
            pps_list.push(nal.to_vec());
        }
    }

    let sps_refs: Vec<&[u8]> = sps_list.iter().map(Vec::as_slice).collect();
    let pps_refs: Vec<&[u8]> = pps_list.iter().map(Vec::as_slice).collect();
    (codec, build_avcc(&sps_refs, &pps_refs))
}

fn parse_h265_config(nals: &[&[u8]]) -> (String, Vec<u8>) {
    let mut vps_list: Vec<&[u8]> = Vec::new();
    let mut sps_list: Vec<&[u8]> = Vec::new();
    let mut pps_list: Vec<&[u8]> = Vec::new();
    let mut codec = String::from("hev1.1.6.L93.B0");

    for nal in nals {
        if nal.len() < 2 {
            continue;
        }
        let nal_type = (nal[0] >> 1) & 0x3F;
        match nal_type {
            32 => vps_list.push(nal),
            33 => {
                if let Some(s) = build_hevc_codec_string(nal) {
                    codec = s;
                }
                sps_list.push(nal);
            }
            34 => pps_list.push(nal),
            _ => {}
        }
    }

    (codec, build_hvcc(&vps_list, &sps_list, &pps_list))
}

fn build_hevc_codec_string(sps: &[u8]) -> Option<String> {
    if sps.len() < 15 {
        return None;
    }
    let ptl = 2;
    let profile_byte = sps[ptl + 1];
    let profile_idc = profile_byte & 0x1F;
    let tier_flag = (profile_byte >> 5) & 0x01;
    let compat = u32::from_be_bytes([
        sps[ptl + 2], sps[ptl + 3],
        sps[ptl + 4], sps[ptl + 5],
    ]);
    let level_idc = sps[ptl + 12];
    let tier = if tier_flag == 1 { "H" } else { "L" };
    let constraints = &sps[ptl + 6..ptl + 12];
    let mut hex_parts: Vec<String> = constraints.iter().map(|b| format!("{:02X}", b)).collect();
    while hex_parts.last().map_or(false, |s| s == "00") && hex_parts.len() > 1 {
        hex_parts.pop();
    }
    Some(format!("hev1.{}.{:X}.{}{}.{}", profile_idc, compat, tier, level_idc, hex_parts.join("")))
}

fn build_hvcc(vps_list: &[&[u8]], sps_list: &[&[u8]], pps_list: &[&[u8]]) -> Vec<u8> {
    if sps_list.is_empty() {
        return Vec::new();
    }
    let sps = sps_list[0];
    if sps.len() < 15 {
        return Vec::new();
    }

    let ptl = 2;
    let profile_byte = sps[ptl + 1];
    let compat = &sps[ptl + 2..ptl + 6];
    let constraints = &sps[ptl + 6..ptl + 12];
    let level_idc = sps[ptl + 12];

    let mut out = Vec::new();
    out.push(1); // configurationVersion
    out.push(profile_byte); // profile_space + tier_flag + profile_idc
    out.extend_from_slice(compat); // general_profile_compatibility_flags
    out.extend_from_slice(constraints); // general_constraint_indicator_flags
    out.push(level_idc); // general_level_idc
    out.extend_from_slice(&[0xF0, 0x00]); // min_spatial_segmentation_idc (reserved + 0)
    out.push(0xFC); // parallelismType (reserved + 0)
    out.push(0xFC | 1); // chromaFormatIdc (reserved + 1 = 4:2:0)
    out.push(0xF8); // bitDepthLumaMinus8 (reserved + 0 = 8-bit)
    out.push(0xF8); // bitDepthChromaMinus8 (reserved + 0 = 8-bit)
    out.extend_from_slice(&[0x00, 0x00]); // avgFrameRate = 0
    out.push(0x03); // constantFrameRate(0) + numTemporalLayers(0) + temporalIdNested(0) + lengthSizeMinusOne(3)

    let arrays: &[(&[&[u8]], u8)] = &[
        (vps_list, 32),
        (sps_list, 33),
        (pps_list, 34),
    ];
    let num_arrays = arrays.iter().filter(|(list, _)| !list.is_empty()).count();
    out.push(num_arrays as u8);

    for (list, nal_type) in arrays {
        if list.is_empty() {
            continue;
        }
        out.push(0x80 | nal_type); // array_completeness=1 + reserved=0 + NAL_unit_type
        out.push((list.len() >> 8) as u8);
        out.push(list.len() as u8);
        for nalu in *list {
            out.push((nalu.len() >> 8) as u8);
            out.push(nalu.len() as u8);
            out.extend_from_slice(nalu);
        }
    }

    out
}

fn split_nals(data: &[u8]) -> Vec<&[u8]> {
    let mut nals = Vec::new();
    let len = data.len();
    let mut i = 0;

    let mut sc_positions: Vec<(usize, usize)> = Vec::new();
    while i + 2 < len {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            if i > 0 && data[i - 1] == 0 {
                sc_positions.push((i - 1, 4));
            } else {
                sc_positions.push((i, 3));
            }
            i += 3;
        } else {
            i += 1;
        }
    }

    for (idx, &(pos, sc_len)) in sc_positions.iter().enumerate() {
        let nal_start = pos + sc_len;
        let nal_end = if idx + 1 < sc_positions.len() {
            sc_positions[idx + 1].0
        } else {
            len
        };
        if nal_start < nal_end {
            nals.push(&data[nal_start..nal_end]);
        }
    }

    nals
}

fn build_avcc(sps_list: &[&[u8]], pps_list: &[&[u8]]) -> Vec<u8> {
    if sps_list.is_empty() {
        return Vec::new();
    }
    let sps = sps_list[0];
    let mut out = vec![
        1,
        sps[1],
        sps[2],
        sps[3],
        0xFF,
        0xE0 | sps_list.len() as u8,
    ];
    for s in sps_list {
        out.push((s.len() >> 8) as u8);
        out.push(s.len() as u8);
        out.extend_from_slice(s);
    }
    out.push(pps_list.len() as u8);
    for p in pps_list {
        out.push((p.len() >> 8) as u8);
        out.push(p.len() as u8);
        out.extend_from_slice(p);
    }
    out
}

fn parameter_sets(nals: &[&[u8]], codec: VideoCodec) -> Vec<Vec<u8>> {
    let mut sets = Vec::new();
    for nal in nals.iter().filter(|nal| !nal.is_empty()) {
        match codec {
            VideoCodec::H264 => match nal[0] & 0x1F {
                7 => sets.push(without_reordering(nal)),
                8 => sets.push(nal.to_vec()),
                _ => {}
            },
            VideoCodec::H265 => {
                if (32..=34).contains(&((nal[0] >> 1) & 0x3F)) {
                    sets.push(nal.to_vec());
                }
            }
        }
    }
    sets
}

fn without_reordering(sps: &[u8]) -> Vec<u8> {
    match h264::declare_no_reordering(sps) {
        Some(rewritten) => {
            eprintln!("[video] declared no frame reordering in the H.264 SPS");
            rewritten
        }
        None => sps.to_vec(),
    }
}

fn nals_to_avcc(data: &[u8], codec: VideoCodec) -> Vec<u8> {
    let nals = split_nals(data);
    let mut out = Vec::with_capacity(data.len());
    for nal in nals {
        let rewritten = (codec == VideoCodec::H264 && h264::is_sps(nal)).then(|| without_reordering(nal));
        let nal = rewritten.as_deref().unwrap_or(nal);
        let len = nal.len() as u32;
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(nal);
    }
    out
}
