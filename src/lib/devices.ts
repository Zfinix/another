import type { Device } from "@/types";
import { getDeviceDisplayName, getDeviceNickname } from "@/types";
import { isNetworkSerial } from "@/lib/utils";
import type { IconName } from "@/lib/icons";

export type DeviceKind = "usb" | "wifi" | "emulator";

export function deviceKind(device: Device): DeviceKind {
  if (device.serial.startsWith("emulator-")) return "emulator";
  return isNetworkSerial(device.serial) ? "wifi" : "usb";
}

export function prettyModel(model: string): string {
  return model.replace(/_/g, " ");
}

export interface DeviceInfo {
  manufacturer: string;
  model: string;
  market_name: string;
  android_version: string;
  /** The phone's own serial number, the same over USB and Wi-Fi. */
  hardware_serial?: string;
  avd_name: string;
  avd_device: string;
  avd_manufacturer: string;
}

const infos = new Map<string, DeviceInfo>();

export function hasDeviceInfo(serial: string) {
  return infos.has(serial);
}

export function setDeviceInfo(serial: string, info: DeviceInfo) {
  infos.set(serial, info);
}

export function getDeviceInfo(serial: string): DeviceInfo | undefined {
  return infos.get(serial);
}

const UPPER_WORDS = /^(xl|xxl|5g|fe|se|ii|iii|iv|pro\+)$/i;

/** `pixel_9_pro_xl` becomes `Pixel 9 Pro XL`. */
export function profileName(id: string): string {
  return id
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => (UPPER_WORDS.test(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

export function deviceName(device: Device): string {
  if (getDeviceNickname(device.serial)) return getDeviceDisplayName(device);
  const info = infos.get(device.serial);
  if (deviceKind(device) === "emulator") {
    if (info?.avd_device) return profileName(info.avd_device);
    if (info?.avd_name) return prettyModel(info.avd_name);
    return "Android emulator";
  }
  if (info?.market_name) return info.market_name;
  if (info?.model) return info.model;
  return prettyModel(device.model);
}

/** The maker whose logo a device row shows. Emulators always show the Android robot. */
export function deviceMaker(device: Device): string {
  if (deviceKind(device) === "emulator") return "android";
  const maker = infos.get(device.serial)?.manufacturer.trim().toLowerCase();
  if (maker) return maker;
  return /pixel/i.test(device.model) ? "google" : "android";
}

export function peerMaker(name: string): string {
  return /pixel/i.test(name) ? "google" : "android";
}

export const KIND_LABEL: Record<DeviceKind, string> = {
  usb: "USB",
  wifi: "Wi-Fi",
  emulator: "Emulator",
};

export const KIND_PATH: Record<DeviceKind, string> = {
  usb: "USB",
  wifi: "Wi-Fi",
  emulator: "This Mac",
};

export const KIND_ICON: Record<DeviceKind | "tailnet", IconName> = {
  usb: "usb",
  wifi: "wifiOn",
  emulator: "desktopOn",
  tailnet: "globeOn",
};

export function resolutionLabel(maxSize: number): string {
  return maxSize === 0 ? "Native" : `${maxSize}p`;
}

export interface DeviceFacts {
  battery_percent: number | null;
  charging: boolean;
  battery_full: boolean;
  storage_total_kb: number | null;
  storage_free_kb: number | null;
  memory_kb: number | null;
  screen_width: number | null;
  screen_height: number | null;
  refresh_hz: number | null;
}

export interface DeviceFact {
  label: string;
  value: string;
  icon: IconName;
  tone: string;
}

/** Memory is sold in these sizes; the kernel reports a little less, so it rounds up to the next one. */
const MEMORY_SIZES_GB = [1, 1.5, 2, 3, 4, 6, 8, 10, 12, 16, 18, 20, 24, 32, 48, 64];

function gigabytes(kb: number): string {
  const gb = (kb * 1024) / 1e9;
  return `${gb < 10 ? gb.toFixed(1).replace(/\.0$/, "") : Math.round(gb)} GB`;
}

function memorySize(kb: number): string {
  const gib = kb / 1024 / 1024;
  const size = MEMORY_SIZES_GB.find((s) => gib <= s) ?? Math.ceil(gib);
  return `${size} GB`;
}

export function describeFacts(facts: DeviceFacts): DeviceFact[] {
  const rows: DeviceFact[] = [];
  if (facts.battery_percent !== null) {
    const state = facts.battery_full ? " · Full" : facts.charging ? " · Charging" : "";
    rows.push({ label: "Battery", value: `${facts.battery_percent}%${state}`, icon: facts.charging ? "batteryCharge" : "battery", tone: "g-green" });
  }
  if (facts.storage_free_kb !== null && facts.storage_total_kb !== null) {
    rows.push({ label: "Storage", value: `${gigabytes(facts.storage_free_kb)} free of ${gigabytes(facts.storage_total_kb)}`, icon: "storage", tone: "g-orange" });
  }
  if (facts.memory_kb !== null) {
    rows.push({ label: "Memory", value: memorySize(facts.memory_kb), icon: "memory", tone: "g-violet" });
  }
  if (facts.screen_width !== null && facts.screen_height !== null) {
    const rate = facts.refresh_hz ? ` · ${facts.refresh_hz} Hz` : "";
    rows.push({ label: "Display", value: `${facts.screen_width} × ${facts.screen_height}${rate}`, icon: "phoneOn", tone: "g-blue" });
  }
  return rows;
}
