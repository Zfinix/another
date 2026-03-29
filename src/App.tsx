import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "./types";
import { PRESETS } from "./types";
import { useTheme } from "./hooks/useTheme";
import { useToasts } from "./hooks/useToasts";
import { useDevices } from "./hooks/useDevices";
import { useConnection } from "./hooks/useConnection";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { MirrorScreen } from "./components/MirrorScreen";
import { SettingsDialog } from "./components/SettingsDialog";
import { CommandBar } from "./components/CommandBar";
import { ToastContainer } from "./components/ToastContainer";
import "./App.css";

const isMac = navigator.userAgent.includes("Mac");
const MOD = isMac ? "⌘" : "Ctrl";

interface CommandDef {
  id: string;
  label: string;
  keys: string[];
  key: string;
  shift?: boolean;
  section: string;
  action: () => void;
}

function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [showCommandBar, setShowCommandBar] = useState(false);
  const [settings, setSettings] = useState<Settings>(PRESETS.balanced);
  const [activePreset, setActivePreset] = useState("balanced");

  const { themePref, setThemePref, cycleTheme } = useTheme();
  const { toasts, showToast } = useToasts();
  const { devices, refreshDevices } = useDevices(showToast);

  const takeScreenshot = useCallback(async () => {
    try {
      const base64 = await invoke<string>("take_screenshot");
      const link = document.createElement("a");
      link.href = `data:image/png;base64,${base64}`;
      link.download = `screenshot-${Date.now()}.png`;
      link.click();
      showToast("Screenshot saved", "info");
    } catch (e) {
      showToast(`Screenshot failed: ${e}`);
    }
  }, [showToast]);

  const {
    screen,
    connectedDevice,
    connectingSerial,
    deviceSize,
    canvasRef,
    isMouseDown,
    muted,
    recording,
    setMuted,
    toggleRecording,
    connectToDevice,
    disconnect,
    scheduleReconnect,
    pressButton,
    handleCanvasMouseEvent,
    handleWheel,
    handleKeyDown,
  } = useConnection({
    settings,
    showToast,
    takeScreenshot,
    setShowSettings: (fn) => setShowSettings(fn),
    setThemePref: (fn) => setThemePref(fn),
  });

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    setActivePreset("");
    if (connectedDevice) scheduleReconnect(next);
  };

  const applyPreset = (name: string) => {
    const next = PRESETS[name];
    setSettings(next);
    setActivePreset(name);
    if (connectedDevice) scheduleReconnect(next);
  };

  const commands: CommandDef[] = useMemo(() => [
    { id: "vol-up", label: "Volume Up", keys: [MOD, "+"], key: "=", section: "Audio", action: () => pressButton("volume_up") },
    { id: "vol-down", label: "Volume Down", keys: [MOD, "-"], key: "-", section: "Audio", action: () => pressButton("volume_down") },
    { id: "mute", label: muted ? "Unmute Audio" : "Mute Audio", keys: [MOD, "M"], key: "m", section: "Audio", action: () => setMuted(!muted) },
    { id: "screenshot", label: "Take Screenshot", keys: [MOD, "S"], key: "s", section: "Actions", action: takeScreenshot },
    { id: "record", label: recording ? "Stop Recording" : "Record Screen", keys: [MOD, "⇧", "R"], key: "r", shift: true, section: "Actions", action: toggleRecording },
    { id: "settings", label: "Open Settings", keys: [MOD, ","], key: ",", section: "Actions", action: () => setShowSettings(true) },
    { id: "theme", label: "Toggle Theme", keys: [MOD, "T"], key: "t", section: "Actions", action: cycleTheme },
    { id: "disconnect", label: "Disconnect", keys: [MOD, "D"], key: "d", section: "Actions", action: disconnect },
    { id: "home", label: "Home", keys: [MOD, "H"], key: "h", section: "Device", action: () => pressButton("home") },
    { id: "back", label: "Back", keys: [MOD, "B"], key: "b", section: "Device", action: () => pressButton("back") },
    { id: "recents", label: "Recent Apps", keys: [MOD, "R"], key: "r", section: "Device", action: () => pressButton("recents") },
    { id: "power", label: "Power Button", keys: [MOD, "P"], key: "p", section: "Device", action: () => pressButton("power") },
    { id: "cmdbar", label: "Command Bar", keys: [MOD, "K"], key: "k", section: "Actions", action: () => setShowCommandBar((s) => !s) },
  ], [muted, recording, setMuted, toggleRecording, pressButton, takeScreenshot, cycleTheme, disconnect]);

  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      if (showCommandBar && e.key !== "k") return;

      const cmd = commandsRef.current.find(
        (c) => c.key === e.key.toLowerCase() && !c.shift === !e.shiftKey
      );
      if (cmd) {
        e.preventDefault();
        cmd.action();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showCommandBar]);

  return (
    <>
      {screen === "welcome" ? (
        <WelcomeScreen
          devices={devices}
          connectingSerial={connectingSerial}
          themePref={themePref}
          onCycleTheme={cycleTheme}
          onOpenSettings={() => setShowSettings(true)}
          onRefreshDevices={refreshDevices}
          onConnectDevice={(d) => connectToDevice(d, settings)}
          showToast={showToast}
        />
      ) : connectedDevice ? (
        <MirrorScreen
          connectedDevice={connectedDevice}
          deviceSize={deviceSize}
          canvasRef={canvasRef}
          isMouseDown={isMouseDown}
          onPressButton={pressButton}
          onTakeScreenshot={takeScreenshot}
          onToggleSettings={() => setShowSettings((s) => !s)}
          onOpenCommandBar={() => setShowCommandBar(true)}
          onDisconnect={disconnect}
          onCanvasMouseEvent={handleCanvasMouseEvent}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
        />
      ) : null}

      <SettingsDialog
        open={showSettings}
        onOpenChange={setShowSettings}
        settings={settings}
        activePreset={activePreset}
        onApplyPreset={applyPreset}
        onUpdateSetting={updateSetting}
      />
      <CommandBar
        open={showCommandBar}
        onOpenChange={setShowCommandBar}
        commands={commands}
      />
      <ToastContainer toasts={toasts} />
    </>
  );
}

export default App;
