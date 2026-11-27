import type { CodeLang } from "@/components/CodeBlock";
import logo5Ire from "../assets/agents/5ire.png";
import logoAmp from "../assets/agents/amp.svg";
import logoBoltai from "../assets/agents/boltai.png";
import logoCherryStudio from "../assets/agents/cherry-studio.svg";
import logoClaudeCode from "../assets/agents/claude-code.svg";
import logoClaudeDesktop from "../assets/agents/claude-desktop.svg";
import logoCline from "../assets/agents/cline.svg";
import logoCodex from "../assets/agents/codex.svg";
import logoCodexDark from "../assets/agents/codex-dark.svg";
import logoContinue from "../assets/agents/continue.png";
import logoCopilotCli from "../assets/agents/copilot-cli.svg";
import logoCopilotCliDark from "../assets/agents/copilot-cli-dark.svg";
import logoCrush from "../assets/agents/crush.png";
import logoCursor from "../assets/agents/cursor.svg";
import logoCursorDark from "../assets/agents/cursor-dark.svg";
import logoGeminiCli from "../assets/agents/gemini-cli.svg";
import logoGoose from "../assets/agents/goose.svg";
import logoJetbrains from "../assets/agents/jetbrains.svg";
import logoKiloCode from "../assets/agents/kilo-code.svg";
import logoKiro from "../assets/agents/kiro.svg";
import logoLmStudio from "../assets/agents/lm-studio.svg";
import logoMsty from "../assets/agents/msty.png";
import logoOpencode from "../assets/agents/opencode.svg";
import logoOpencodeDark from "../assets/agents/opencode-dark.svg";
import logoOtherClients from "../assets/agents/other-clients.svg";
import logoOtherClientsDark from "../assets/agents/other-clients-dark.svg";
import logoQwenCode from "../assets/agents/qwen-code.svg";
import logoRooCode from "../assets/agents/roo-code.svg";
import logoTrae from "../assets/agents/trae.svg";
import logoVsCode from "../assets/agents/vs-code.svg";
import logoWarp from "../assets/agents/warp.svg";
import logoWindsurf from "../assets/agents/windsurf.svg";
import logoWindsurfDark from "../assets/agents/windsurf-dark.svg";
import logoZed from "../assets/agents/zed.svg";
import logoZedDark from "../assets/agents/zed-dark.svg";

export type AgentLogoSource = { src: string; dark?: string; mono?: boolean };

export interface AgentClient {
  name: string;
  logo: AgentLogoSource;
  where: string;
  lang: CodeLang;
  config: (url: string) => string;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);
const mcpServers = (url: string) => json({ mcpServers: { another: { url } } });
const settings = "Add this in its MCP settings";

