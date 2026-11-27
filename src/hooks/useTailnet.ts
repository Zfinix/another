import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TailnetStatus } from "../types";

const TAILNET_POLL_MS = 15000;

export function useTailnet() {
  const [status, setStatus] = useState<TailnetStatus | null>(null);

  const refresh = useCallback(() => {
    invoke<TailnetStatus>("tailnet_status").then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, TAILNET_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return { status, refresh };
}
