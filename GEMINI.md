# Another

Another is a desktop app that mirrors and controls Android phones. Its MCP server runs inside the app at `http://localhost:7070/mcp`, so the app must be open for these tools to work.

- Start with `another_list_devices`, then `another_connect_device` with a serial.
- Prefer `another_find_on_screen` or `another_get_ui_tree` over screenshots to locate elements. Both return normalized coordinates (0.0 to 1.0) ready for `another_send_touch`.
- Take a screenshot after an action to confirm it landed before moving on.
- `another_shell` runs adb shell commands on the phone. Ask before anything destructive, such as uninstalling apps or deleting files.
