import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

export interface PhoneNotification {
  key: string;
  package: string;
  title: string;
  text: string;
  posted_ms: number;
}

export interface Banner extends PhoneNotification {
  device: string;
  code: string | null;
}

const POLL_MS = 4000;
const BANNER_MS = 8000;
const MAX_BANNERS = 3;
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
  const [banners, setBanners] = useState<Banner[]>([]);
  const [systemCenter, setSystemCenterState] = useState(() => readFlag("notify_system", true));
  const [offerCodes, setOfferCodesState] = useState(() => readFlag("notify_codes", true));
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

  const dismissBanner = useCallback((key: string) => {
    setBanners((prev) => prev.filter((b) => b.key !== key));
  }, []);

  useEffect(() => {
    seen.current = null;
    setItems([]);
    setBanners([]);
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
        const { systemCenter: toCenter, offerCodes: codes, deviceName: name } = optionsRef.current;
        const next = fresh.map((n) => ({ ...n, device: name, code: codes ? oneTimeCode(n) : null }));
        setBanners((prev) => [...next, ...prev].slice(0, MAX_BANNERS));
        next.forEach((b) => setTimeout(() => dismissBanner(b.key), BANNER_MS));
        if (toCenter && !document.hasFocus()) {
          next.forEach((n) => sendNotification({ title: `${appName(n.package)} · ${n.title}`, body: n.text || name }));
        }
      } catch { }
    };

    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [serial, dismissBanner]);

  return { items, banners, dismissBanner, systemCenter, setSystemCenter, offerCodes, setOfferCodes };
}
