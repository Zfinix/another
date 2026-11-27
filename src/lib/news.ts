import type { IconName } from "@/lib/icons";
import type { View } from "@/types";
import logoClaudeCode from "../assets/agents/claude-code.svg";
import logoCursor from "../assets/agents/cursor.svg";
import logoCursorDark from "../assets/agents/cursor-dark.svg";
import logoCodex from "../assets/agents/codex.svg";
import logoCodexDark from "../assets/agents/codex-dark.svg";
import logoGemini from "../assets/agents/gemini-cli.svg";

export type NewsArt =
  | { kind: "logos"; logos: { light: string; dark: string }[] }
  | { kind: "tiles"; tiles: { icon: IconName; tone: string }[] };

export type NewsAction =
  | { kind: "view"; label: string; view: View }
  | { kind: "settings"; label: string; pane: "general" | "network" | "stream" }
  | { kind: "connect"; label: string }
  | { kind: "none" };

export type HeroPattern = "silk" | "topo" | "prism";

export interface News {
  id: string;
  title: string;
  body: string;
  hero: { pattern: HeroPattern; colors: [string, string, string]; dark?: [string, string, string] };
  art: NewsArt;
  action: NewsAction;
}

const same = (src: string) => ({ light: src, dark: src });

/** Newest first; the card opens on the first one. */
export const NEWS: [News, ...News[]] = [
  {
    id: "qr-pairing",
    title: "Pair with a QR code",
    hero: { pattern: "prism", colors: ["#22c55e", "#14b8a6", "#3b82f6"], dark: ["#16a34a", "#0ea5e9", "#84cc16"] },
    body: "Scan a code from Wireless debugging on the phone and Another pairs and connects over Wi-Fi. No IP address, port or six-digit code to type.",
    art: { kind: "tiles", tiles: [{ icon: "qrOn", tone: "g-green" }, { icon: "wifiOn", tone: "g-blue" }] },
    action: { kind: "connect", label: "Pair a phone" },
  },
  {
    id: "ai-agents",
    title: "Let AI drive your phone",
    hero: { pattern: "prism", colors: ["#3b82f6", "#8b5cf6", "#22d3ee"] },
    body: "Another runs an MCP server, so Claude Code, Codex, Cursor and 25 more can see the screen, read the UI tree, tap, type and run macros.",
    art: { kind: "logos", logos: [same(logoClaudeCode), { light: logoCodex, dark: logoCodexDark }, { light: logoCursor, dark: logoCursorDark }, same(logoGemini)] },
    action: { kind: "view", label: "Connect an agent", view: { kind: "agents" } },
  },
  {
    id: "cli",
    title: "another, in your Terminal",
    hero: { pattern: "prism", colors: ["#6366f1", "#3b82f6", "#38bdf8"], dark: ["#334155", "#3b82f6", "#64748b"] },
    body: "Install the another command with one click. Check what's streaming, switch phones, change quality live or time latency from any script.",
    art: { kind: "tiles", tiles: [{ icon: "console", tone: "g-ink" }, { icon: "sparkle", tone: "g-blue" }] },
    action: { kind: "view", label: "Install the command", view: { kind: "agents" } },
  },
  {
    id: "notifications",
    title: "Your phone's notifications, here",
    hero: { pattern: "prism", colors: ["#fb923c", "#ec4899", "#a78bfa"], dark: ["#fb923c", "#f43f5e", "#fbbf24"] },
    body: "New notifications from the phone show up on your Mac. One-time codes get a Copy code button, and Open on phone jumps straight to the app.",
    art: { kind: "tiles", tiles: [{ icon: "alert", tone: "g-orange" }, { icon: "copy", tone: "g-green" }] },
    action: { kind: "view", label: "See notifications", view: { kind: "notifications" } },
  },
  {
    id: "direct-wifi",
    title: "Wi-Fi without the lag",
    hero: { pattern: "prism", colors: ["#14b8a6", "#0ea5e9", "#818cf8"], dark: ["#14b8a6", "#3b82f6", "#84cc16"] },
    body: "Over Wi-Fi and Tailscale, video and touches go straight to the phone instead of through adb, and quality adapts as the link changes.",
    art: { kind: "tiles", tiles: [{ icon: "wifiOn", tone: "g-blue" }, { icon: "globeOn", tone: "g-teal" }] },
    action: { kind: "settings", label: "Open network settings", pane: "network" },
  },
  {
    id: "glass",
    title: "Tune the glass",
    hero: { pattern: "prism", colors: ["#a855f7", "#f472b6", "#38bdf8"], dark: ["#a855f7", "#ec4899", "#6366f1"] },
    body: "Choose how much of your desktop shows through the window and how blurred it is. Settings always stays solid.",
    art: { kind: "tiles", tiles: [{ icon: "settingsOn", tone: "g-grey" }] },
    action: { kind: "settings", label: "Adjust the glass", pane: "general" },
  },
  {
    id: "library",
    title: "Recordings and macros, in one place",
    hero: { pattern: "prism", colors: ["#fb7185", "#8b5cf6", "#60a5fa"], dark: ["#ef4444", "#a855f7", "#f97316"] },
    body: "Recordings open in QuickTime from the sidebar, macros read as plain steps, and phones show their lock screen before you mirror.",
    art: { kind: "tiles", tiles: [{ icon: "recDot", tone: "g-red" }, { icon: "wandOn", tone: "g-violet" }] },
    action: { kind: "none" },
  },
];

export const LATEST_NEWS = NEWS[0];

const DISMISSED_KEY = "news_dismissed";

export function isNewsDismissed(id: string): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === id;
  } catch {
    return false;
  }
}

export function dismissNews(id: string) {
  try {
    localStorage.setItem(DISMISSED_KEY, id);
  } catch { }
}
