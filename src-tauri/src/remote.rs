//! Local control API for the `another` CLI and `another://` deep links.
//!
//! The server listens on loopback only and every request must carry the token written to
//! `control.json` in the app data directory, so other users, other machines and web pages cannot
//! drive the app. Commands are handed to the UI as events; the UI reports its state back.

use anyhow::{anyhow, Result};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub const COMMAND_EVENT: &str = "remote-command";
pub const TOKEN_HEADER: &str = "x-another-token";
const PREFERRED_PORT: u16 = 7071;
const MAX_SAMPLES: usize = 900;
const MAX_STATS_SECONDS: u64 = 300;
const PROBE_TIMEOUT: Duration = Duration::from_secs(90);
const PROBE_POLL: Duration = Duration::from_millis(250);

#[derive(Default)]
pub struct RemoteState {
    ui: Mutex<Option<Value>>,
    samples: Mutex<VecDeque<(Instant, Value)>>,
    probe: Mutex<Option<(Instant, Value)>>,
    pending: Mutex<Vec<Value>>,
}

impl RemoteState {
    pub fn record_perf(&self, stats: &Value) {
        let now = Instant::now();
        if stats.get("latencyProbe").is_some() {
            if let Ok(mut probe) = self.probe.lock() {
                *probe = Some((now, stats.clone()));
            }
            return;
        }
        if let Ok(mut samples) = self.samples.lock() {
            samples.push_back((now, stats.clone()));
            while samples.len() > MAX_SAMPLES {
                samples.pop_front();
            }
        }
    }

    pub fn set_ui(&self, state: Value) {
        if let Ok(mut ui) = self.ui.lock() {
            *ui = Some(state);
        }
    }

    pub fn take_pending(&self) -> Vec<Value> {
        self.pending.lock().map(|mut p| std::mem::take(&mut *p)).unwrap_or_default()
    }

    fn ui_ready(&self) -> bool {
        self.ui.lock().map(|ui| ui.is_some()).unwrap_or(false)
    }
}

/// Hands a command to the UI, or keeps it until the UI has started and asks for it.
pub fn dispatch(app: &AppHandle, command: Value) {
    let state = app.state::<Arc<RemoteState>>();
    if state.ui_ready() {
        let _ = app.emit(COMMAND_EVENT, command);
    } else if let Ok(mut pending) = state.pending.lock() {
        pending.push(command);
    }
}

#[derive(Clone)]
struct Server {
    app: AppHandle,
    state: Arc<RemoteState>,
    token: Arc<String>,
}

pub fn start(app: AppHandle, state: Arc<RemoteState>) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = serve(app, state).await {
            eprintln!("[remote] control API stopped: {}", e);
        }
    });
}

async fn serve(app: AppHandle, state: Arc<RemoteState>) -> Result<()> {
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).await {
        Ok(listener) => listener,
        Err(_) => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?,
    };
    let port = listener.local_addr()?.port();
    let token = random_token()?;
    write_control_file(&app, port, &token)?;
    eprintln!("[remote] control API on 127.0.0.1:{}", port);

    let server = Server {
        app,
        state,
        token: Arc::new(token),
    };
    let router = Router::new()
        .route("/status", get(status))
        .route("/command", post(command))
        .route("/stats", get(stats))
        .route("/measure", post(measure))
        .with_state(server);
    axum::serve(listener, router).await?;
    Ok(())
}

fn random_token() -> Result<String> {
    let mut bytes = [0u8; 24];
    getrandom::getrandom(&mut bytes).map_err(|e| anyhow!("Could not make a control token: {}", e))?;
    Ok(bytes.iter().map(|b| format!("{:02x}", b)).collect())
}

fn write_control_file(app: &AppHandle, port: u16, token: &str) -> Result<()> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("control.json");
    let body = json!({ "port": port, "token": token, "pid": std::process::id() }).to_string();
    std::fs::write(&path, body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn authorize(server: &Server, headers: &HeaderMap) -> Result<(), (StatusCode, Json<Value>)> {
    let given = headers.get(TOKEN_HEADER).and_then(|v| v.to_str().ok());
    if given == Some(server.token.as_str()) {
        Ok(())
    } else {
        Err((StatusCode::UNAUTHORIZED, Json(json!({ "error": "Missing or wrong control token" }))))
    }
}

type Reply = Result<Json<Value>, (StatusCode, Json<Value>)>;

fn bad_request(message: impl Into<String>) -> (StatusCode, Json<Value>) {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message.into() })))
}

async fn status(State(server): State<Server>, headers: HeaderMap) -> Reply {
    authorize(&server, &headers)?;
    let ui = server.state.ui.lock().ok().and_then(|ui| ui.clone()).unwrap_or(Value::Null);
    Ok(Json(json!({ "version": server.app.package_info().version.to_string(), "ui": ui })))
}

async fn command(State(server): State<Server>, headers: HeaderMap, Json(body): Json<Value>) -> Reply {
    authorize(&server, &headers)?;
    let command = normalize_command(body).map_err(|e| bad_request(e.to_string()))?;
    dispatch(&server.app, command.clone());
    Ok(Json(json!({ "accepted": command })))
}

