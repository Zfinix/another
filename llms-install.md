# Installing Another for Cline

Another's MCP server runs inside the Another desktop app, so install the app first and keep it open.

## 1. Install the app

macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Zfinix/another/main/install.sh | sh
```

Windows: download the `.msi` from https://github.com/Zfinix/another/releases/latest and run it.

## 2. Open Another and connect a phone

Open the app. Connect an Android phone over USB with USB debugging turned on, or use Connect a phone to pair over Wi-Fi. The MCP server starts with the app on port 7070. You can check it on the AI and CLI page.

## 3. Add the server to Cline

Add this to `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "another": {
      "type": "streamableHttp",
      "url": "http://localhost:7070/mcp"
    }
  }
}
```

## 4. Check it works

Call `another_list_devices`. It should list the connected phone. If the call fails, make sure Another is open and the server is on in the AI and CLI page.
