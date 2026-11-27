import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Device, ShowToast } from "../types";

const VISIBLE_STATES = ["device", "unauthorized"];

export function useDevices(showToast: ShowToast) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refreshDevices = useCallback(async () => {
    try {
      const devs = await invoke<Device[]>("list_devices");
      const visible = devs.filter((d) => VISIBLE_STATES.includes(d.state));
      const wifiModels = new Set(visible.filter((d) => d.serial.includes(":")).map((d) => d.model));
      setDevices(visible.map((d) => ({ ...d, wifi_available: wifiModels.has(d.model) })));
    } catch (e) {
      showToast("Could not list phones", "error", { detail: `${e}` });
    } finally {
      setLoaded(true);
    }
  }, [showToast]);

  useEffect(() => {
    refreshDevices();
    const interval = setInterval(refreshDevices, 3000);
    return () => clearInterval(interval);
  }, [refreshDevices]);

  return { devices, loaded, refreshDevices };
}