/// Checks a command before it reaches the UI, so a typo fails in the CLI instead of silently.
pub fn normalize_command(body: Value) -> Result<Value> {
    let action = body
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("A command needs an 'action'"))?;
    match action {
        "apply" => {
            let profile = body.get("profile").ok_or_else(|| anyhow!("'apply' needs a 'profile'"))?;
            let profile = another_core::profile::validate(profile)?;
            let mut command = json!({ "action": "apply", "profile": profile });
            if let Some(serial) = body.get("connect").and_then(Value::as_str) {
                command["connect"] = json!(serial);
            }
            Ok(command)
        }
        "connect" => {
            let serial = body
                .get("serial")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow!("'connect' needs a 'serial'"))?;
            Ok(json!({ "action": "connect", "serial": serial }))
        }
        "disconnect" => {
            let mut command = json!({ "action": "disconnect" });
            if let Some(serial) = body.get("serial").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                command["serial"] = json!(serial);
            }
            Ok(command)
        }
        other => Err(anyhow!("Unknown action '{}'", other)),
    }
}

#[derive(Deserialize)]
struct StatsQuery {
    seconds: Option<u64>,
}

async fn stats(State(server): State<Server>, headers: HeaderMap, Query(query): Query<StatsQuery>) -> Reply {
    authorize(&server, &headers)?;
    let seconds = query.seconds.unwrap_or(10).clamp(1, MAX_STATS_SECONDS);
    let started = Instant::now();
    tokio::time::sleep(Duration::from_secs(seconds)).await;
    let samples: Vec<Value> = server
        .state
        .samples
        .lock()
        .map(|samples| {
            samples
                .iter()
                .filter(|(at, _)| *at >= started)
                .map(|(_, value)| value.clone())
                .collect()
        })
        .unwrap_or_default();
    Ok(Json(summarize(&samples, seconds)))
}

async fn measure(State(server): State<Server>, headers: HeaderMap) -> Reply {
    authorize(&server, &headers)?;
    let started = Instant::now();
    dispatch(&server.app, json!({ "action": "measure" }));
    loop {
        if let Some(result) = server
            .state
            .probe
            .lock()
            .ok()
            .and_then(|probe| probe.clone())
            .filter(|(at, _)| *at >= started)
        {
            return Ok(Json(result.1));
        }
        if started.elapsed() > PROBE_TIMEOUT {
            return Err((StatusCode::GATEWAY_TIMEOUT, Json(json!({ "error": "The latency probe did not finish" }))));
        }
        tokio::time::sleep(PROBE_POLL).await;
    }
}

const FIELD_ALIASES: &[(&str, &[&str])] = &[
    ("fps", &["fps", "renderFps"]),
    ("screen_ms", &["screen_ms", "screenMs"]),
    ("arrive_ms", &["arrive_ms"]),
    ("decode_ms", &["decode_ms", "decodeMs"]),
    ("lag_ms", &["lag_ms", "deviceLagMs"]),
    ("kbps", &["kbps", "bitrateKbps"]),
];

/// Averages the per-second samples the UI logged, using whichever field name each renderer uses.
/// Zero means "not measured" (no clock from the server, say), so zeros are left out of averages.
pub fn summarize(samples: &[Value], seconds: u64) -> Value {
    let mut out = json!({ "seconds": seconds, "samples": samples.len() });
    for (name, aliases) in FIELD_ALIASES {
        let values: Vec<f64> = samples
            .iter()
            .filter_map(|sample| aliases.iter().find_map(|alias| sample.get(*alias).and_then(Value::as_f64)))
            .filter(|value| *value > 0.0)
            .collect();
        if !values.is_empty() {
            out[*name] = json!(values.iter().sum::<f64>() / values.len() as f64);
        }
    }
    let screen_max = samples
        .iter()
        .filter_map(|sample| sample.get("screen_max_ms").or_else(|| sample.get("screenMaxMs")).and_then(Value::as_f64))
        .fold(0.0_f64, f64::max);
    if screen_max > 0.0 {
        out["screen_max_ms"] = json!(screen_max);
    }
    if let Some(renderer) = samples.iter().rev().find_map(|s| s.get("renderer").and_then(Value::as_str)) {
        out["renderer"] = json!(renderer);
    } else if !samples.is_empty() {
        out["renderer"] = json!("web");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarize_merges_native_and_web_field_names() {
        let samples = vec![
            json!({ "renderer": "native", "fps": 60, "screen_ms": 40.0, "screen_max_ms": 55.0, "kbps": 8000 }),
            json!({ "renderFps": 30, "screenMs": 20.0, "screenMaxMs": 70.0, "bitrateKbps": 4000 }),
        ];
        let summary = summarize(&samples, 5);
        assert_eq!(summary["samples"], 2);
        assert_eq!(summary["fps"], 45.0);
        assert_eq!(summary["screen_ms"], 30.0);
        assert_eq!(summary["screen_max_ms"], 70.0);
        assert_eq!(summary["kbps"], 6000.0);
    }

    #[test]
    fn summarize_skips_unmeasured_zeros() {
        let samples = vec![json!({ "fps": 60, "screen_ms": 0.0 }), json!({ "fps": 60, "screen_ms": 30.0 })];
        assert_eq!(summarize(&samples, 2)["screen_ms"], 30.0);
    }

    #[test]
    fn commands_are_checked_before_reaching_the_ui() {
        assert!(normalize_command(json!({ "action": "launch" })).is_err());
        assert!(normalize_command(json!({ "action": "connect" })).is_err());
        assert!(normalize_command(json!({ "action": "apply", "profile": { "stream": { "nope": 1 } } })).is_err());
        let apply = normalize_command(json!({
            "action": "apply",
            "profile": { "dev": { "nativeVideo": true } },
            "connect": "ABC"
        }))
        .unwrap();
        assert_eq!(apply["profile"]["dev"]["nativeVideo"], true);
        assert_eq!(apply["connect"], "ABC");
    }
}
