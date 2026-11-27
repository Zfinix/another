import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { ShowToast } from "../types";

interface SentFiles {
  installed: string[];
  pushed: string[];
  failed: { name: string; error: string }[];
}

export type FileDropState = { kind: "hover" | "busy"; label: string } | null;

const isApk = (path: string) => path.toLowerCase().endsWith(".apk");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function describe(paths: string[], busy: boolean) {
  const apks = paths.filter(isApk).length;
  const files = paths.length - apks;
  const parts = [
    apks > 0 && (busy ? `Installing ${plural(apks, "app")}` : `Install ${plural(apks, "app")}`),
    files > 0 && (busy ? `sending ${plural(files, "file")} to Downloads` : `send ${plural(files, "file")} to Downloads`),
  ].filter(Boolean) as string[];
  const text = parts.join(" and ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Installs dropped APKs and pushes every other dropped file to the phone's Downloads folder. */
export function useFileDrop(serial: string | null, showToast: ShowToast) {
  const [hover, setHover] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const jobs = useRef(0);

  useEffect(() => {
    if (!serial) return;
    const send = async (paths: string[]) => {
      jobs.current++;
      setBusy(describe(paths, true));
      try {
        const result = await invoke<SentFiles>("send_files", { serial, paths });
        const done = [
          result.installed.length > 0 && `Installed ${result.installed.length === 1 ? result.installed[0] : plural(result.installed.length, "app")}`,
          result.pushed.length > 0 && `Sent ${result.pushed.length === 1 ? result.pushed[0] : plural(result.pushed.length, "file")} to Downloads`,
        ].filter(Boolean) as string[];
        if (done.length > 0) showToast(done.join(". "), "success");
        for (const f of result.failed) showToast(`Could not send ${f.name}`, "error", { detail: f.error });
      } catch (e) {
        showToast("Could not send the files", "error", { detail: `${e}` });
      } finally {
        if (--jobs.current === 0) setBusy(null);
      }
    };
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter") setHover(payload.paths.length > 0 ? describe(payload.paths, false) : null);
      else if (payload.type === "leave") setHover(null);
      else if (payload.type === "drop") {
        setHover(null);
        if (payload.paths.length > 0) send(payload.paths);
      }
    });
    return () => {
      setHover(null);
      unlisten.then((off) => off());
    };
  }, [serial, showToast]);

  const state: FileDropState = hover ? { kind: "hover", label: hover } : busy ? { kind: "busy", label: busy } : null;
  return state;
}
