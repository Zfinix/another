pub mod server;

use std::sync::Arc;
use anyhow::Result;
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use tokio_util::sync::CancellationToken;

pub async fn start_sse_server(
    port: u16,
    scrcpy_server_path: Option<String>,
    cancel: CancellationToken,
) -> Result<()> {
    let config = StreamableHttpServerConfig::default()
        .with_cancellation_token(cancel.child_token());

    let service = StreamableHttpService::new(
        move || Ok(server::AnotherMcp::new(scrcpy_server_path.clone())),
        Arc::new(LocalSessionManager::default()),
        config,
    );

    let router = axum::Router::new().nest_service("/mcp", service);

    let addr = format!("127.0.0.1:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;

    eprintln!("[mcp] SSE server listening on http://{}/mcp", listener.local_addr()?);

    let ct = cancel.clone();
    axum::serve(listener, router)
        .with_graceful_shutdown(async move { ct.cancelled().await })
        .await?;

    Ok(())
}
