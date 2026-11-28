import { invoke } from "@tauri-apps/api/core";
import type { LatencyResult } from "../hooks/useLatencyProbe";

/** What the main window tells a mirror window about its phone when it opens it. */
export interface MirrorIdentity {
  serial: string;
  title: string;
  model: string;
  brand: string;
  path: string;
}

declare global {
  interface Window {
    __ANOTHER_MIRROR__?: MirrorIdentity;
  }
}

/** Set in mirror windows only, by the script the window is created with. */
export const mirrorIdentity: MirrorIdentity | null = window.__ANOTHER_MIRROR__ ?? null;

/** Matches `mirror_label` in commands.rs. */
export function mirrorLabel(serial: string) {
  return `mirror-${serial.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** What a mirror window reports to the main window. */
export interface MirrorState {
  serial: string;
  label: string;
  connecting: boolean;
  streamReady: boolean;
  nativeActive: boolean;
  latencyMs: number | null;
  focused: boolean;
  probe: { running: boolean; result: LatencyResult | null; error: string | null };
}

export type MirrorCommand = { action: "measure" } | { action: "record-macro" } | { action: "run-macro"; name: string };

export const MIRROR_STATE_EVENT = "mirror-state";
export const MIRROR_STATE_REQUEST = "mirror-state-request";
export const MIRROR_DROPPED_EVENT = "mirror-dropped";
export const MIRROR_CLOSED_EVENT = "mirror-closed";
export const MIRROR_COMMAND_EVENT = "mirror-command";
export const OPEN_SETTINGS_EVENT = "open-settings";

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const boundsKey = (serial: string) => `mirror_bounds:${serial}`;

export function readMirrorBounds(serial: string): WindowBounds | null {
  try {
    const stored = localStorage.getItem(boundsKey(serial));
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

export function saveMirrorBounds(serial: string, bounds: WindowBounds) {
  try {
    localStorage.setItem(boundsKey(serial), JSON.stringify(bounds));
  } catch { }
}

/** Opens the phone's own window, or brings it forward when it is already open. */
export function openMirror(identity: MirrorIdentity) {
  const { serial, title, ...details } = identity;
  return invoke("open_mirror", { serial, title, details, bounds: readMirrorBounds(serial) });
}
