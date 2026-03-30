use anyhow::Result;
use byteorder::{BigEndian, WriteBytesExt};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::Mutex;

const MSG_TYPE_INJECT_KEYCODE: u8 = 0;
const MSG_TYPE_INJECT_TEXT: u8 = 1;
const MSG_TYPE_INJECT_TOUCH: u8 = 2;
const MSG_TYPE_INJECT_SCROLL: u8 = 3;
#[allow(dead_code)]
const MSG_TYPE_BACK_OR_SCREEN_ON: u8 = 4;

pub const KEYCODE_HOME: u32 = 3;
pub const KEYCODE_BACK: u32 = 4;
pub const KEYCODE_POWER: u32 = 26;
pub const KEYCODE_VOLUME_UP: u32 = 24;
pub const KEYCODE_VOLUME_DOWN: u32 = 25;
pub const KEYCODE_APP_SWITCH: u32 = 187;

const ACTION_DOWN: u8 = 0;
const ACTION_UP: u8 = 1;
const ACTION_MOVE: u8 = 2;

fn action_from_str(s: &str) -> u8 {
    match s {
        "down" => ACTION_DOWN,
        "up" => ACTION_UP,
        "move" => ACTION_MOVE,
        _ => ACTION_DOWN,
    }
}

fn build_touch_msg(action: &str, x: u32, y: u32, screen_w: u16, screen_h: u16) -> Vec<u8> {
    let mut buf: Vec<u8> = Vec::with_capacity(32);
    WriteBytesExt::write_u8(&mut buf, MSG_TYPE_INJECT_TOUCH).unwrap();
    WriteBytesExt::write_u8(&mut buf, action_from_str(action)).unwrap();
    WriteBytesExt::write_u64::<BigEndian>(&mut buf, 0xFFFFFFFFFFFFFFFF).unwrap();
    WriteBytesExt::write_u32::<BigEndian>(&mut buf, x).unwrap();
    WriteBytesExt::write_u32::<BigEndian>(&mut buf, y).unwrap();
    WriteBytesExt::write_u16::<BigEndian>(&mut buf, screen_w).unwrap();
    WriteBytesExt::write_u16::<BigEndian>(&mut buf, screen_h).unwrap();
    let pressure: u16 = if action == "up" { 0 } else { 0xFFFF };
    WriteBytesExt::write_u16::<BigEndian>(&mut buf, pressure).unwrap();
    WriteBytesExt::write_u32::<BigEndian>(&mut buf, 1).unwrap();
    WriteBytesExt::write_u32::<BigEndian>(&mut buf, 1).unwrap();
    buf
}

pub async fn inject_touch(
    socket: &Mutex<TcpStream>,
    action: &str,
    x: u32,
    y: u32,
    screen_w: u16,
    screen_h: u16,
) -> Result<()> {
    let buf = build_touch_msg(action, x, y, screen_w, screen_h);
    let mut stream = socket.lock().await;
    stream.write_all(&buf).await?;
    Ok(())
}

pub async fn inject_keycode(
    socket: &Mutex<TcpStream>,
    action: &str,
    keycode: u32,
    repeat: u32,
    metastate: u32,
) -> Result<()> {
    let mut buf: Vec<u8> = Vec::with_capacity(14);
    WriteBytesExt::write_u8(&mut buf, MSG_TYPE_INJECT_KEYCODE).unwrap();
    WriteBytesExt::write_u8(&mut buf, action_from_str(action)).unwrap();
    WriteBytesExt::write_u32::<BigEndian>(&mut buf, keycode).unwrap();
    WriteBytesExt::write_u32::<BigEndian>(&mut buf, repeat).unwrap();
    WriteBytesExt::write_u32::<BigEndian>(&mut buf, metastate).unwrap();

    let mut stream = socket.lock().await;
    stream.write_all(&buf).await?;
    Ok(())
}

pub async fn inject_text(socket: &Mutex<TcpStream>, text: &str) -> Result<()> {
    let bytes = text.as_bytes();
    let mut buf: Vec<u8> = Vec::with_capacity(5 + bytes.len());
    WriteBytesExt::write_u8(&mut buf, MSG_TYPE_INJECT_TEXT).unwrap();
    WriteBytesExt::write_u32::<BigEndian>(&mut buf, bytes.len() as u32).unwrap();
    std::io::Write::write_all(&mut buf, bytes).unwrap();

    let mut stream = socket.lock().await;
    stream.write_all(&buf).await?;
    Ok(())
}

pub async fn inject_scroll(
    socket: &Mutex<TcpStream>,
    x: u32,
    y: u32,
    screen_w: u16,
    screen_h: u16,
    scroll_x: i16,
    scroll_y: i16,
) -> Result<()> {
    let mut buf: Vec<u8> = Vec::with_capacity(21);
    WriteBytesExt::write_u8(&mut buf, MSG_TYPE_INJECT_SCROLL).unwrap();
    WriteBytesExt::write_u32::<BigEndian>(&mut buf, x).unwrap();
    WriteBytesExt::write_u32::<BigEndian>(&mut buf, y).unwrap();
    WriteBytesExt::write_u16::<BigEndian>(&mut buf, screen_w).unwrap();
    WriteBytesExt::write_u16::<BigEndian>(&mut buf, screen_h).unwrap();
    WriteBytesExt::write_i16::<BigEndian>(&mut buf, scroll_x).unwrap();
    WriteBytesExt::write_i16::<BigEndian>(&mut buf, scroll_y).unwrap();
    WriteBytesExt::write_u32::<BigEndian>(&mut buf, 0).unwrap();

    let mut stream = socket.lock().await;
    stream.write_all(&buf).await?;
    Ok(())
}
