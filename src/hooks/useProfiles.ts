import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { DevSettings, Profile, Settings, ShowToast } from "../types";
import { DEFAULT_DEV_SETTINGS, DEFAULT_SETTINGS, ENCODER_TUNING_OPTIONS, PROFILE_VERSION } from "../types";

const ALLOWED_VALUES: Record<string, unknown[]> = {
  video_codec: ["h264", "h265"],
  encoderTuning: ENCODER_TUNING_OPTIONS.map((option) => option.value),
};

function pickKnown<T extends object>(values: unknown, template: T): Partial<T> {
  if (!values || typeof values !== "object") return {};
  const out: Partial<T> = {};
  for (const key of Object.keys(template) as (keyof T)[]) {
    const value = (values as Record<string, unknown>)[key as string];
    if (value === undefined || typeof value !== typeof template[key]) continue;
    if (ALLOWED_VALUES[key as string]?.includes(value) === false) continue;
    out[key] = value as T[keyof T];
  }
  return out;
}

export function sanitizeProfile(raw: unknown): Profile {
  const source = (raw ?? {}) as { stream?: unknown; dev?: unknown };
  return {
    version: PROFILE_VERSION,
    stream: pickKnown(source.stream, DEFAULT_SETTINGS),
    dev: pickKnown(source.dev, DEFAULT_DEV_SETTINGS),
  };
}

/** Lists a profile's settings as the `key=value` pairs `another set` takes. */
export function describeProfile(profile: Profile): string[] {
  const clean = sanitizeProfile(profile);
  return [...Object.entries(clean.stream ?? {}), ...Object.entries(clean.dev ?? {})].map(
    ([name, value]) => `${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}=${value}`,
  );
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toBase64Url(text: string): string {
  return toBase64(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface UseProfilesOptions {
  settings: Settings;
  devSettings: DevSettings;
  onApply: (profile: Profile) => void;
  showToast: ShowToast;
}

export function useProfiles({ settings, devSettings, onApply, showToast }: UseProfilesOptions) {
  const currentProfile = useCallback(
    (): Profile => ({ version: PROFILE_VERSION, stream: settings, dev: devSettings }),
    [settings, devSettings],
  );

  const exportProfile = useCallback(async () => {
    const path = await saveDialog({
      defaultPath: "another-profile.json",
      filters: [{ name: "Another profile", extensions: ["json"] }],
    });
    if (!path) return;
    try {
      await invoke("save_file", { path, data: toBase64(JSON.stringify(currentProfile(), null, 2)) });
      showToast("Profile exported", "success");
    } catch (e) {
      showToast("Could not export the profile", "error", { detail: `${e}` });
    }
  }, [currentProfile, showToast]);

  const importProfile = useCallback(async () => {
    const path = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Another profile", extensions: ["json"] }],
    });
    if (!path || Array.isArray(path)) return;
    try {
      const text = await invoke<string>("read_text_file", { path });
      onApply(sanitizeProfile(JSON.parse(text)));
      showToast("Profile applied", "success");
    } catch (e) {
      showToast("Could not import the profile", "error", { detail: `${e}` });
    }
  }, [onApply, showToast]);

  const copyProfileLink = useCallback(async () => {
    const link = `another://apply?profile=${toBase64Url(JSON.stringify(currentProfile()))}`;
    try {
      await navigator.clipboard.writeText(link);
      showToast("Profile link copied", "success");
    } catch (e) {
      showToast("Could not copy the link", "error", { detail: `${e}` });
    }
  }, [currentProfile, showToast]);

  return { currentProfile, exportProfile, importProfile, copyProfileLink };
}
