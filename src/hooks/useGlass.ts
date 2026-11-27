import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { onStored, readStoredJson, store } from "@/lib/sync";

const isMac = navigator.userAgent.includes("Mac");
const STORAGE_KEY = "window_glass";
const DEFAULT_GLASS = { opacity: 72, blur: 40 };
const MAX_GLASS_BLUR_PX = 60;
const BLUR_APPLY_DEBOUNCE_MS = 40;

export interface Glass {
  opacity: number;
  blur: number;
}

/** The window's glass opacity and blur, shared by every window. */
export function useGlass() {
  const [glass, setGlassState] = useState<Glass>(() => readStoredJson(STORAGE_KEY, DEFAULT_GLASS));

  useEffect(() => {
    document.documentElement.classList.toggle("vibrancy", isMac);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--glass-alpha", String(glass.opacity / 100));
    root.style.setProperty("--glass-blur", `${(glass.blur * MAX_GLASS_BLUR_PX) / 100}px`);
  }, [glass]);

  useEffect(() => {
    if (!isMac) return;
    const timer = setTimeout(() => {
      invoke("set_window_blur", { percent: glass.blur }).catch(() => { });
    }, BLUR_APPLY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [glass.blur]);

  useEffect(() => onStored(STORAGE_KEY, () => setGlassState(readStoredJson(STORAGE_KEY, DEFAULT_GLASS))), []);

  const setGlass = (next: Glass) => {
    setGlassState(next);
    store(STORAGE_KEY, JSON.stringify(next));
  };

  return { glass, setGlass };
}
