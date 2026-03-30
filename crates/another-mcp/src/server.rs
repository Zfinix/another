use another_core::{adb, control, scrcpy};
use another_core::scrcpy::StreamSettings;
use base64::Engine;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;
use tokio::sync::Mutex;

struct Session {
    device_serial: String,
    control_socket: Arc<Mutex<TcpStream>>,
    screen_width: u32,
    screen_height: u32,
    shutdown: Arc<tokio::sync::Notify>,
}

#[derive(Clone)]
pub struct AnotherMcp {
    scrcpy_server_path: Option<String>,
    session: Arc<Mutex<Option<Session>>>,
    tool_router: ToolRouter<Self>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ConnectParams {
    #[schemars(description = "Device serial number from list_devices")]
    pub serial: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ButtonParams {
    #[schemars(description = "Button: home, back, recents, power, volume_up, volume_down")]
    pub button: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TextParams {
    #[schemars(description = "Text to type on the device")]
    pub text: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TouchParams {
    #[schemars(description = "Touch action: down, up, move")]
    pub action: String,
    #[schemars(description = "X position (0.0 to 1.0)")]
    pub x: f64,
    #[schemars(description = "Y position (0.0 to 1.0)")]
    pub y: f64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ScrollParams {
    #[schemars(description = "X position (0.0 to 1.0)")]
    pub x: f64,
    #[schemars(description = "Y position (0.0 to 1.0)")]
    pub y: f64,
    #[schemars(description = "Horizontal scroll amount (-1.0 to 1.0)")]
    pub dx: f64,
    #[schemars(description = "Vertical scroll amount (-1.0 to 1.0, negative = scroll down)")]
    pub dy: f64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WifiEnableParams {
    #[schemars(description = "Device serial number to enable WiFi debugging on")]
    pub serial: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AddressParams {
    #[schemars(description = "Device address in ip:port format (e.g. 192.168.1.100:5555)")]
    pub address: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SerialParams {
    #[schemars(description = "Device serial number")]
    pub serial: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ShellParams {
    #[schemars(description = "Shell command to run on the device")]
    pub command: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SwipeParams {
    #[schemars(description = "Start X position (0.0 to 1.0)")]
    pub from_x: f64,
    #[schemars(description = "Start Y position (0.0 to 1.0)")]
    pub from_y: f64,
    #[schemars(description = "End X position (0.0 to 1.0)")]
    pub to_x: f64,
    #[schemars(description = "End Y position (0.0 to 1.0)")]
    pub to_y: f64,
    #[schemars(description = "Duration in milliseconds (default 300)")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct OpenUrlParams {
    #[schemars(description = "URL to open")]
    pub url: String,
    #[serde(default)]
    #[schemars(description = "Browser app package (default com.android.chrome). Ignored when use_system_handler is true.")]
    pub browser_package: Option<String>,
    #[serde(default)]
    #[schemars(description = "If true, use the system default URL handler (often the Google app for google.com). If false, opens in browser_package (Chrome by default).")]
    pub use_system_handler: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct LaunchAppParams {
    #[schemars(description = "Package name (e.g. com.android.chrome)")]
    pub package: String,
}

impl AnotherMcp {
    pub fn new(scrcpy_server_path: Option<String>) -> Self {
        let tool_router = Self::tool_router();
        Self {
            scrcpy_server_path,
            session: Arc::new(Mutex::new(None)),
            tool_router,
        }
    }

    fn resolve_scrcpy_server(&self) -> Result<String, String> {
        if let Some(ref path) = self.scrcpy_server_path {
            return Ok(path.clone());
        }

        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let candidate = dir.join("scrcpy-server-v2.7");
                if candidate.exists() {
                    return Ok(candidate.to_string_lossy().to_string());
                }
                let candidate = dir.join("resources").join("scrcpy-server-v2.7");
                if candidate.exists() {
                    return Ok(candidate.to_string_lossy().to_string());
                }
            }
        }

        Err("scrcpy-server not found. Pass --scrcpy-server <path> or set SCRCPY_SERVER_PATH".into())
    }
}

#[tool_router]
impl AnotherMcp {
    #[tool(description = "List connected Android devices")]
    async fn another_list_devices(&self) -> String {
        match adb::list_devices().await {
            Ok(devices) if devices.is_empty() => "No devices connected".to_string(),
            Ok(devices) => devices
                .iter()
                .map(|d| format!("{} - {} ({})", d.serial, d.model, d.state))
                .collect::<Vec<_>>()
                .join("\n"),
            Err(e) => format!("Error: {}", e),
        }
    }

    #[tool(description = "Connect to an Android device for control. Starts scrcpy server.")]
    async fn another_connect_device(&self, params: Parameters<ConnectParams>) -> String {
        let params = params.0;
        let server_path = match self.resolve_scrcpy_server() {
            Ok(p) => p,
            Err(e) => return e,
        };

        {
            let mut session = self.session.lock().await;
            if let Some(s) = session.take() {
                s.shutdown.notify_one();
                scrcpy::stop_server(&s.device_serial, 27183).await;
            }
        }

        let settings = StreamSettings {
            max_size: 0,
            max_fps: 1,
            video_bit_rate: 500000,
            video_codec: "h264".to_string(),
            audio: false,
        };

        let port: u16 = 27183;
        let (streams, mut server_process) =
            match scrcpy::start_server(&params.serial, &server_path, port, &settings).await {
                Ok(s) => s,
                Err(e) => return format!("Failed to start scrcpy: {}", e),
            };

        let shutdown = Arc::new(tokio::sync::Notify::new());
        let control_socket = Arc::new(Mutex::new(streams.control_socket));

        let drain_shutdown = shutdown.clone();
        let mut video_socket = streams.video_socket;
        tokio::spawn(async move {
            let mut buf = [0u8; 8192];
            loop {
                tokio::select! {
                    result = video_socket.read(&mut buf) => {
                        match result {
                            Ok(0) | Err(_) => break,
                            _ => continue,
                        }
                    }
                    _ = drain_shutdown.notified() => break,
                }
            }
        });

        let cleanup_shutdown = shutdown.clone();
        let cleanup_serial = params.serial.clone();
        tokio::spawn(async move {
            cleanup_shutdown.notified().await;
            scrcpy::stop_server(&cleanup_serial, port).await;
            let _ = server_process.kill().await;
        });

        let text = format!(
            "Connected to {} ({}x{})",
            params.serial, streams.screen_width, streams.screen_height
        );

        let session = Session {
            device_serial: params.serial,
            control_socket,
            screen_width: streams.screen_width,
            screen_height: streams.screen_height,
            shutdown,
        };

        *self.session.lock().await = Some(session);
        text
    }

    #[tool(description = "Disconnect from the current device")]
    async fn another_disconnect_device(&self) -> String {
        let mut session = self.session.lock().await;
        if let Some(s) = session.take() {
            s.shutdown.notify_one();
            scrcpy::stop_server(&s.device_serial, 27183).await;
            format!("Disconnected from {}", s.device_serial)
        } else {
            "No device connected".to_string()
        }
    }

    #[tool(description = "Take a screenshot of the connected device. Returns a PNG image.")]
    async fn another_take_screenshot(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        let session = self.session.lock().await;
        let session = session.as_ref().ok_or_else(|| rmcp::ErrorData::internal_error("No device connected", None))?;
        let png_data = adb::exec_out_screencap(&session.device_serial)
            .await
            .map_err(|e| rmcp::ErrorData::internal_error(format!("Screenshot failed: {}", e), None))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png_data);
        Ok(CallToolResult::success(vec![rmcp::model::Content::image(b64, "image/png")]))
    }

    #[tool(description = "Press a device button (home, back, recents, power, volume_up, volume_down)")]
    async fn another_press_button(&self, params: Parameters<ButtonParams>) -> String {
        let params = params.0;
        let session = self.session.lock().await;
        let session = match session.as_ref() {
            Some(s) => s,
            None => return "No device connected".to_string(),
        };
        let keycode = match params.button.as_str() {
            "home" => control::KEYCODE_HOME,
            "back" => control::KEYCODE_BACK,
            "recents" => control::KEYCODE_APP_SWITCH,
            "power" => control::KEYCODE_POWER,
            "volume_up" => control::KEYCODE_VOLUME_UP,
            "volume_down" => control::KEYCODE_VOLUME_DOWN,
            _ => return format!("Unknown button: {}", params.button),
        };
        if let Err(e) = control::inject_keycode(&session.control_socket, "down", keycode, 0, 0).await {
            return format!("Error: {}", e);
        }
        if let Err(e) = control::inject_keycode(&session.control_socket, "up", keycode, 0, 0).await {
            return format!("Error: {}", e);
        }
        format!("Pressed {}", params.button)
    }

    #[tool(description = "Type text on the connected device")]
    async fn another_send_text(&self, params: Parameters<TextParams>) -> String {
        let params = params.0;
        let session = self.session.lock().await;
        let session = match session.as_ref() {
            Some(s) => s,
            None => return "No device connected".to_string(),
        };
        if let Err(e) = control::inject_text(&session.control_socket, &params.text).await {
            return format!("Error: {}", e);
        }
        format!("Typed: {}", params.text)
    }

    #[tool(description = "Send a touch event (down/up/move) at normalized coordinates (0.0-1.0)")]
    async fn another_send_touch(&self, params: Parameters<TouchParams>) -> String {
        let params = params.0;
        let session = self.session.lock().await;
        let session = match session.as_ref() {
            Some(s) => s,
            None => return "No device connected".to_string(),
        };
        let px = (params.x * session.screen_width as f64) as u32;
        let py = (params.y * session.screen_height as f64) as u32;
        if let Err(e) = control::inject_touch(
            &session.control_socket,
            &params.action,
            px, py,
            session.screen_width as u16,
            session.screen_height as u16,
        ).await {
            return format!("Error: {}", e);
        }
        format!("Touch {} at ({:.2}, {:.2})", params.action, params.x, params.y)
    }

    #[tool(description = "Send a scroll event at normalized coordinates")]
    async fn another_send_scroll(&self, params: Parameters<ScrollParams>) -> String {
        let params = params.0;
        let session = self.session.lock().await;
        let session = match session.as_ref() {
            Some(s) => s,
            None => return "No device connected".to_string(),
        };
        let px = (params.x * session.screen_width as f64) as u32;
        let py = (params.y * session.screen_height as f64) as u32;
        let sx = (params.dx * 120.0) as i16;
        let sy = (params.dy * 120.0) as i16;
        if let Err(e) = control::inject_scroll(
            &session.control_socket,
            px, py,
            session.screen_width as u16,
            session.screen_height as u16,
            sx, sy,
        ).await {
            return format!("Error: {}", e);
        }
        format!("Scrolled at ({:.2}, {:.2}) by ({:.2}, {:.2})", params.x, params.y, params.dx, params.dy)
    }

    #[tool(description = "Enable WiFi debugging on a USB-connected device and connect wirelessly")]
    async fn another_wifi_enable(&self, params: Parameters<WifiEnableParams>) -> String {
        let params = params.0;
        let ip = match adb::get_device_ip(&params.serial).await {
            Ok(Some(ip)) => ip,
            Ok(None) => return "Device is not connected to WiFi".to_string(),
            Err(e) => return format!("Error: {}", e),
        };

        if let Err(e) = adb::tcpip(&params.serial, 5555).await {
            return format!("Error enabling tcpip: {}", e);
        }

        let addr = format!("{}:5555", ip);
        let mut connected = false;
        for _ in 0..5 {
            tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;
            if adb::connect_device(&addr).await.is_ok() {
                connected = true;
                break;
            }
        }

        if !connected {
            return format!("Could not connect to {}", addr);
        }

        format!("WiFi debugging enabled at {}", addr)
    }

    #[tool(description = "Connect to a device over WiFi by IP address")]
    async fn another_wifi_connect(&self, params: Parameters<AddressParams>) -> String {
        match adb::connect_device(&params.0.address).await {
            Ok(_) => format!("Connected to {}", params.0.address),
            Err(e) => format!("Error: {}", e),
        }
    }

    #[tool(description = "Disconnect a WiFi-connected device")]
    async fn another_wifi_disconnect(&self, params: Parameters<AddressParams>) -> String {
        match adb::disconnect_device(&params.0.address).await {
            Ok(_) => format!("Disconnected {}", params.0.address),
            Err(e) => format!("Error: {}", e),
        }
    }

    #[tool(description = "Get the WiFi IP address of a USB-connected device")]
    async fn another_get_device_ip(&self, params: Parameters<SerialParams>) -> String {
        match adb::get_device_ip(&params.0.serial).await {
            Ok(Some(ip)) => format!("IP: {}", ip),
            Ok(None) => "Device is not connected to WiFi".to_string(),
            Err(e) => format!("Error: {}", e),
        }
    }

    #[tool(description = "Run an adb shell command on the connected device and return its output")]
    async fn another_shell(&self, params: Parameters<ShellParams>) -> String {
        let session = self.session.lock().await;
        let session = match session.as_ref() {
            Some(s) => s,
            None => return "No device connected".to_string(),
        };
        match adb::shell(&session.device_serial, &params.0.command).await {
            Ok(child) => {
                match child.wait_with_output().await {
                    Ok(output) => {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        if stderr.is_empty() {
                            stdout.to_string()
                        } else {
                            format!("{}\nSTDERR: {}", stdout, stderr)
                        }
                    }
                    Err(e) => format!("Error reading output: {}", e),
                }
            }
            Err(e) => format!("Error: {}", e),
        }
    }

    #[tool(description = "Perform a swipe gesture from one point to another at normalized coordinates (0.0-1.0)")]
    async fn another_swipe(&self, params: Parameters<SwipeParams>) -> String {
        let params = params.0;
        let session = self.session.lock().await;
        let session = match session.as_ref() {
            Some(s) => s,
            None => return "No device connected".to_string(),
        };
        let w = session.screen_width;
        let h = session.screen_height;
        let from_px = (params.from_x * w as f64) as u32;
        let from_py = (params.from_y * h as f64) as u32;
        let to_px = (params.to_x * w as f64) as u32;
        let to_py = (params.to_y * h as f64) as u32;
        let steps = params.duration_ms.unwrap_or(300) / 16;

        if let Err(e) = control::inject_touch(
            &session.control_socket, "down",
            from_px, from_py, w as u16, h as u16,
        ).await {
            return format!("Error: {}", e);
        }

        for i in 1..=steps {
            let t = i as f64 / steps as f64;
            let cx = from_px as f64 + (to_px as f64 - from_px as f64) * t;
            let cy = from_py as f64 + (to_py as f64 - from_py as f64) * t;
            tokio::time::sleep(tokio::time::Duration::from_millis(16)).await;
            if let Err(e) = control::inject_touch(
                &session.control_socket, "move",
                cx as u32, cy as u32, w as u16, h as u16,
            ).await {
                return format!("Error: {}", e);
            }
        }

        if let Err(e) = control::inject_touch(
            &session.control_socket, "up",
            to_px, to_py, w as u16, h as u16,
        ).await {
            return format!("Error: {}", e);
        }

        format!(
            "Swiped from ({:.2}, {:.2}) to ({:.2}, {:.2})",
            params.from_x, params.from_y, params.to_x, params.to_y
        )
    }

    #[tool(description = "Open a URL on the device. By default targets Chrome (com.android.chrome) so links open in a real browser; set use_system_handler true for the previous default-handler behavior.")]
    async fn another_open_url(&self, params: Parameters<OpenUrlParams>) -> String {
        let session = self.session.lock().await;
        let session = match session.as_ref() {
            Some(s) => s,
            None => return "No device connected".to_string(),
        };
        let p = &params.0;
        let cmd = if p.use_system_handler {
            format!("am start -a android.intent.action.VIEW -d '{}'", p.url)
        } else {
            let pkg = p
                .browser_package
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("com.android.chrome");
            if !pkg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
            {
                return "Invalid browser_package (use letters, digits, dots, underscores)".to_string();
            }
            format!(
                "am start -a android.intent.action.VIEW -d '{}' -p {}",
                p.url, pkg
            )
        };
        match adb::shell(&session.device_serial, &cmd).await {
            Ok(mut child) => match child.wait().await {
                Ok(_) => format!("Opened {}", p.url),
                Err(e) => format!("Error: {}", e),
            },
            Err(e) => format!("Error: {}", e),
        }
    }

    #[tool(description = "Launch an app by package name")]
    async fn another_launch_app(&self, params: Parameters<LaunchAppParams>) -> String {
        let session = self.session.lock().await;
        let session = match session.as_ref() {
            Some(s) => s,
            None => return "No device connected".to_string(),
        };
        let cmd = format!(
            "monkey -p {} -c android.intent.category.LAUNCHER 1",
            params.0.package
        );
        match adb::shell(&session.device_serial, &cmd).await {
            Ok(mut child) => match child.wait().await {
                Ok(_) => format!("Launched {}", params.0.package),
                Err(e) => format!("Error: {}", e),
            },
            Err(e) => format!("Error: {}", e),
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for AnotherMcp {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        let mut caps = rmcp::model::ServerCapabilities::default();
        caps.tools = Some(rmcp::model::ToolsCapability::default());
        rmcp::model::ServerInfo::new(caps).with_instructions(
            "Android device control server. Use list_devices to find devices, \
             connect_device to establish a session, then control the device with \
             press_button, send_text, send_touch, send_scroll, and take_screenshot."
                .to_string(),
        )
    }
}
