import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DeviceFacts } from "@/lib/devices";

const REFRESH_MS = 30_000;
const cache = new Map<string, DeviceFacts>();

/** Battery, storage, memory and display of the selected phone, refreshed while it stays selected. */
export function useDeviceFacts(serial: string | null): DeviceFacts | null {
  const [facts, setFacts] = useState<DeviceFacts | null>(() => (serial ? cache.get(serial) ?? null : null));

  useEffect(() => {
    setFacts(serial ? cache.get(serial) ?? null : null);
    if (!serial) return;
    let live = true;
    const load = () => {
      invoke<DeviceFacts>("device_facts", { serial })
        .then((next) => {
          cache.set(serial, next);
          if (live) setFacts(next);
        })
        .catch(() => { });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [serial]);

  return facts;
}
