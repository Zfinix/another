import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";

export interface PhoneNotification {
  key: string;
  package: string;
  title: string;
  text: string;
  posted_ms: number;
  alert_once: boolean;
}

const POLL_MS = 4000;
const MIRRORING_POLL_MS = 30000;
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

const MAX_ICON_ATTEMPTS = 3;
const pendingIcons = new Map<string, Promise<string | null>>();
const iconAttempts = new Map<string, number>();

const canFetchIcon = (pkg: string) => !pendingIcons.has(pkg) && (iconAttempts.get(pkg) ?? 0) < MAX_ICON_ATTEMPTS;

/** Each app's launcher icon as base64 PNG, or null. Requests already in flight are shared, and a failed one is retried a few times. */
function fetchIcons(serial: string, packages: string[]): Promise<Record<string, string | null>> {
  const wanted = packages.filter(canFetchIcon);
  if (wanted.length > 0) {
    wanted.forEach((pkg) => iconAttempts.set(pkg, (iconAttempts.get(pkg) ?? 0) + 1));
    const batch = invoke<Record<string, string>>("app_icons", { serial, packages: wanted }).catch(() => ({} as Record<string, string>));
    for (const pkg of wanted) {
      pendingIcons.set(pkg, batch.then((found) => found[pkg] ?? null).finally(() => pendingIcons.delete(pkg)));
    }
  }
  return Promise.all(packages.map((pkg) => (pendingIcons.get(pkg) ?? Promise.resolve(null)).then((icon) => [pkg, icon] as const)))
    .then((entries) => Object.fromEntries(entries));
}

async function notifyMac(serial: string, n: PhoneNotification, deviceName: string, cached?: string) {
  const icon = cached?.split(",")[1] ?? (await fetchIcons(serial, [n.package]))[n.package] ?? null;
  await invoke("notify_phone", { title: n.title, subtitle: `${appName(n.package)} · ${deviceName}`, body: n.text, package: n.package, icon }).catch(() => { });
}

function contentOf(n: PhoneNotification) {
  return `${n.title}\n${n.text}`;
}

function readFlag(key: string, fallback: boolean) {
  const stored = localStorage.getItem(key);
  return stored === null ? fallback : stored === "true";
}

interface Options {
  serial: string | null;
  deviceName: string;
  mirroring: boolean;
}

export function useNotifications({ serial, deviceName, mirroring }: Options) {
  const [items, setItems] = useState<PhoneNotification[]>([]);
  const [systemCenter, setSystemCenterState] = useState(() => readFlag("notify_system", true));
  const [offerCodes, setOfferCodesState] = useState(() => readFlag("notify_codes", true));
  const [icons, setIcons] = useState<Record<string, string>>(readIcons);
  const iconsRef = useRef(icons);
  iconsRef.current = icons;
  const seen = useRef<Map<string, string> | null>(null);
  const wasMirroring = useRef(mirroring);
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
  }, [serial]);

  useEffect(() => {
    let quiet = wasMirroring.current && !mirroring;
    wasMirroring.current = mirroring;
    if (!serial) return;
    let stopped = false;

    const poll = async () => {
      try {
        const list = await invoke<PhoneNotification[]>("phone_notifications", { serial });
        if (stopped) return;
        setItems(list);
        const known = seen.current;
        seen.current = new Map(list.map((n) => [n.key, contentOf(n)]));
        if (!known || quiet) {
          quiet = false;
          return;
        }
        const fresh = list.filter((n) => {
          const before = known.get(n.key);
          return before === undefined || (before !== contentOf(n) && !n.alert_once);
        });
        if (fresh.length === 0) return;
        const { systemCenter: toCenter, deviceName: name } = optionsRef.current;
        if (toCenter) fresh.forEach((n) => notifyMac(serial, n, name, iconsRef.current[n.package]));
      } catch { }
    };

    if (!mirroring) poll();
    const timer = setInterval(poll, mirroring ? MIRRORING_POLL_MS : POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [serial, mirroring]);

  useEffect(() => {
    if (!serial) return;
    const missing = [...new Set(items.map((n) => n.package))].filter((pkg) => !icons[pkg] && canFetchIcon(pkg));
    if (missing.length === 0) return;
    fetchIcons(serial, missing)
      .then((found) => {
        const fetched = Object.entries(found).filter((entry): entry is [string, string] => entry[1] !== null);
        if (fetched.length === 0) return;
        setIcons((prev) => {
          const next = { ...prev };
          for (const [pkg, png] of fetched) next[pkg] = `data:image/png;base64,${png}`;
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
