import { useEffect, useState } from "react";
import { onStored, parseJson, readStoredJson, store } from "@/lib/sync";

const STORAGE_KEY = "window_glass";
const DEFAULT_GLASS = { opacity: 72, blur: 40 };
const MAX_GLASS_BLUR_PX = 60;

export interface Glass {
  opacity: number;
  blur: number;
}

/** The window's glass opacity and blur, shared by every window. */
export function useGlass() {
  const [glass, setGlassState] = useState<Glass>(() => readStoredJson(STORAGE_KEY, DEFAULT_GLASS));

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--glass-alpha", String(glass.opacity / 100));
    root.style.setProperty("--glass-blur", `${(glass.blur * MAX_GLASS_BLUR_PX) / 100}px`);
  }, [glass]);

  useEffect(() => onStored(STORAGE_KEY, (value) => setGlassState(parseJson(value, DEFAULT_GLASS))), []);

  const setGlass = (next: Glass) => {
    setGlassState(next);
    store(STORAGE_KEY, JSON.stringify(next));
  };

  return { glass, setGlass };
}
