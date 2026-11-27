import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings, Device, QuickActionId, DevSettings, Profile, RemoteCommand } from "./types";
import { PRESETS, DEFAULT_PINNED_ACTIONS, DEFAULT_DEV_SETTINGS } from "./types";
import { isNetworkSerial } from "@/lib/utils";
import { useTheme } from "./hooks/useTheme";
import { useToasts } from "./hooks/useToasts";
import { useDevices } from "./hooks/useDevices";
import { useConnection } from "./hooks/useConnection";
import { useAdaptiveBitrate } from "./hooks/useAdaptiveBitrate";
import { useMacro } from "./hooks/useMacro";
import { useLatencyProbe } from "./hooks/useLatencyProbe";
import { useProfiles, sanitizeProfile } from "./hooks/useProfiles";
import { useUpdater } from "./hooks/useUpdater";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { MirrorScreen } from "./components/MirrorScreen";
import { SettingsDialog } from "./components/SettingsDialog";
import { CommandBar } from "./components/CommandBar";
import { MacrosScreen } from "./components/MacrosScreen";
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

const LIVE_KEYS: (keyof Settings)[] = ["video_bit_rate", "max_size", "max_fps"];
const LIVE_SIZE_DEBOUNCE_MS = 300;
const RECONNECT_DEV_KEYS: (keyof DevSettings)[] = ["directAdb", "lowLatency", "encoderTuning", "anotherServer", "nativeVideo", "networkStream"];

