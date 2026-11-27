import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

const PREVIEW_WIDTH = 720;
const PREVIEW_QUALITY = 0.92;
const DARK_FRAME_LUMA = 6;
const storageKey = (serial: string) => `lock_preview_${serial}`;

const LEGACY_PREFIX = "preview_";

function dropLegacyPreviews() {
  try {
    Object.keys(localStorage).filter((k) => k.startsWith(LEGACY_PREFIX)).forEach((k) => localStorage.removeItem(k));
  } catch { }
}

dropLegacyPreviews();

function readStored(serial: string): string | null {
  try {
    return localStorage.getItem(storageKey(serial));
  } catch {
    return null;
  }
}

/** Scales a lock screen PNG to a sharp JPEG sized for the phone frame on Retina screens. */
async function shrink(base64Png: string): Promise<string | null> {
  const img = new Image();
  img.src = `data:image/png;base64,${base64Png}`;
  await img.decode();
  const width = Math.min(PREVIEW_WIDTH, img.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round(img.naturalHeight * (width / img.naturalWidth));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let sum = 0;
  for (let i = 0; i < data.length; i += 16) sum += data[i] + data[i + 1] + data[i + 2];
  if (sum / (data.length / 16) / 3 < DARK_FRAME_LUMA) return null;
  return canvas.toDataURL("image/jpeg", PREVIEW_QUALITY);
}

export function usePreviews() {
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const inFlight = useRef(new Set<string>());

  const preview = useCallback((serial: string): string | null => previews[serial] ?? readStored(serial), [previews]);

  const capture = useCallback(async (serial: string) => {
    if (inFlight.current.has(serial)) return;
    inFlight.current.add(serial);
    try {
      const png = await invoke<string | null>("device_screenshot", { serial });
      if (!png) return;
      const small = await shrink(png);
      if (!small) return;
      try { localStorage.setItem(storageKey(serial), small); } catch { }
      setPreviews((prev) => ({ ...prev, [serial]: small }));
    } catch {
    } finally {
      inFlight.current.delete(serial);
    }
  }, []);

  return { preview, capture };
}
