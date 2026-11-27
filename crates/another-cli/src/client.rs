use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

const APP_IDENTIFIER: &str = "com.chizi.another";
const TOKEN_HEADER: &str = "X-Another-Token";
const READ_TIMEOUT: Duration = Duration::from_secs(330);

/// Talks to the control API of a running Another, found through the control file it writes.
pub struct Client {
    port: u16,
    token: String,
}

impl Client {
    pub fn from_control_file() -> Result<Self> {
        let path = control_file()?;
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("Another does not seem to be running ({} is missing)", path.display()))?;
        let value: Value = serde_json::from_str(&text).context("reading the control file")?;
        let port = value["port"]
            .as_u64()
            .and_then(|p| u16::try_from(p).ok())
            .ok_or_else(|| anyhow!("The control file has no port"))?;
        let token = value["token"]
            .as_str()
            .ok_or_else(|| anyhow!("The control file has no token"))?
            .to_string();
        Ok(Self { port, token })
    }

    pub fn get(&self, path: &str) -> Result<Value> {
        self.request("GET", path, None)
    }

    pub fn post(&self, path: &str, body: &Value) -> Result<Value> {
        self.request("POST", path, Some(body.to_string()))
    }

    fn request(&self, method: &str, path: &str, body: Option<String>) -> Result<Value> {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port))
            .with_context(|| format!("Could not reach Another on port {}; is it running?", self.port))?;
        stream.set_read_timeout(Some(READ_TIMEOUT))?;
        let body = body.unwrap_or_default();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{TOKEN_HEADER}: {token}\r\nContent-Type: application/json\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n{body}",
            token = self.token,
            length = body.len(),
        );
        stream.write_all(request.as_bytes())?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response)?;
        let response = String::from_utf8_lossy(&response);
        let (head, payload) = response
            .split_once("\r\n\r\n")
            .ok_or_else(|| anyhow!("Malformed response from Another"))?;
        let status: u16 = head
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .ok_or_else(|| anyhow!("Malformed status line from Another"))?;
        let value: Value = if payload.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(payload).with_context(|| format!("Unexpected reply: {}", payload))?
        };
        if !(200..300).contains(&status) {
            let message = value["error"].as_str().unwrap_or(payload).to_string();
            bail!("Another refused the request ({}): {}", status, message);
        }
        Ok(value)
    }
}

fn control_file() -> Result<PathBuf> {
    let base = dirs::data_dir().ok_or_else(|| anyhow!("Could not find the app data directory"))?;
    Ok(base.join(APP_IDENTIFIER).join("control.json"))
}
