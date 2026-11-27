import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { DevSettings, Profile, Settings } from "../types";
import { DEFAULT_DEV_SETTINGS, PRESETS, PROFILE_VERSION } from "../types";

function pickKnown<T extends object>(values: unknown, template: T): Partial<T> {
  if (!values || typeof values !== "object") return {};
  const out: Partial<T> = {};
  for (const key of Object.keys(template) as (keyof T)[]) {
    const value = (values as Record<string, unknown>)[key as string];
    if (value !== undefined && typeof value === typeof template[key]) out[key] = value as T[keyof T];
  }
  return out;
}

export function sanitizeProfile(raw: unknown): Profile {
  const source = (raw ?? {}) as { stream?: unknown; dev?: unknown };
  return {
    version: PROFILE_VERSION,
    stream: pickKnown(source.stream, PRESETS.balanced),
    dev: pickKnown(source.dev, DEFAULT_DEV_SETTINGS),
  };
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
  showToast: (msg: string, type?: "error" | "info") => void;
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
      showToast("Profile exported", "info");
    } catch (e) {
      showToast(`Export failed: ${e}`);
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
      showToast("Profile applied", "info");
    } catch (e) {
      showToast(`Import failed: ${e}`);
    }
  }, [onApply, showToast]);

  const copyProfileLink = useCallback(async () => {
    const link = `another://apply?profile=${toBase64Url(JSON.stringify(currentProfile()))}`;
    try {
      await navigator.clipboard.writeText(link);
      showToast("Profile link copied", "info");
    } catch (e) {
      showToast(`Copy failed: ${e}`);
    }
  }, [currentProfile, showToast]);

  return { currentProfile, exportProfile, importProfile, copyProfileLink };
}
