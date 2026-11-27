use anyhow::{anyhow, Result};
use futures_util::SinkExt;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

const KIND_CONFIG: u8 = 0;
const KIND_KEY: u8 = 1;
const KIND_DELTA: u8 = 2;

pub struct WsEndpoint {
    pub url: String,
    listener: TcpListener,
    path: String,
}

pub async fn bind() -> Result<WsEndpoint> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let mut token = [0u8; 16];
    getrandom::getrandom(&mut token).map_err(|e| anyhow!("Failed to make a stream token: {}", e))?;
    let path = format!(
        "/{}",
        token.iter().map(|b| format!("{:02x}", b)).collect::<String>()
    );
    Ok(WsEndpoint {
        url: format!("ws://127.0.0.1:{}{}", port, path),
        listener,
        path,
    })
}

impl WsEndpoint {
    pub async fn accept(self, timeout: Duration) -> Result<VideoSocket> {
        tokio::time::timeout(timeout, async {
            loop {
                let (stream, _) = self.listener.accept().await?;
                stream.set_nodelay(true)?;
                let path = self.path.clone();
                let check = move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
                    if req.uri().path() == path {
                        Ok(resp)
                    } else {
                        let mut denied = ErrorResponse::new(None);
                        *denied.status_mut() = StatusCode::FORBIDDEN;
                        Err(denied)
                    }
                };
                if let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, check).await {
                    return Ok(VideoSocket { ws });
                }
            }
        })
        .await
        .map_err(|_| anyhow!("The viewer did not open the video stream"))?
    }
}

pub struct VideoSocket {
    ws: WebSocketStream<TcpStream>,
}

impl VideoSocket {
    pub async fn send_config(&mut self, codec: &str, description: &[u8]) -> Result<()> {
        let codec = codec.as_bytes();
        let mut out = Vec::with_capacity(2 + codec.len() + description.len());
        out.push(KIND_CONFIG);
        out.push(u8::try_from(codec.len())?);
        out.extend_from_slice(codec);
        out.extend_from_slice(description);
        self.send(out).await
    }

    pub async fn send_packet(
        &mut self,
        key: bool,
        pts: u64,
        recv_ms: f64,
        capture_ms: Option<f64>,
        avcc: &[u8],
    ) -> Result<()> {
        let mut out = Vec::with_capacity(25 + avcc.len());
        out.push(if key { KIND_KEY } else { KIND_DELTA });
        out.extend_from_slice(&pts.to_be_bytes());
        out.extend_from_slice(&recv_ms.to_be_bytes());
        out.extend_from_slice(&capture_ms.unwrap_or(f64::NAN).to_be_bytes());
        out.extend_from_slice(avcc);
        self.send(out).await
    }

    async fn send(&mut self, data: Vec<u8>) -> Result<()> {
        self.ws.send(Message::Binary(data.into())).await?;
        Ok(())
    }

    pub async fn close(mut self) {
        let _ = self.ws.close(None).await;
    }
}
