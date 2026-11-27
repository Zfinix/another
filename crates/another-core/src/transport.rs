use anyhow::{anyhow, Result};
use libadb::channel::ChannelId;
use libadb::keys::rsa::rand_core::OsRng;
use libadb::keys::{store, KeyName};
use libadb::sync::FileMode;
use libadb::{Connection, ConnectionConfig, HostBanner, Splittable, TokioTcp};
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::task::JoinHandle;

pub trait DeviceIo: AsyncRead + AsyncWrite + Send + Unpin {}

impl<T: AsyncRead + AsyncWrite + Send + Unpin> DeviceIo for T {}

pub type DeviceStream = Box<dyn DeviceIo>;

type AdbWriter = libadb::Writer<<TokioTcp as Splittable>::WriteHalf>;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const EXEC_BUF: usize = 64 * 1024;
const BRIDGE_BUF: usize = 64 * 1024;
const BRIDGE_PIPE: usize = 1 << 20;

pub fn direct_address(serial: &str) -> Option<String> {
    if let Some(n) = serial.strip_prefix("emulator-") {
        let console: u16 = n.parse().ok()?;
        return Some(format!("127.0.0.1:{}", console.checked_add(1)?));
    }
    let (host, port) = serial.rsplit_once(':')?;
    port.parse::<u16>().ok()?;
    if host.is_empty() || host.contains(char::is_whitespace) {
        return None;
    }
    Some(serial.to_string())
}

fn adb_key_dir() -> Result<PathBuf> {
    if let Ok(dir) = std::env::var("ANDROID_USER_HOME") {
        return Ok(PathBuf::from(dir));
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| anyhow!("Cannot locate the .android key directory"))?;
    Ok(PathBuf::from(home).join(".android"))
}

fn adb_err<E: std::fmt::Display>(err: libadb::Error<E>) -> anyhow::Error {
    anyhow!("adb: {}", err)
}

pub struct DirectDevice {
    writer: AdbWriter,
    reader: JoinHandle<()>,
    bridges: Vec<JoinHandle<()>>,
}

impl DirectDevice {
    pub async fn connect(address: &str) -> Result<Self> {
        let key = store::load_or_generate(
            &adb_key_dir()?,
            &mut OsRng,
            KeyName::new("another").map_err(|e| anyhow!("{:?}", e))?,
        )
        .map_err(|e| anyhow!("Failed to load adb key: {:?}", e))?;

        let tcp = tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::TcpStream::connect(address))
            .await
            .map_err(|_| anyhow!("Timed out connecting to {}", address))??;
        tcp.set_nodelay(true)?;

        let conn = tokio::time::timeout(
            CONNECT_TIMEOUT,
            Connection::connect(TokioTcp::new(tcp), key, HostBanner::default(), ConnectionConfig::new()),
        )
        .await
        .map_err(|_| anyhow!("Timed out authenticating with {}", address))?
        .map_err(adb_err)?;

        let (reader, writer) = conn.split().map_err(adb_err)?;
        let reader = tokio::spawn(async move {
            let Err(e) = reader.run().await;
            eprintln!("[adb-direct] connection ended: {}", e);
        });

        Ok(Self {
            writer,
            reader,
            bridges: Vec::new(),
        })
    }

    pub async fn exec(&self, command: &str) -> Result<String> {
        let mut writer = self.writer.clone();
        let mut buf = vec![0u8; EXEC_BUF];
        let n = libadb::exec::exec(&mut writer, command, &mut buf)
            .await
            .map_err(adb_err)?;
        Ok(String::from_utf8_lossy(&buf[..n]).to_string())
    }

    pub async fn push(&self, local: &str, remote: &str) -> Result<()> {
        let data = tokio::fs::read(local).await?;
        let mtime = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as u32)
            .unwrap_or(0);
        let mut writer = self.writer.clone();
        let mut buf = vec![0u8; EXEC_BUF];
        let mut sync = libadb::sync::open(&mut writer, &mut buf)
            .await
            .map_err(adb_err)?;
        sync.send(remote, FileMode(0o100644), mtime, &data)
            .await
            .map_err(adb_err)?;
        sync.quit().await.map_err(adb_err)
    }

    pub async fn open_stream(&mut self, destination: &str) -> Result<DeviceStream> {
        let ch = self.open_channel(destination).await?;
        let (stream, task) = bridge(self.writer.clone(), ch);
        self.bridges.push(task);
        Ok(stream)
    }

    pub async fn spawn_logged(&mut self, command: &str, tag: &'static str) -> Result<()> {
        let ch = self.open_channel(&format!("shell:{}", command)).await?;
        let writer = self.writer.clone();
        self.bridges.push(tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            let mut pending = String::new();
            while let Ok(n) = writer.read_channel(ch, &mut buf).await {
                pending.push_str(&String::from_utf8_lossy(&buf[..n]));
                while let Some(end) = pending.find('\n') {
                    eprintln!("[{}] {}", tag, pending[..end].trim_end());
                    pending.drain(..=end);
                }
            }
            let _ = writer.close_channel(ch).await;
        }));
        Ok(())
    }

    async fn open_channel(&self, destination: &str) -> Result<ChannelId> {
        let mut dest = destination.as_bytes().to_vec();
        dest.push(0);
        self.writer.open_channel(&dest).await.map_err(adb_err)
    }

    pub fn close(&mut self) {
        for task in self.bridges.drain(..) {
            task.abort();
        }
        self.reader.abort();
    }
}

impl Drop for DirectDevice {
    fn drop(&mut self) {
        self.close();
    }
}

fn bridge(writer: AdbWriter, ch: ChannelId) -> (DeviceStream, JoinHandle<()>) {
    let (near, far) = tokio::io::duplex(BRIDGE_PIPE);
    let (mut far_read, mut far_write) = tokio::io::split(far);

    let task = tokio::spawn(async move {
        let inbound = async {
            let mut buf = vec![0u8; BRIDGE_BUF];
            while let Ok(n) = writer.read_channel(ch, &mut buf).await {
                if far_write.write_all(&buf[..n]).await.is_err() {
                    break;
                }
            }
            let _ = far_write.shutdown().await;
        };
        let outbound = async {
            let mut buf = vec![0u8; BRIDGE_BUF];
            loop {
                match far_read.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if writer.write_channel(ch, &buf[..n]).await.is_err() {
                            break;
                        }
                    }
                }
            }
        };
        tokio::select! {
            _ = inbound => {}
            _ = outbound => {}
        }
        let _ = writer.close_channel(ch).await;
    });

    (Box::new(near), task)
}

#[cfg(test)]
mod tests {
    use super::direct_address;

    #[test]
    fn emulator_serial_maps_to_adb_port() {
        assert_eq!(direct_address("emulator-5554").as_deref(), Some("127.0.0.1:5555"));
    }

    #[test]
    fn network_serials_are_used_as_is() {
        assert_eq!(direct_address("192.168.1.20:5555").as_deref(), Some("192.168.1.20:5555"));
        assert_eq!(direct_address("100.101.102.103:5555").as_deref(), Some("100.101.102.103:5555"));
        assert_eq!(direct_address("pixel.tail1234.ts.net:5555").as_deref(), Some("pixel.tail1234.ts.net:5555"));
    }

    #[test]
    fn usb_and_mdns_serials_need_the_adb_server() {
        assert_eq!(direct_address("R5CT1234ABC"), None);
        assert_eq!(direct_address("adb-R5CT1234ABC-xyz._adb-tls-connect._tcp"), None);
        assert_eq!(direct_address("emulator-abc"), None);
    }
}
