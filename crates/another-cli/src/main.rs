mod client;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use clap::{Parser, Subcommand};
use client::Client;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(40);
const POLL: Duration = Duration::from_millis(400);

#[derive(Parser)]
#[command(name = "another", bin_name = "another", version, about = "Drive the Another app from the terminal")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Show the phones being mirrored, their stream state and the current profile
    Status,
    /// List the devices Another can see
    Devices,
    /// Mirror a device by serial, in its own window
    Connect { serial: String },
    /// Stop mirroring one device, or every device when no serial is given
    Disconnect { serial: Option<String> },
    /// Change settings, such as `another set max_size=1920 native_video=true`
    Set {
        #[arg(required = true, value_name = "KEY=VALUE")]
        assignments: Vec<String>,
        /// Connect to this device after applying
        #[arg(long)]
        connect: Option<String>,
    },
    /// List the setting keys `set` accepts
    Keys,
    /// Save, apply or share profiles
    Profile {
        #[command(subcommand)]
        command: ProfileCommand,
    },
    /// Average the live performance stats over a number of seconds
    Stats {
        #[arg(long, default_value_t = 10)]
        seconds: u64,
    },
    /// Run the touch-to-screen latency probe
    Measure,
    /// Apply each profile in turn, let it settle, and compare the stats
    Bench {
        #[arg(required = true)]
        profiles: Vec<PathBuf>,
        #[arg(long, default_value_t = 15)]
        seconds: u64,
        #[arg(long, default_value_t = 5)]
        warmup: u64,
        /// Device to use; defaults to the one connected now
        #[arg(long)]
        connect: Option<String>,
    },
    /// Start Another (or reuse the running one) with a profile and a device
    Launch {
        #[arg(long)]
        profile: Option<PathBuf>,
        #[arg(long)]
        connect: Option<String>,
        /// Path to the Another executable or .app bundle
        #[arg(long)]
        app: Option<PathBuf>,
    },
}

#[derive(Subcommand)]
enum ProfileCommand {
    /// Print the current profile, or write it to a file
    Export {
        #[arg(short, long)]
        out: Option<PathBuf>,
    },
    /// Apply a profile file
    Apply {
        file: PathBuf,
        #[arg(long)]
        connect: Option<String>,
    },
    /// Print an another:// link that applies a profile file
    Link {
        file: PathBuf,
        #[arg(long)]
        connect: Option<String>,
    },
}

fn main() {
    if let Err(e) = run(Cli::parse()) {
        eprintln!("another: {:#}", e);
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Command::Keys => {
            for key in another_core::profile::known_keys() {
                println!("{}", key);
            }
            Ok(())
        }
        Command::Profile {
            command: ProfileCommand::Link { file, connect },
        } => {
            let profile = read_profile(&file)?;
            let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(profile.to_string());
            let mut link = format!("another://apply?profile={}", encoded);
            if let Some(serial) = connect {
                link.push_str(&format!("&connect={}", serial));
            }
            println!("{}", link);
            Ok(())
        }
        Command::Launch { profile, connect, app } => launch(profile, connect, app),
        command => {
            let client = Client::from_control_file()?;
            run_connected(&client, command)
        }
    }
}

fn run_connected(client: &Client, command: Command) -> Result<()> {
    match command {
        Command::Status => print_json(&client.get("/status")?),
        Command::Devices => {
            let status = client.get("/status")?;
            let mirroring = sessions(&status["ui"]);
            for device in status["ui"]["devices"].as_array().cloned().unwrap_or_default() {
                let serial = device["serial"].as_str().unwrap_or_default();
                let marker = if mirroring.iter().any(|session| session["serial"].as_str() == Some(serial)) { "*" } else { " " };
                println!("{} {:<24} {:<24} {}", marker, serial, device["model"].as_str().unwrap_or_default(), device["state"].as_str().unwrap_or_default());
            }
            Ok(())
        }
        Command::Connect { serial } => {
            client.post("/command", &json!({ "action": "connect", "serial": serial }))?;
            wait_until_streaming(client, Some(&serial))?;
            println!("Connected to {}", serial);
            Ok(())
        }
        Command::Disconnect { serial } => {
            let mut command = json!({ "action": "disconnect" });
            if let Some(serial) = serial {
                command["serial"] = json!(serial);
            }
            client.post("/command", &command)?;
            Ok(())
        }
        Command::Set { assignments, connect } => {
            let pairs = assignments
                .iter()
                .map(|item| item.split_once('=').ok_or_else(|| anyhow!("'{}' is not KEY=VALUE", item)))
                .collect::<Result<Vec<_>>>()?;
            let profile = another_core::profile::from_assignments(pairs)?;
            apply(client, &profile, connect.as_deref())
        }
        Command::Profile { command } => match command {
            ProfileCommand::Export { out } => {
                let profile = client.get("/status")?["ui"]["profile"].clone();
                if profile.is_null() {
                    bail!("Another has not reported its settings yet");
                }
                let text = serde_json::to_string_pretty(&profile)?;
                match out {
                    Some(path) => std::fs::write(&path, text + "\n").with_context(|| format!("writing {}", path.display())),
                    None => {
                        println!("{}", text);
                        Ok(())
                    }
                }
            }
            ProfileCommand::Apply { file, connect } => apply(client, &read_profile(&file)?, connect.as_deref()),
            ProfileCommand::Link { .. } => unreachable!("handled without a client"),
        },
        Command::Stats { seconds } => print_json(&client.get(&format!("/stats?seconds={}", seconds))?),
        Command::Measure => print_json(&client.post("/measure", &json!({}))?),
        Command::Bench { profiles, seconds, warmup, connect } => bench(client, &profiles, seconds, warmup, connect),
        Command::Keys | Command::Launch { .. } => unreachable!("handled without a client"),
    }
}