function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [showCommandBar, setShowCommandBar] = useState(false);
  const [showMacros, setShowMacros] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => {
    const stored = localStorage.getItem("stream_settings");
    if (stored) {
      try { return { ...PRESETS.balanced, ...JSON.parse(stored) }; } catch { }
    }
    return PRESETS.balanced;
  });
  const [activePreset, setActivePreset] = useState(() => {
    return localStorage.getItem("active_preset") || "balanced";
  });

  const [devSettings, setDevSettings] = useState<DevSettings>(() => {
    const stored = localStorage.getItem("dev_settings");
    if (stored) {
      try { return { ...DEFAULT_DEV_SETTINGS, ...JSON.parse(stored) }; } catch { }
    }
    return DEFAULT_DEV_SETTINGS;
  });

  const [pinnedActions, setPinnedActions] = useState<QuickActionId[]>(() => {
    localStorage.removeItem("pinned_actions");
    return DEFAULT_PINNED_ACTIONS;
  });

  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const toggleAlwaysOnTop = useCallback(async () => {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    await getCurrentWindow().setAlwaysOnTop(next);
  }, [alwaysOnTop]);

  const { themePref, setThemePref, cycleTheme } = useTheme();
  const { toasts, showToast } = useToasts();
  const { devices, refreshDevices } = useDevices(showToast);
  const macro = useMacro({ showToast, onRecordingStopped: () => setShowMacros(true) });
  const updater = useUpdater(showToast);

  const takeScreenshot = useCallback(async () => {
    try {
      const base64 = await invoke<string>("take_screenshot");
      const savePath = localStorage.getItem("save_path");
      if (savePath) {
        const filename = `screenshot-${Date.now()}.png`;
        const fullPath = `${savePath}/${filename}`;
        await invoke("save_file", { path: fullPath, data: base64 });
      } else {
        const link = document.createElement("a");
        link.href = `data:image/png;base64,${base64}`;
        link.download = `screenshot-${Date.now()}.png`;
        link.click();
      }
      showToast("Screenshot saved", "info");
    } catch (e) {
      showToast(`Screenshot failed: ${e}`);
    }
  }, [showToast]);

  const adaptiveRef = useRef<{
    frameReceived: () => void;
    packetReceived: (ptsUs: number) => void;
    nativeSample: (fps: number, lagMinMs: number) => void;
    disableAdaptive: () => void;
  }>({
    frameReceived: () => { },
    packetReceived: () => { },
    nativeSample: () => { },
    disableAdaptive: () => { },
  });

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const connectedDeviceRef = useRef<Device | null>(null);
  const scheduleReconnectRef = useRef<((s: Settings) => void) | null>(null);

  const handleCodecFallback = useCallback((codec: string) => {
    const next = { ...settingsRef.current, video_codec: codec };
    setSettings(next);
    if (connectedDeviceRef.current) scheduleReconnectRef.current?.(next);
  }, []);

  const {
    screen,
    connectedDevice,
    connectingSerial,
    deviceSize,
    streamReady,
    perfStats,
    nativeActive,
    canvasRef,
    frameDrawnRef,
    decoderRef,
    isMouseDownRef,
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
    handleCompositionStart,
    handleCompositionEnd,
  } = useConnection({
    settings,
    showToast,
    takeScreenshot,
    setShowSettings: (fn) => setShowSettings(fn),
    setThemePref: (fn) => setThemePref(fn),
    onToggleAlwaysOnTop: toggleAlwaysOnTop,
    onFrameReceived: () => adaptiveRef.current.frameReceived(),
    onPacketReceived: (ptsUs) => adaptiveRef.current.packetReceived(ptsUs),
    onNativeStats: (fps, lagMinMs) => adaptiveRef.current.nativeSample(fps, lagMinMs),
    onCodecFallback: handleCodecFallback,
    onRecordEvent: macro.recordEvent,
    perfOverlay: devSettings.perfOverlay,
    directAdb: devSettings.directAdb,
    lowLatency: devSettings.lowLatency,
    encoderTuning: devSettings.encoderTuning,
    anotherServer: devSettings.anotherServer,
    nativeVideo: devSettings.nativeVideo,
    networkStream: devSettings.networkStream,
  });

  const latencyProbe = useLatencyProbe({ canvasRef, frameDrawnRef, native: nativeActive });

  scheduleReconnectRef.current = scheduleReconnect;
  connectedDeviceRef.current = connectedDevice;

  const liveSizeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  /** Sends bitrate, size and fps changes to the running Another server. Returns false when a reconnect is needed. */
  const applyLive = (prev: Settings, next: Settings): boolean => {
    if (!devSettings.anotherServer) return false;
    const changed = (Object.keys(next) as (keyof Settings)[]).filter((key) => next[key] !== prev[key]);
    if (changed.some((key) => !LIVE_KEYS.includes(key) && key !== "adaptive")) return false;
    const fallback = () => scheduleReconnect(next);
    if (next.video_bit_rate !== prev.video_bit_rate) {
      invoke("set_video_bit_rate", { bitRate: next.video_bit_rate }).catch(fallback);
    }
    if (next.max_size !== prev.max_size || next.max_fps !== prev.max_fps) {
      clearTimeout(liveSizeTimer.current);
      liveSizeTimer.current = setTimeout(() => {
        invoke("set_video_size", { maxSize: next.max_size, maxFps: next.max_fps }).catch(fallback);
      }, LIVE_SIZE_DEBOUNCE_MS);
    }
    return true;
  };

  const applyLiveRef = useRef(applyLive);
  applyLiveRef.current = applyLive;

  const onNetwork = !!connectedDevice && isNetworkSerial(connectedDevice.serial);
  const adaptiveEnabled = settings.adaptive || (onNetwork && settings.adaptive_network !== false);

  const adaptive = useAdaptiveBitrate({
    enabled: adaptiveEnabled,
    native: nativeActive,
    decoder: decoderRef,
    currentSettings: settings,
    onTierChange: (newSettings) => {
      setActivePreset("");
      setSettings(newSettings);
      if (connectedDevice && !applyLive(settings, newSettings)) scheduleReconnect(newSettings);
    },
  });

  adaptiveRef.current = adaptive;

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const next = { ...settings, [key]: value };
    if (key === "adaptive_network") {
      setSettings(next);
      localStorage.setItem("stream_settings", JSON.stringify(next));
      return;
    }
    if (key !== "audio" && key !== "adaptive") {
      next.adaptive = false;
      adaptive.disableAdaptive();
    }
    setSettings(next);
    localStorage.setItem("stream_settings", JSON.stringify(next));
    if (key !== "audio" && key !== "adaptive") {
      setActivePreset("");
      localStorage.setItem("active_preset", "");
    }
    if (!connectedDevice) return;
    if (LIVE_KEYS.includes(key) && applyLive(settings, next)) return;
    scheduleReconnect(next);
  };

  const updateDevSetting = <K extends keyof DevSettings>(key: K, value: DevSettings[K]) => {
    const next = { ...devSettings, [key]: value };
    setDevSettings(next);
    localStorage.setItem("dev_settings", JSON.stringify(next));
    if (RECONNECT_DEV_KEYS.includes(key) && connectedDevice) {
      scheduleReconnect(settings);
    }
  };

  const devSettingsRef = useRef(devSettings);
  devSettingsRef.current = devSettings;
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  const applyProfile = useCallback((profile: Profile, reconnect = true): { settings: Settings; dev: DevSettings } => {
    const clean = sanitizeProfile(profile);
    const prevSettings = settingsRef.current;
    const nextSettings = { ...prevSettings, ...clean.stream };
    const nextDev = { ...devSettingsRef.current, ...clean.dev };
    const devChanged = RECONNECT_DEV_KEYS.some((key) => nextDev[key] !== devSettingsRef.current[key]);
    setSettings(nextSettings);
    setDevSettings(nextDev);
    setActivePreset("");
    localStorage.setItem("stream_settings", JSON.stringify(nextSettings));
    localStorage.setItem("dev_settings", JSON.stringify(nextDev));
    localStorage.setItem("active_preset", "");
    if (!nextSettings.adaptive) adaptiveRef.current.disableAdaptive();
    if (reconnect && connectedDeviceRef.current && (devChanged || !applyLiveRef.current(prevSettings, nextSettings))) {
      scheduleReconnectRef.current?.(nextSettings);
    }
    return { settings: nextSettings, dev: nextDev };
  }, []);

  const profiles = useProfiles({ settings, devSettings, onApply: applyProfile, showToast });

  const connectBySerial = (serial: string, s: Settings, dev?: DevSettings) => {
    const device = devicesRef.current.find((d) => d.serial === serial) ?? { serial, model: serial, state: "device" };
    connectToDevice(device, s, false, dev);
  };

  const remoteHandlerRef = useRef<(command: RemoteCommand) => void>(() => { });
  remoteHandlerRef.current = (command) => {
    if (command.action === "apply") {
      const next = applyProfile(command.profile, !command.connect);
      if (command.connect) connectBySerial(command.connect, next.settings, next.dev);
    } else if (command.action === "connect") {
      connectBySerial(command.serial, settingsRef.current);
    } else if (command.action === "disconnect") {
      disconnect();
    } else if (command.action === "measure") {
      latencyProbe.run();
    }
  };

  const [remoteReady, setRemoteReady] = useState(false);
  useEffect(() => {
    const unlisten = listen<RemoteCommand>("remote-command", (e) => remoteHandlerRef.current(e.payload));
    unlisten.then(() => setRemoteReady(true));
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    if (!remoteReady) return;
    invoke("report_ui_state", {
      state: {
        connected: connectedDevice?.serial ?? null,
        model: connectedDevice?.model ?? null,
        streamReady,
        nativeActive,
        profile: profiles.currentProfile(),
        devices: devices.map((d) => ({ serial: d.serial, model: d.model, state: d.state })),
      },
    }).catch(() => { });
  }, [remoteReady, connectedDevice, streamReady, nativeActive, devices, profiles]);

  useEffect(() => {
    if (!remoteReady) return;
    invoke<RemoteCommand[]>("take_pending_commands")
      .then((pending) => pending.forEach((command) => remoteHandlerRef.current(command)))
      .catch(() => { });
  }, [remoteReady]);

  const applyPreset = (name: string) => {
    const next = { ...PRESETS[name], audio: settings.audio };
    setSettings(next);
    setActivePreset(name);
    localStorage.setItem("stream_settings", JSON.stringify(next));
    localStorage.setItem("active_preset", name);
    adaptive.disableAdaptive();
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
    { id: "rotate", label: "Rotate Device", keys: [MOD, "⇧", "O"], key: "o", shift: true, section: "Device", action: () => { invoke("rotate_device").catch((e) => showToast(`Rotate failed: ${e}`)); } },
    { id: "cmdbar", label: "Command Bar", keys: [MOD, "K"], key: "k", section: "Actions", action: () => setShowCommandBar((s) => !s) },
    { id: "macro-toggle", label: macro.macroRecording ? "Stop Macro Recording" : "Record Macro", keys: [MOD, "⇧", "M"], key: "m", shift: true, section: "Macros", action: macro.toggleRecording },
    { id: "macro-play", label: "Play Last Macro", keys: [MOD, "⇧", "P"], key: "p", shift: true, section: "Macros", action: () => { if (macro.macros.length > 0) macro.playMacro(macro.macros[macro.macros.length - 1].name); } },
    { id: "macro-manage", label: "Manage Macros", keys: [MOD, "⇧", "L"], key: "l", shift: true, section: "Macros", action: () => setShowMacros(true) },
    { id: "macro-export", label: "Export All Macros", keys: [MOD, "⇧", "E"], key: "e", shift: true, section: "Macros", action: macro.exportAllMacros },
    { id: "macro-import", label: "Import Macros", keys: [MOD, "⇧", "I"], key: "i", shift: true, section: "Macros", action: macro.importMacros },
    { id: "check-updates", label: "Check for Updates", keys: [MOD, "⇧", "U"], key: "u", shift: true, section: "Actions", action: () => updater.checkForUpdates() },
    { id: "always-on-top", label: alwaysOnTop ? "Disable Always on Top" : "Always on Top", keys: [MOD, "⇧", "T"], key: "t", shift: true, section: "Actions", action: toggleAlwaysOnTop },
  ], [muted, recording, setMuted, toggleRecording, pressButton, takeScreenshot, cycleTheme, disconnect, macro.macroRecording, macro.toggleRecording, macro.macros, macro.playMacro, macro.exportAllMacros, macro.importMacros, updater.checkForUpdates, alwaysOnTop, toggleAlwaysOnTop]);

  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  useEffect(() => {
    const mcpEnabled = localStorage.getItem("mcp_enabled") !== "false";
    if (mcpEnabled) {
      const port = parseInt(localStorage.getItem("mcp_port") || "7070", 10);
      invoke("start_mcp_server", { port }).catch(() => { });
    }
    updater.checkForUpdates(true);
  }, []);

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
      {showMacros ? (
        <MacrosScreen
          macros={macro.macros}
          macrosDir={macro.macrosDir}
          playingMacro={macro.playingMacro}
          onBack={() => setShowMacros(false)}
          onPlay={(name) => {
            setShowMacros(false);
            setTimeout(() => macro.playMacro(name), 500);
          }}
          onDelete={macro.deleteMacro}
          onRename={macro.renameMacro}
          onReorder={macro.reorderMacros}
          onExport={macro.exportMacro}
          onExportAll={macro.exportAllMacros}
          onImport={macro.importMacros}
          onSetDir={macro.setMacrosDir}
          showToast={showToast}
        />
      ) : screen === "welcome" ? (
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
          streamReady={streamReady}
          deviceSize={deviceSize}
          canvasRef={canvasRef}
          isMouseDownRef={isMouseDownRef}
          recording={recording}
          muted={muted}
          macroRecording={macro.macroRecording}
          pinnedActions={pinnedActions}
          alwaysOnTop={alwaysOnTop}
          perfStats={perfStats}
          nativeVideo={nativeActive}
          adaptiveInfo={adaptiveEnabled ? { enabled: true, tierName: adaptive.metrics.tierName, fps: adaptive.metrics.fps, lagMs: adaptive.metrics.lagMs } : undefined}
          onToggleRecording={toggleRecording}
          onToggleMacroRecording={macro.toggleRecording}
          onPressButton={pressButton}
          onTakeScreenshot={takeScreenshot}
          onToggleSettings={() => setShowSettings((s) => !s)}
          onOpenCommandBar={() => setShowCommandBar(true)}
          onDisconnect={disconnect}
          onRotate={() => { invoke("rotate_device").catch((e) => showToast(`Rotate failed: ${e}`)); }}
          onToggleAlwaysOnTop={toggleAlwaysOnTop}
          onToggleMute={() => setMuted(!muted)}
          onCanvasMouseEvent={handleCanvasMouseEvent}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
        />
      ) : null}

      <SettingsDialog
        open={showSettings}
        onOpenChange={setShowSettings}
        settings={settings}
        activePreset={activePreset}
        pinnedActions={pinnedActions}
        onApplyPreset={applyPreset}
        onUpdateSetting={updateSetting}
        onPinnedActionsChange={setPinnedActions}
        devSettings={devSettings}
        onUpdateDevSetting={updateDevSetting}
        latencyProbe={connectedDevice ? latencyProbe : null}
        onExportProfile={profiles.exportProfile}
        onImportProfile={profiles.importProfile}
        onCopyProfileLink={profiles.copyProfileLink}
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
