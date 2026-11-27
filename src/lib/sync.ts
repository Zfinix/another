import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Windows of the app share localStorage, but WebKit does not fire storage events between them,
 * so every write to a shared key is also announced to the other windows as a Tauri event.
 */

const STORED_EVENT = "stored";
const self = getCurrentWindow().label;

interface Stored {
  key: string;
  value: string | null;
  from: string;
}

/** Saves a shared value and tells the other windows about it. */
export function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch { }
  emit(STORED_EVENT, { key, value, from: self } satisfies Stored).catch(() => { });
}

/** Calls `handle` when another window stores `key`. Returns the unsubscribe function. */
export function onStored(key: string, handle: (value: string | null) => void): () => void {
  let active = true;
  let unlisten: (() => void) | null = null;
  listen<Stored>(STORED_EVENT, ({ payload }) => {
    if (payload.key === key && payload.from !== self) handle(payload.value);
  }).then((fn) => {
    if (active) unlisten = fn;
    else fn();
  });
  return () => {
    active = false;
    unlisten?.();
  };
}

export function readStoredJson<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return stored ? { ...fallback, ...JSON.parse(stored) } : fallback;
  } catch {
    return fallback;
  }
}

/** Tells the other windows that something they list, such as macros or recordings, changed. */
export function announce(topic: string) {
  emit(STORED_EVENT, { key: `changed:${topic}`, value: String(Date.now()), from: self } satisfies Stored).catch(() => { });
}

export function onAnnounced(topic: string, handle: () => void): () => void {
  return onStored(`changed:${topic}`, () => handle());
}
