import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MacroEvent, MacroTimedEvent, SavedMacro, ShowToast } from "../types";

export interface MacroInfo {
  name: string;
  event_count: number;
}

interface UseMacroOptions {
  showToast: ShowToast;
  onRecordingStopped?: () => void;
}

export function useMacro({ showToast, onRecordingStopped }: UseMacroOptions) {
  const [macroRecording, setMacroRecording] = useState(false);
  const [playingMacro, setPlayingMacro] = useState<string | null>(null);
  const [macros, setMacros] = useState<MacroInfo[]>([]);
  const [macrosDir, setMacrosDirState] = useState<string>("");

  const recordingRef = useRef(false);
  const eventsRef = useRef<MacroTimedEvent[]>([]);
  const startTimeRef = useRef(0);

  const refreshMacros = useCallback(async (dir?: string) => {
    const d = dir || macrosDir;
    if (!d) return;
    try {
      const list = await invoke<MacroInfo[]>("list_macro_files", { dir: d });
      setMacros(list);
    } catch {
      setMacros([]);
    }
  }, [macrosDir]);

  useEffect(() => {
    (async () => {
      const stored = localStorage.getItem("macros_dir");
      if (stored) {
        setMacrosDirState(stored);
        refreshMacros(stored);
      } else {
        try {
          const defaultDir = await invoke<string>("get_default_macros_dir");
          setMacrosDirState(defaultDir);
          localStorage.setItem("macros_dir", defaultDir);
          refreshMacros(defaultDir);
        } catch {}
      }
    })();
  }, []);

  const setMacrosDir = useCallback(
    (dir: string) => {
      setMacrosDirState(dir);
      localStorage.setItem("macros_dir", dir);
      refreshMacros(dir);
    },
    [refreshMacros],
  );

  const startRecording = useCallback(() => {
    eventsRef.current = [];
    startTimeRef.current = Date.now();
    recordingRef.current = true;
    setMacroRecording(true);
    showToast("Recording a macro", "info");
  }, [showToast]);

  const stopRecording = useCallback(
    async (name?: string) => {
      recordingRef.current = false;
      setMacroRecording(false);
      const macroName = name || `Macro ${macros.length + 1}`;
      const macro: SavedMacro = {
        name: macroName,
        events: eventsRef.current,
      };
      eventsRef.current = [];
      try {
        await invoke("save_macro_file", { dir: macrosDir, macroData: macro });
        showToast(`Saved ${macroName}`, "success", { detail: `${macro.events.length} events` });
        refreshMacros();
        onRecordingStopped?.();
      } catch (e) {
        showToast("Could not save the macro", "error", { detail: `${e}` });
      }
    },
    [macros.length, macrosDir, showToast, refreshMacros, onRecordingStopped],
  );

  const toggleRecording = useCallback(() => {
    if (recordingRef.current) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [startRecording, stopRecording]);

  const recordEvent = useCallback((event: MacroEvent) => {
    if (!recordingRef.current) return;
    eventsRef.current.push({
      timestamp_ms: Date.now() - startTimeRef.current,
      event,
    });
  }, []);

  const playMacro = useCallback(
    async (name: string) => {
      setPlayingMacro(name);
      try {
        await invoke("wake_screen");
        const m = await invoke<SavedMacro>("load_macro_file", {
          dir: macrosDir,
          name,
        });
        await invoke("play_macro", { events: m.events });
        showToast(`Ran ${name}`, "success");
      } catch (e) {
        showToast(`Could not run ${name}`, "error", { detail: `${e}` });
      } finally {
        setPlayingMacro(null);
      }
    },
    [macrosDir, showToast],
  );

  const deleteMacro = useCallback(
    async (name: string) => {
      try {
        await invoke("delete_macro_file", { dir: macrosDir, name });
        showToast(`Deleted ${name}`, "success");
        refreshMacros();
      } catch (e) {
        showToast("Could not delete the macro", "error", { detail: `${e}` });
      }
    },
    [macrosDir, showToast, refreshMacros],
  );

  const renameMacro = useCallback(
    async (oldName: string, newName: string) => {
      try {
        await invoke("rename_macro_file", {
          dir: macrosDir,
          oldName,
          newName,
        });
        refreshMacros();
      } catch (e) {
        showToast("Could not rename the macro", "error", { detail: `${e}` });
      }
    },
    [macrosDir, showToast, refreshMacros],
  );

  const reorderMacros = useCallback(
    async (order: string[]) => {
      try {
        await invoke("save_macros_order", { dir: macrosDir, order });
        refreshMacros();
      } catch {}
    },
    [macrosDir, refreshMacros],
  );

  const exportMacro = useCallback(
    async (name: string) => {
      try {
        const m = await invoke<SavedMacro>("load_macro_file", {
          dir: macrosDir,
          name,
        });
        const blob = new Blob([JSON.stringify(m, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${name.replace(/\s+/g, "_")}.macro.json`;
        link.click();
        URL.revokeObjectURL(url);
        showToast(`Exported ${name}`, "success");
      } catch (e) {
        showToast("Could not export", "error", { detail: `${e}` });
      }
    },
    [macrosDir, showToast],
  );

  const exportAllMacros = useCallback(async () => {
    if (macros.length === 0) return;
    try {
      const all: SavedMacro[] = [];
      for (const info of macros) {
        const m = await invoke<SavedMacro>("load_macro_file", {
          dir: macrosDir,
          name: info.name,
        });
        all.push(m);
      }
      const blob = new Blob([JSON.stringify(all, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `macros-${Date.now()}.json`;
      link.click();
      URL.revokeObjectURL(url);
      showToast(`Exported ${macros.length} ${macros.length === 1 ? "macro" : "macros"}`, "success");
    } catch (e) {
      showToast("Could not export", "error", { detail: `${e}` });
    }
  }, [macros, macrosDir, showToast]);

  const importMacros = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const imported: SavedMacro[] = Array.isArray(data) ? data : [data];
        const valid = imported.filter(
          (m) => m.name && Array.isArray(m.events),
        );
        if (valid.length === 0) {
          showToast("No macros in that file", "error", { detail: "Pick a file exported from Another" });
          return;
        }
        const existingNames = new Set(macros.map((m) => m.name));
        for (const m of valid) {
          const name = existingNames.has(m.name)
            ? `${m.name} (imported)`
            : m.name;
          await invoke("save_macro_file", {
            dir: macrosDir,
            macroData: { ...m, name },
          });
        }
        showToast(`Imported ${valid.length} ${valid.length === 1 ? "macro" : "macros"}`, "success");
        refreshMacros();
      } catch {
        showToast("Could not read that file", "error", { detail: "Pick a file exported from Another" });
      }
    };
    input.click();
  }, [macros, macrosDir, showToast, refreshMacros]);

  return {
    macroRecording,
    playingMacro,
    macros,
    macrosDir,
    setMacrosDir,
    startRecording,
    stopRecording,
    toggleRecording,
    recordEvent,
    playMacro,
    deleteMacro,
    renameMacro,
    reorderMacros,
    exportMacro,
    exportAllMacros,
    importMacros,
    refreshMacros,
  };
}
