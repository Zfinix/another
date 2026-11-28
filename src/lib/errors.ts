const MAX_LENGTH = 120;
const FALLBACK = "Something went wrong. Try again";

const INSTALL_FAILURES: Record<string, string> = {
  INSUFFICIENT_STORAGE: "Not enough storage on the phone",
  VERSION_DOWNGRADE: "A newer version of this app is already installed",
  UPDATE_INCOMPATIBLE: "A different build of this app is installed. Uninstall it first",
  OLDER_SDK: "This app needs a newer version of Android",
  NO_MATCHING_ABIS: "This app does not support the phone's processor",
  INVALID_APK: "That file is not a valid app",
  USER_RESTRICTED: "The phone blocked the install. Allow installs over USB and try again",
  ALREADY_EXISTS: "This app is already installed",
};

const KNOWN: [RegExp, string][] = [
  [/unauthorized/i, "Allow USB debugging on the phone, then try again"],
  [/device offline|device still connecting/i, "The phone is offline. Reconnect it and try again"],
  [/device '.*' not found|device not found|no devices\/emulators/i, "The phone is no longer connected"],
  [/more than one (device|emulator)/i, "More than one phone is connected. Pick one from the list"],
  [/failed to (run|spawn) adb/i, "Could not start adb. Reinstall Another and try again"],
  [/wrong password|pairing code|unable to start pairing|failed to pair/i, "Pairing failed. Check the code, it expires quickly"],
  [/connection refused|actively refused|econnrefused/i, "The connection was refused"],
  [/no route to host|network is unreachable|host is down|host unreachable/i, "That address cannot be reached. Check the network"],
  [/timed out|timeout/i, "It took too long to answer. Try again"],
  [/connection reset|broken pipe|unexpected eof|early eof|failed to fill whole buffer|connection closed|protocol fault|closed by remote|(^|: )closed$/i, "The connection dropped"],
  [/address already in use|address in use/i, "That port is already in use"],
  [/tailscale is not installed/i, "Tailscale is not installed"],
  [/no space left/i, "Not enough storage"],
  [/no such file or directory|cannot find the (file|path)/i, "That file or folder no longer exists"],
  [/play the phone audio|output stream|audio output/i, "Could not play the phone's audio on this computer"],
  [/permission denied|operation not permitted|access is denied/i, "Another does not have permission to do that"],
];

/** Lines that only make sense to a developer: stack traces, shell commands, Rust debug output. */
const NOISE = /CLASSPATH=|app_process|\bat [\w$.]+\(|Exception|Os \{|\bkind: |\/data\/local\/tmp/;

function sentence(text: string) {
  const trimmed = text.trim().replace(/[.:;,\s]+$/, "");
  if (!trimmed) return FALLBACK;
  const capped = trimmed.length > MAX_LENGTH ? `${trimmed.slice(0, MAX_LENGTH).replace(/\s+\S*$/, "")}…` : trimmed;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

/** Turns whatever a command threw into one short sentence a person can act on. */
export function cleanError(error: unknown): string {
  const raw = (error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "")).trim();
  if (!raw) return FALLBACK;

  const install = raw.match(/INSTALL_(?:FAILED|PARSE_FAILED)_([A-Z_]+)/);
  if (install) return INSTALL_FAILURES[install[1]] ?? "The phone could not install the app";

  for (const [pattern, message] of KNOWN) {
    if (pattern.test(raw)) return message;
  }

  const firstLine = raw.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const cause = firstLine
    .split(/:\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .pop() ?? "";
  const cleaned = cause
    .replace(/\s*\(os error \d+\)/gi, "")
    .replace(/^(adb|error|fatal)\s*:\s*/i, "");
  if (!cleaned || NOISE.test(cleaned) || NOISE.test(firstLine)) return FALLBACK;
  return sentence(cleaned);
}
