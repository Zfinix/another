export interface TailnetPeer {
  name: string;
  dns_name: string;
  address: string;
  online: boolean;
  direct: boolean;
  relay: string;
}

export interface TailnetStatus {
  running: boolean;
  peers: TailnetPeer[];
}

export interface Device {
  serial: string;
  model: string;
  state: string;
  wifi_available?: boolean;
}

export type ToastType = "error" | "info" | "success";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  detail?: string;
  action?: ToastAction;
}

export interface Toast extends ToastOptions {
  id: number;
  message: string;
  type: ToastType;
}

export type ShowToast = (message: string, type?: ToastType, options?: ToastOptions) => void;

export interface Settings {
  max_size: number;
  max_fps: number;
  video_bit_rate: number;
  video_codec: string;
  audio: boolean;
  adaptive: boolean;
  adaptive_network?: boolean;
}

export type EncoderTuning =
  | "default"
  | "constant_bitrate"
  | "constant_bitrate_drop_frames"
  | "intra_refresh"
  | "high_profile";

export const ENCODER_TUNING_OPTIONS: { value: EncoderTuning; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "constant_bitrate", label: "Constant bitrate" },
  { value: "constant_bitrate_drop_frames", label: "CBR, drop frames" },
  { value: "intra_refresh", label: "Intra refresh" },
  { value: "high_profile", label: "High profile" },
];

export const PROFILE_VERSION = 1;

export interface Profile {
  version: number;
  stream?: Partial<Settings>;
  dev?: Partial<DevSettings>;
}

export type LinkCommand =
  | { action: "apply"; profile: Profile; connect?: string }
  | { action: "connect"; serial: string };

export type RemoteCommand =
  | LinkCommand
  | { action: "link"; command: LinkCommand }
  | { action: "disconnect" }
  | { action: "measure" };

export interface DevSettings {
  perfOverlay: boolean;
  directAdb: boolean;
  lowLatency: boolean;
  encoderTuning: EncoderTuning;
  anotherServer: boolean;
  nativeVideo: boolean;
  networkStream: boolean;
}

export const DEFAULT_DEV_SETTINGS: DevSettings = {
  perfOverlay: false,
  directAdb: false,
  lowLatency: true,
  encoderTuning: "default",
  anotherServer: false,
  nativeVideo: false,
  networkStream: true,
};

export interface PerfStats {
  renderFps: number;
  decodeFps: number;
  packetsPerSec: number;
  dropped: number;
  bitrateKbps: number;
  decodeMs: number;
  pipelineMs: number;
  deviceLagMs: number;
  deviceLagMaxMs: number;
  screenMs: number;
  screenMaxMs: number;
  decodeQueue: number;
  width: number;
  height: number;
  codec: string;
}

export type MacroEvent =
  | { type: "touch"; action: string; x: number; y: number }
  | { type: "text"; text: string }
  | { type: "key"; keycode: number; action: string }
  | { type: "scroll"; x: number; y: number; dx: number; dy: number }
  | { type: "button"; button: string }
  | { type: "wait"; ms: number };

export interface MacroTimedEvent {
  timestamp_ms: number;
  event: MacroEvent;
}

export interface SavedMacro {
  name: string;
  events: MacroTimedEvent[];
}

export type FrameEvent =
  | { event: "config"; data: { codec: string; description: string } }
  | { event: "packet"; data: { key: boolean; data: string; timestamp: number; recv_ms: number; capture_ms: number | null } }
  | { event: "record_config"; data: { codec: string; description: string } }
  | { event: "record_packet"; data: { key: boolean; data: string; timestamp: number } }
  | { event: "disconnected"; data: { reason: string } }
  | { event: "native_size"; data: { width: number; height: number } }
  | {
      event: "native_stats";
      data: {
        fps: number;
        decode_ms: number;
        kbps: number;
        lag_ms: number;
        lag_max_ms: number;
        lag_min_ms: number;
        screen_ms: number;
        screen_max_ms: number;
        arrive_ms: number;
      };
    };

export type Screen = "welcome" | "another";

export function getDeviceNickname(serial: string): string | null {
  return localStorage.getItem(`device_nickname_${serial}`);
}

export function setDeviceNickname(serial: string, name: string) {
  if (name.trim()) {
    localStorage.setItem(`device_nickname_${serial}`, name.trim());
  } else {
    localStorage.removeItem(`device_nickname_${serial}`);
  }
}

export function getDeviceDisplayName(device: Device): string {
  return getDeviceNickname(device.serial) || device.model;
}

export type ThemePreference = "light" | "dark" | "auto";

export const PRESETS: Record<string, Settings> = {
  performance: { max_size: 720, max_fps: 30, video_bit_rate: 2000000, video_codec: "h264", audio: false, adaptive: false },
  balanced: { max_size: 1024, max_fps: 60, video_bit_rate: 8000000, video_codec: "h264", audio: false, adaptive: false },
  quality: { max_size: 1920, max_fps: 60, video_bit_rate: 24000000, video_codec: "h264", audio: false, adaptive: false },
};

export const DEFAULT_SETTINGS: Required<Settings> = { ...PRESETS.balanced, adaptive_network: true };

export const RESOLUTION_OPTIONS = [
  { value: 480, label: "480p" },
  { value: 720, label: "720p" },
  { value: 1024, label: "1024p" },
  { value: 1280, label: "1280p" },
  { value: 1920, label: "1920p" },
  { value: 0, label: "Native" },
];

export const CODEC_OPTIONS = [
  { value: "h264", label: "H.264" },
];

export type QuickActionId = "screenshot" | "record" | "stats" | "mute" | "rotate";

export const QUICK_ACTION_ORDER: QuickActionId[] = ["screenshot", "record", "stats", "mute", "rotate"];

export const DEFAULT_PINNED_ACTIONS: QuickActionId[] = ["record", "stats"];

export interface AdaptiveTier {
  max_size: number;
  max_fps: number;
  video_bit_rate: number;
}

export const ADAPTIVE_TIERS: AdaptiveTier[] = [
  { max_size: 720, max_fps: 30, video_bit_rate: 2000000 },
  { max_size: 720, max_fps: 60, video_bit_rate: 4000000 },
  { max_size: 1024, max_fps: 60, video_bit_rate: 8000000 },
  { max_size: 1280, max_fps: 60, video_bit_rate: 12000000 },
  { max_size: 1920, max_fps: 60, video_bit_rate: 24000000 },
  { max_size: 1920, max_fps: 120, video_bit_rate: 32000000 },
];

export type View =
  | { kind: "device"; serial: string }
  | { kind: "tailnet"; address: string }
  | { kind: "macros" }
  | { kind: "recordings" }
  | { kind: "notifications" }
  | { kind: "agents" };
