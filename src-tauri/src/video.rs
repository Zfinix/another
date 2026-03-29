use anyhow::Result;
use base64::Engine;
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;
use tokio::sync::Notify;

const FLAG_CONFIG: u64 = 1 << 63;
const FLAG_KEY_FRAME: u64 = 1 << 62;

#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", content = "data")]
pub enum FrameEvent {
    #[serde(rename = "config")]
    Config { codec: String, description: String },
    #[serde(rename = "packet")]
    Packet { key: bool, data: String, timestamp: u64 },
    #[serde(rename = "disconnected")]
    Disconnected { reason: String },
}

pub async fn stream_video(
    mut video_socket: TcpStream,
    channel: Channel<FrameEvent>,
    shutdown: Arc<Notify>,
) {
    let result = tokio::select! {
        r = forward_loop(&mut video_socket, &channel) => r,
        _ = shutdown.notified() => Ok(()),
    };

    if let Err(e) = result {
        let _ = channel.send(FrameEvent::Disconnected {
            reason: e.to_string(),
        });
    }
}

async fn forward_loop(
    socket: &mut TcpStream,
    channel: &Channel<FrameEvent>,
) -> Result<()> {
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

        if is_config {
            let nals = split_nals(&data);
            let mut sps_list: Vec<&[u8]> = Vec::new();
            let mut pps_list: Vec<&[u8]> = Vec::new();
            let mut codec = String::from("avc1.42001e");

            for nal in &nals {
                if nal.is_empty() {
                    continue;
                }
                let nal_type = nal[0] & 0x1F;
                if nal_type == 7 && nal.len() >= 4 {
                    codec = format!("avc1.{:02x}{:02x}{:02x}", nal[1], nal[2], nal[3]);
                    sps_list.push(nal);
                } else if nal_type == 8 {
                    pps_list.push(nal);
                }
            }

            let desc = build_avcc(&sps_list, &pps_list);
            let _ = channel.send(FrameEvent::Config {
                codec,
                description: base64::engine::general_purpose::STANDARD.encode(&desc),
            });
        } else {
            let avcc = nals_to_avcc(&data);
            let _ = channel.send(FrameEvent::Packet {
                key: is_key,
                data: base64::engine::general_purpose::STANDARD.encode(&avcc),
                timestamp: pts,
            });
        }
    }
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

fn nals_to_avcc(data: &[u8]) -> Vec<u8> {
    let nals = split_nals(data);
    let mut out = Vec::with_capacity(data.len());
    for nal in nals {
        let len = nal.len() as u32;
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(nal);
    }
    out
}
