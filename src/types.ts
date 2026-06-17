export interface Device {
  serial: string;
  model: string;
  state: string;
  wifi_available?: boolean;
}

export interface Toast {
  id: number;
  message: string;
  type: "error" | "info";
}

export interface Settings {
  max_size: number;
  max_fps: number;
  video_bit_rate: number;
  video_codec: string;
  audio: boolean;
  adaptive: boolean;
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
  | { event: "packet"; data: { key: boolean; data: string; timestamp: number } }
  | { event: "disconnected"; data: { reason: string } };

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

export type QuickActionId = "record" | "mute" | "volume_up" | "volume_down" | "power" | "macro-toggle" | "rotate";

export const QUICK_ACTIONS: { id: QuickActionId; label: string }[] = [
  { id: "record", label: "Record" },
  { id: "mute", label: "Mute" },
  { id: "volume_up", label: "Vol+" },
  { id: "volume_down", label: "Vol-" },
  { id: "power", label: "Power" },
  { id: "macro-toggle", label: "Macro" },
  { id: "rotate", label: "Rotate" },
];

export const DEFAULT_PINNED_ACTIONS: QuickActionId[] = [];

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
