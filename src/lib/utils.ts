import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Devices reached over Wi-Fi or a tailnet: `host:port` serials and wireless-debugging mDNS names. */
export function isNetworkSerial(serial: string) {
  return serial.includes(":") || serial.includes("._adb-tls-connect.")
}