fn print_json(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn read_profile(path: &Path) -> Result<Value> {
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let value: Value = serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
    another_core::profile::validate(&value).with_context(|| format!("checking {}", path.display()))
}

fn apply(client: &Client, profile: &Value, connect: Option<&str>) -> Result<()> {
    let mut command = json!({ "action": "apply", "profile": profile });
    if let Some(serial) = connect {
        command["connect"] = json!(serial);
    }
    client.post("/command", &command)?;
    Ok(())
}

/// The phones being mirrored. Older apps report one `connected` phone instead of a list.
fn sessions(ui: &Value) -> Vec<Value> {
    if let Some(list) = ui["sessions"].as_array() {
        return list.clone();
    }
    ui["connected"]
        .as_str()
        .map(|serial| vec![json!({ "serial": serial, "streamReady": ui["streamReady"] })])
        .unwrap_or_default()
}

/// Waits for the UI to show a live stream, after the reconnect a profile change triggers.
fn wait_until_streaming(client: &Client, serial: Option<&str>) -> Result<()> {
    std::thread::sleep(Duration::from_millis(1200));
    let started = Instant::now();
    loop {
        let ui = client.get("/status")?["ui"].clone();
        let streaming = sessions(&ui).into_iter().any(|session| {
            session["streamReady"].as_bool() == Some(true) && serial.is_none_or(|s| session["serial"].as_str() == Some(s))
        });
        if streaming {
            return Ok(());
        }
        if started.elapsed() > CONNECT_TIMEOUT {
            bail!("The stream did not start within {}s", CONNECT_TIMEOUT.as_secs());
        }
        std::thread::sleep(POLL);
    }
}

fn bench(client: &Client, profiles: &[PathBuf], seconds: u64, warmup: u64, connect: Option<String>) -> Result<()> {
    let serial = match connect {
        Some(serial) => serial,
        None => client.get("/status")?["ui"]["connected"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| anyhow!("No device is connected; pass --connect <serial>"))?,
    };
    let mut rows = Vec::new();
    for path in profiles {
        let mut profile = read_profile(path)?;
        profile["dev"]["perfOverlay"] = json!(true);
        let name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        eprintln!("[{}] applying", name);
        apply(client, &profile, Some(&serial))?;
        wait_until_streaming(client, Some(&serial))?;
        eprintln!("[{}] streaming, warming up {}s, measuring {}s", name, warmup, seconds);
        std::thread::sleep(Duration::from_secs(warmup));
        let stats = client.get(&format!("/stats?seconds={}", seconds))?;
        rows.push((name, stats));
    }
    print_table(&rows);
    Ok(())
}

fn print_table(rows: &[(String, Value)]) {
    let cell = |stats: &Value, key: &str, digits: usize| {
        stats[key].as_f64().map_or_else(|| "-".to_string(), |v| format!("{:.*}", digits, v))
    };
    println!(
        "{:<28} {:<8} {:>6} {:>16} {:>8} {:>10} {:>9} {:>8} {:>8}",
        "profile", "renderer", "fps", "capture→screen", "max", "→arrival", "decode", "lag", "Mbps"
    );
    for (name, stats) in rows {
        let mbps = stats["kbps"].as_f64().map_or_else(|| "-".to_string(), |k| format!("{:.1}", k / 1000.0));
        println!(
            "{:<28} {:<8} {:>6} {:>16} {:>8} {:>10} {:>9} {:>8} {:>8}",
            name,
            stats["renderer"].as_str().unwrap_or("-"),
            cell(stats, "fps", 0),
            cell(stats, "screen_ms", 1),
            cell(stats, "screen_max_ms", 0),
            cell(stats, "arrive_ms", 1),
            cell(stats, "decode_ms", 1),
            cell(stats, "lag_ms", 1),
            mbps,
        );
    }
}

fn launch(profile: Option<PathBuf>, connect: Option<String>, app: Option<PathBuf>) -> Result<()> {
    let profile = profile.map(|path| read_profile(&path).map(|value| (path, value))).transpose()?;
    if let Ok(client) = Client::from_control_file() {
        if client.get("/status").is_ok() {
            match &profile {
                Some((_, value)) => apply(&client, value, connect.as_deref())?,
                None => {
                    if let Some(serial) = &connect {
                        client.post("/command", &json!({ "action": "connect", "serial": serial }))?;
                    }
                }
            }
            println!("Another is already running; sent the profile and device to it");
            return Ok(());
        }
    }

    let mut args: Vec<String> = Vec::new();
    if let Some((path, _)) = &profile {
        args.push("--profile".into());
        args.push(std::fs::canonicalize(path)?.to_string_lossy().into_owned());
    }
    if let Some(serial) = &connect {
        args.push("--connect".into());
        args.push(serial.clone());
    }
    let mut process = match app {
        Some(path) if path.extension().is_some_and(|ext| ext == "app") => {
            let mut open = std::process::Command::new("open");
            open.arg("-a").arg(path).arg("--args").args(&args);
            open
        }
        Some(path) => {
            let mut direct = std::process::Command::new(path);
            direct.args(&args);
            direct
        }
        None if cfg!(target_os = "macos") => {
            let mut open = std::process::Command::new("open");
            open.arg("-a").arg("Another").arg("--args").args(&args);
            open
        }
        None => bail!("Pass --app <path to Another> to start it"),
    };
    let status = process.status().context("starting Another")?;
    if !status.success() {
        bail!("Starting Another failed ({})", status);
    }
    println!("Started Another");
    Ok(())
}