/** MCP clients that can reach a server on this Mac, with the setup each one reads. */
export const AGENT_CLIENTS: AgentClient[] = [
  { name: "Claude Code", logo: { src: logoClaudeCode }, where: "Run this in Terminal", lang: "shell", config: (url) => `claude mcp add --transport http another ${url}` },
  { name: "Claude Desktop", logo: { src: logoClaudeDesktop }, where: "Settings, Connectors, Add custom connector, then paste this address", lang: "url", config: (url) => url },
  { name: "Codex", logo: { src: logoCodex, dark: logoCodexDark }, where: "Add this to ~/.codex/config.toml", lang: "toml", config: (url) => `[mcp_servers.another]\nurl = "${url}"` },
  { name: "Cursor", logo: { src: logoCursor, dark: logoCursorDark }, where: "Add this to ~/.cursor/mcp.json", lang: "json", config: mcpServers },
  { name: "VS Code", logo: { src: logoVsCode }, where: "Add this to .vscode/mcp.json in your project", lang: "json", config: (url) => json({ servers: { another: { type: "http", url } } }) },
  { name: "Copilot CLI", logo: { src: logoCopilotCli, dark: logoCopilotCliDark }, where: "Add this to ~/.copilot/mcp-config.json", lang: "json", config: (url) => json({ mcpServers: { another: { type: "http", url, tools: ["*"] } } }) },
  { name: "Windsurf", logo: { src: logoWindsurf, dark: logoWindsurfDark }, where: "Add this to ~/.codeium/windsurf/mcp_config.json", lang: "json", config: (url) => json({ mcpServers: { another: { serverUrl: url } } }) },
  { name: "Zed", logo: { src: logoZed, dark: logoZedDark }, where: "Add this to your Zed settings.json", lang: "json", config: (url) => json({ context_servers: { another: { url } } }) },
  { name: "Gemini CLI", logo: { src: logoGeminiCli }, where: "Add this to ~/.gemini/settings.json", lang: "json", config: (url) => json({ mcpServers: { another: { httpUrl: url } } }) },
  { name: "Qwen Code", logo: { src: logoQwenCode }, where: "Add this to ~/.qwen/settings.json", lang: "json", config: (url) => json({ mcpServers: { another: { httpUrl: url } } }) },
  { name: "OpenCode", logo: { src: logoOpencode, dark: logoOpencodeDark }, where: "Add this to opencode.json", lang: "json", config: (url) => json({ mcp: { another: { type: "remote", url } } }) },
  { name: "Crush", logo: { src: logoCrush }, where: "Add this to crush.json", lang: "json", config: (url) => json({ mcp: { another: { type: "http", url } } }) },
  { name: "Amp", logo: { src: logoAmp }, where: "Add this to your Amp settings.json", lang: "json", config: (url) => json({ "amp.mcpServers": { another: { url } } }) },
  { name: "Kiro", logo: { src: logoKiro }, where: "Add this to ~/.kiro/settings/mcp.json", lang: "json", config: mcpServers },
  { name: "Cline", logo: { src: logoCline, mono: true }, where: "Add this to Cline's MCP settings", lang: "json", config: (url) => json({ mcpServers: { another: { type: "streamableHttp", url } } }) },
  { name: "Roo Code", logo: { src: logoRooCode, mono: true }, where: "Add this to .roo/mcp.json", lang: "json", config: (url) => json({ mcpServers: { another: { type: "streamable-http", url } } }) },
  { name: "Kilo Code", logo: { src: logoKiloCode, mono: true }, where: "Add this to Kilo Code's MCP settings", lang: "json", config: (url) => json({ mcpServers: { another: { type: "streamable-http", url } } }) },
  { name: "Continue", logo: { src: logoContinue }, where: "Add this to your Continue config.yaml", lang: "yaml", config: (url) => `mcpServers:\n  - name: another\n    type: streamable-http\n    url: ${url}` },
  { name: "Goose", logo: { src: logoGoose, mono: true }, where: "Add this to ~/.config/goose/config.yaml", lang: "yaml", config: (url) => `extensions:\n  another:\n    name: another\n    type: streamable_http\n    uri: ${url}\n    enabled: true` },
  { name: "JetBrains", logo: { src: logoJetbrains }, where: "Add this in Settings, Tools, AI Assistant, Model Context Protocol", lang: "json", config: mcpServers },
  { name: "Warp", logo: { src: logoWarp }, where: settings, lang: "json", config: mcpServers },
  { name: "Trae", logo: { src: logoTrae }, where: settings, lang: "json", config: mcpServers },
  { name: "LM Studio", logo: { src: logoLmStudio, mono: true }, where: "Add this to mcp.json in LM Studio", lang: "json", config: mcpServers },
  { name: "Cherry Studio", logo: { src: logoCherryStudio }, where: settings, lang: "json", config: mcpServers },
  { name: "Msty", logo: { src: logoMsty }, where: settings, lang: "json", config: mcpServers },
  { name: "BoltAI", logo: { src: logoBoltai }, where: settings, lang: "json", config: mcpServers },
  { name: "5ire", logo: { src: logo5Ire }, where: settings, lang: "json", config: mcpServers },
  { name: "Other clients", logo: { src: logoOtherClients, dark: logoOtherClientsDark }, where: "Add this in their MCP settings", lang: "json", config: mcpServers },
];

export interface AgentGroup {
  id: string;
  clients: AgentClient[];
  lang: CodeLang;
  config: (url: string) => string;
}

const SAMPLE_URL = "http://localhost:0/mcp";

/** Clients that need exactly the same snippet share one tile. */
export const AGENT_GROUPS: AgentGroup[] = AGENT_CLIENTS.reduce<AgentGroup[]>((groups, client) => {
  const id = `${client.lang}:${client.config(SAMPLE_URL)}`;
  const existing = groups.find((g) => g.id === id);
  if (existing) existing.clients.push(client);
  else groups.push({ id, clients: [client], lang: client.lang, config: client.config });
  return groups;
}, []);

export function groupLabel(group: AgentGroup): string {
  const [first, ...rest] = group.clients.map((c) => c.name);
  return rest.length === 0 ? first : `${first} +${rest.length}`;
}
