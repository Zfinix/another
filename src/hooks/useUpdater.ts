import type { ShowToast } from "../types";
import { useState, useCallback } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";

export function useUpdater(showToast: ShowToast) {
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);

  const checkForUpdates = useCallback(
    async (silent = false) => {
      if (checking || updating) return;
      setChecking(true);
      try {
        let update: Update | null = null;
        try {
          update = await check();
        } catch {
          if (!silent) showToast("No updates available right now", "info");
          return;
        }
        if (update) {
          showToast(`Downloading Another ${update.version}`, "info");
          setUpdating(true);
          await update.downloadAndInstall((event) => {
            if (event.event === "Finished") {
              showToast("Update installed", "success", { detail: "Restart Another to use it" });
            }
          });
        } else if (!silent) {
          showToast("You're on the latest version", "info");
        }
      } catch (e) {
        if (!silent) showToast("Could not check for updates", "error", { detail: `${e}` });
      } finally {
        setChecking(false);
        setUpdating(false);
      }
    },
    [checking, updating, showToast],
  );

  return { checking, updating, checkForUpdates };
}
