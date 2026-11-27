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
