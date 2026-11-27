import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";

export interface PhoneNotification {
  key: string;
  package: string;
  title: string;
  text: string;
  posted_ms: number;
}

const POLL_MS = 4000;
const CODE_PATTERN = /(?:code|otp|pin|passcode|verification|verify|sign-in|login)/i;
const CODE_DIGITS = /\b(\d{4,8})\b/;

const APP_NAMES: Record<string, string> = {
  "com.google.android.gm": "Gmail",
  "com.google.android.apps.messaging": "Messages",
  "com.whatsapp": "WhatsApp",
  "com.ubercab": "Uber",
  "com.google.android.dialer": "Phone",
  "com.google.android.calendar": "Calendar",
  "com.google.android.youtube": "YouTube",
  "com.google.android.apps.photos": "Photos",
  "com.android.chrome": "Chrome",
  "org.telegram.messenger": "Telegram",
  "com.slack": "Slack",
  "com.instagram.android": "Instagram",
  "com.twitter.android": "X",
  "com.spotify.music": "Spotify",
};

export function appName(pkg: string): string {
  if (APP_NAMES[pkg]) return APP_NAMES[pkg];
  const last = pkg.split(".").filter((p) => !["android", "app", "apps", "com", "org"].includes(p)).pop() ?? pkg;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

export function oneTimeCode(n: Pick<PhoneNotification, "title" | "text">): string | null {
  const body = `${n.title} ${n.text}`;
  if (!CODE_PATTERN.test(body)) return null;
  return body.match(CODE_DIGITS)?.[1] ?? null;
}

export function timeAgo(ms: number, now = Date.now()): string {
  const minutes = Math.floor((now - ms) / 60000);
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

const ICONS_KEY = "app_icons";

function readIcons(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ICONS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

async function notifyMac(serial: string, n: PhoneNotification, deviceName: string, cached?: string) {
  let icon = cached?.split(",")[1] ?? null;
  if (!icon) {
    const found = await invoke<Record<string, string>>("app_icons", { serial, packages: [n.package] }).catch(() => ({} as Record<string, string>));
    icon = found[n.package] ?? null;
  }
  await invoke("notify_phone", { title: n.title, subtitle: `${appName(n.package)} · ${deviceName}`, body: n.text, package: n.package, icon }).catch(() => { });
}

function readFlag(key: string, fallback: boolean) {
  const stored = localStorage.getItem(key);
  return stored === null ? fallback : stored === "true";
}

interface Options {
  serial: string | null;
  deviceName: string;
}

export function useNotifications({ serial, deviceName }: Options) {
  const [items, setItems] = useState<PhoneNotification[]>([]);
  const [systemCenter, setSystemCenterState] = useState(() => readFlag("notify_system", true));
  const [offerCodes, setOfferCodesState] = useState(() => readFlag("notify_codes", true));
  const [icons, setIcons] = useState<Record<string, string>>(readIcons);
  const asked = useRef<Set<string>>(new Set());
  const iconsRef = useRef(icons);
  iconsRef.current = icons;
  const seen = useRef<Set<string> | null>(null);
  const optionsRef = useRef({ systemCenter, offerCodes, deviceName });
  optionsRef.current = { systemCenter, offerCodes, deviceName };

  const setSystemCenter = useCallback(async (on: boolean) => {
    if (on && !(await isPermissionGranted())) {
      if ((await requestPermission()) !== "granted") return;
    }
    setSystemCenterState(on);
    localStorage.setItem("notify_system", String(on));
  }, []);

  const setOfferCodes = useCallback((on: boolean) => {
    setOfferCodesState(on);
    localStorage.setItem("notify_codes", String(on));
  }, []);

  useEffect(() => {
    seen.current = null;
    setItems([]);
    if (!serial) return;
    let stopped = false;

    const poll = async () => {
      try {
        const list = await invoke<PhoneNotification[]>("phone_notifications", { serial });
        if (stopped) return;
        setItems(list);
        const known = seen.current;
        seen.current = new Set(list.map((n) => n.key));
        if (!known) return;
        const fresh = list.filter((n) => !known.has(n.key));
        if (fresh.length === 0) return;
        const { systemCenter: toCenter, deviceName: name } = optionsRef.current;
        if (toCenter) fresh.forEach((n) => notifyMac(serial, n, name, iconsRef.current[n.package]));
      } catch { }
    };

    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [serial]);

  useEffect(() => {
    if (!serial) return;
    const missing = [...new Set(items.map((n) => n.package))].filter((pkg) => !icons[pkg] && !asked.current.has(pkg));
    if (missing.length === 0) return;
    missing.forEach((pkg) => asked.current.add(pkg));
    invoke<Record<string, string>>("app_icons", { serial, packages: missing })
      .then((found) => {
        if (Object.keys(found).length === 0) return;
        setIcons((prev) => {
          const next = { ...prev };
          for (const [pkg, png] of Object.entries(found)) next[pkg] = `data:image/png;base64,${png}`;
          try {
            localStorage.setItem(ICONS_KEY, JSON.stringify(next));
          } catch { }
          return next;
        });
      })
      .catch(() => { });
  }, [serial, items, icons]);

  return { items, systemCenter, setSystemCenter, offerCodes, setOfferCodes, icons };
}
