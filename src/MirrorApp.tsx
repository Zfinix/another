import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, Window } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { downloadDir } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Settings, Device, QuickActionId, DevSettings } from "./types";
import { PRESETS, DEFAULT_PINNED_ACTIONS, DEFAULT_DEV_SETTINGS, QUICK_ACTION_ORDER } from "./types";
import { isNetworkSerial } from "@/lib/utils";
import { cleanError } from "@/lib/errors";
import { announce, onStored, readStoredJson, store } from "@/lib/sync";
import {
  mirrorLabel,
  readMirrorBounds,
  saveMirrorBounds,
  MIRROR_COMMAND_EVENT,
  MIRROR_DROPPED_EVENT,
  MIRROR_STATE_EVENT,
  MIRROR_STATE_REQUEST,
  OPEN_SETTINGS_EVENT,
  type MirrorCommand,
  type MirrorIdentity,
  type MirrorState,
} from "@/lib/mirror";
import { useTheme } from "./hooks/useTheme";
import { useGlass } from "./hooks/useGlass";
import { useToasts } from "./hooks/useToasts";
import { useConnection, windowSizeFor, CHROME_W, CHROME_H, MIRROR_MIN } from "./hooks/useConnection";
import { useAdaptiveBitrate } from "./hooks/useAdaptiveBitrate";
import { useMacro } from "./hooks/useMacro";
import { useLatencyProbe } from "./hooks/useLatencyProbe";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { MirrorScreen } from "./components/MirrorScreen";
import { FailedState, type StartStep } from "./components/StateViews";
import { CommandBar, type CommandDef } from "./components/CommandBar";
import { ToastContainer } from "./components/ToastContainer";

const isMac = navigator.userAgent.includes("Mac");
const MOD = isMac ? "⌘" : "Ctrl";
const MAIN_LABEL = "main";
const LIVE_KEYS: (keyof Settings)[] = ["video_bit_rate", "max_size", "max_fps"];
const LIVE_SIZE_DEBOUNCE_MS = 300;
const RECONNECT_DEV_KEYS: (keyof DevSettings)[] = ["directAdb", "lowLatency", "encoderTuning", "anotherServer", "nativeVideo", "networkStream"];
const STAY_ON_ALL_SOURCES = "7";
const BOUNDS_SAVE_MS = 400;
const RECORDING_SAVED_MS = 1500;
const MIN_VIEW_WIDTH = 280;

interface KeyedCommand extends CommandDef {
  key?: string;
  shift?: boolean;
}

function readPins(): QuickActionId[] {
  try {
    const stored = localStorage.getItem("toolbar_pins");
    const pins: QuickActionId[] = stored ? JSON.parse(stored) : DEFAULT_PINNED_ACTIONS;
    return pins.filter((id) => QUICK_ACTION_ORDER.includes(id));
  } catch {
    return DEFAULT_PINNED_ACTIONS;
  }
}

/** A saved window size wins, reshaped to the phone's aspect so the video fills it. */
function sizeFromBounds(serial: string, width: number, height: number): LogicalSize {
  const saved = readMirrorBounds(serial);
  if (!saved) return windowSizeFor(width, height);
  const viewHeight = Math.max(saved.height - CHROME_H, 1);
  const viewWidth = Math.max(Math.round((viewHeight * width) / height), MIN_VIEW_WIDTH);
  return new LogicalSize(viewWidth + CHROME_W, saved.height);
}

async function showMainWindow() {
  const main = await Window.getByLabel(MAIN_LABEL);
  if (!main) return;
  await main.unminimize().catch(() => { });
  await main.show().catch(() => { });
  await main.setFocus().catch(() => { });
}

/** One phone's window: it owns the stream, its controls and its recordings. */
export default function MirrorApp({ identity }: { identity: MirrorIdentity }) {
  const { serial } = identity;
  const label = mirrorLabel(serial);
  const device: Device = useMemo(() => ({ serial, model: identity.model, state: "device" }), [serial, identity.model]);
  const [settings, setSettings] = useState<Settings>(() => readStoredJson("stream_settings", PRESETS.balanced));
  const [devSettings, setDevSettings] = useState<DevSettings>(() => readStoredJson("dev_settings", DEFAULT_DEV_SETTINGS));
  const [pins, setPins] = useState<QuickActionId[]>(readPins);
  const [stayAwake, setStayAwake] = useState(() => localStorage.getItem("stay_awake") === "true");
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [showCommandBar, setShowCommandBar] = useState(false);
  const [focused, setFocused] = useState(true);

  useWindowDrag();
  const { setThemePref, cycleTheme } = useTheme();
  useGlass();
  const { toasts, showToast, dismissToast } = useToasts();
  const macro = useMacro({ showToast });

  const closeWindow = useCallback(() => { getCurrentWindow().close().catch(() => { }); }, []);

  const openSettings = useCallback(() => {
    emitTo(MAIN_LABEL, OPEN_SETTINGS_EVENT).catch(() => { });
    showMainWindow();
  }, []);

  const toggleAlwaysOnTop = useCallback(async () => {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    await getCurrentWindow().setAlwaysOnTop(next);
  }, [alwaysOnTop]);

  const takeScreenshot = useCallback(async () => {
    try {
      const base64 = await invoke<string>("take_screenshot");
      const dir = localStorage.getItem("save_path") || (await downloadDir()).replace(/\/$/, "");
      const path = `${dir}/screenshot-${Date.now()}.png`;
      await invoke("save_file", { path, data: base64 });
      const folder = path.split("/").slice(-2, -1)[0];
      showToast(`Screenshot saved to ${folder}`, "success", { action: { label: "Show", run: () => { revealItemInDir(path).catch(() => { }); } } });
    } catch (e) {
      showToast("Could not take a screenshot", "error", { detail: `${e}` });
    }
  }, [showToast]);

  const adaptiveRef = useRef<{
    frameReceived: () => void;
    packetReceived: (ptsUs: number) => void;
    nativeSample: (fps: number, lagMinMs: number) => void;
    disableAdaptive: () => void;
  }>({ frameReceived: () => { }, packetReceived: () => { }, nativeSample: () => { }, disableAdaptive: () => { } });

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const devSettingsRef = useRef(devSettings);
  devSettingsRef.current = devSettings;
  const scheduleReconnectRef = useRef<((s: Settings) => void) | null>(null);
  const connectedRef = useRef(false);

  const connection = useConnection({
    settings,
    showToast,
    takeScreenshot,
    setShowSettings: () => openSettings(),
    setThemePref: (fn) => setThemePref(fn),
    onToggleAlwaysOnTop: toggleAlwaysOnTop,
    onFrameReceived: () => adaptiveRef.current.frameReceived(),
    onPacketReceived: (ptsUs) => adaptiveRef.current.packetReceived(ptsUs),
    onNativeStats: (fps, lagMinMs) => adaptiveRef.current.nativeSample(fps, lagMinMs),
    onCodecFallback: (codec) => {
      const next = { ...settingsRef.current, video_codec: codec };
      setSettings(next);
      scheduleReconnectRef.current?.(next);
    },
    onRecordEvent: macro.recordEvent,
    onDropped: (reason) => {
      emitTo(MAIN_LABEL, MIRROR_DROPPED_EVENT, { serial, model: identity.model, reason }).catch(() => { });
      closeWindow();
    },
    onDisconnectRequested: closeWindow,
    initialSize: (width, height) => sizeFromBounds(serial, width, height),
    perfOverlay: devSettings.perfOverlay,
    directAdb: devSettings.directAdb,
    lowLatency: devSettings.lowLatency,
    encoderTuning: devSettings.encoderTuning,
    anotherServer: devSettings.anotherServer,
    nativeVideo: devSettings.nativeVideo,
    networkStream: devSettings.networkStream,
  });
  const { connectedDevice, connectToDevice, scheduleReconnect, pressButton } = connection;
  scheduleReconnectRef.current = scheduleReconnect;
  connectedRef.current = !!connectedDevice;

  const latencyProbe = useLatencyProbe({ canvasRef: connection.canvasRef, frameDrawnRef: connection.frameDrawnRef, native: connection.nativeActive });

  const liveSizeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  /** Sends bitrate, size and fps changes to the running Another server. Returns false when a reconnect is needed. */
  const applyLive = (prev: Settings, next: Settings): boolean => {
    if (!devSettingsRef.current.anotherServer) return false;
    const changed = (Object.keys(next) as (keyof Settings)[]).filter((key) => next[key] !== prev[key]);
    if (changed.some((key) => !LIVE_KEYS.includes(key) && key !== "adaptive" && key !== "adaptive_network")) return false;
    const fallback = () => scheduleReconnectRef.current?.(next);
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

  const onNetwork = isNetworkSerial(serial);
  const adaptiveEnabled = settings.adaptive || (onNetwork && settings.adaptive_network !== false);

  const adaptive = useAdaptiveBitrate({
    enabled: adaptiveEnabled,
    native: connection.nativeActive,
    decoder: connection.decoderRef,
    currentSettings: settings,
    onTierChange: (newSettings) => {
      setSettings(newSettings);
      if (connectedRef.current && !applyLive(settings, newSettings)) scheduleReconnect(newSettings);
    },
  });
  adaptiveRef.current = adaptive;

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    getCurrentWindow().setMinSize(MIRROR_MIN).catch(() => { });
    connectToDevice(device, settingsRef.current, false, devSettingsRef.current);
  }, []);

  useEffect(() => onStored("stream_settings", () => {
    const prev = settingsRef.current;
    const next = readStoredJson("stream_settings", PRESETS.balanced);
    setSettings(next);
    if (!next.adaptive) adaptiveRef.current.disableAdaptive();
    if (!connectedRef.current) return;
    const changed = (Object.keys(next) as (keyof Settings)[]).some((key) => next[key] !== prev[key]);
    if (changed && !applyLiveRef.current(prev, next)) scheduleReconnectRef.current?.(next);
  }), []);

  useEffect(() => onStored("dev_settings", () => {
    const prev = devSettingsRef.current;
    const next = readStoredJson("dev_settings", DEFAULT_DEV_SETTINGS);
    setDevSettings(next);
    if (connectedRef.current && RECONNECT_DEV_KEYS.some((key) => next[key] !== prev[key])) {
      scheduleReconnectRef.current?.(settingsRef.current);
    }
  }), []);

  useEffect(() => onStored("toolbar_pins", () => setPins(readPins())), []);

  const stayOnPrevious = useRef<string | null>(null);
  const restoreStayOn = useCallback(async () => {
    const previous = stayOnPrevious.current;
    stayOnPrevious.current = null;
    if (previous !== null) await invoke("set_stay_on", { serial, value: previous }).catch(() => { });
  }, [serial]);

  useEffect(() => onStored("stay_awake", (value) => {
    const on = value === "true";
    setStayAwake(on);
    if (!on) restoreStayOn();
  }), [restoreStayOn]);

  useEffect(() => {
    if (!connection.streamReady || !stayAwake || stayOnPrevious.current !== null) return;
    invoke<string>("set_stay_on", { serial, value: STAY_ON_ALL_SOURCES })
      .then((value) => { stayOnPrevious.current = value === "null" ? "0" : value; })
      .catch(() => { });
  }, [connection.streamReady, stayAwake, serial]);

  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested(() => restoreStayOn());
    return () => { unlisten.then((fn) => fn()); };
  }, [restoreStayOn]);

  useEffect(() => {
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const scale = await win.scaleFactor();
          const position = (await win.outerPosition()).toLogical(scale);
          const size = (await win.innerSize()).toLogical(scale);
          saveMirrorBounds(serial, { x: position.x, y: position.y, width: size.width, height: size.height });
        } catch { }
      }, BOUNDS_SAVE_MS);
    };
    const moved = win.onMoved(save);
    const resized = win.onResized(save);
    const focus = win.onFocusChanged(({ payload }) => setFocused(payload));
    return () => {
      clearTimeout(timer);
      moved.then((fn) => fn());
      resized.then((fn) => fn());
      focus.then((fn) => fn());
    };
  }, [serial]);

  const state: MirrorState = {
    serial,
    label,
    connecting: !!connection.connectingSerial,
    streamReady: connection.streamReady,
    nativeActive: connection.nativeActive,
    latencyMs: connection.latencyMs,
    focused,
    probe: { running: latencyProbe.running, result: latencyProbe.result, error: latencyProbe.error },
  };
  const stateRef = useRef(state);
  stateRef.current = state;
  const stateKey = JSON.stringify(state);

  useEffect(() => {
    emitTo(MAIN_LABEL, MIRROR_STATE_EVENT, stateRef.current).catch(() => { });
  }, [stateKey]);

  useEffect(() => {
    const unlisten = listen(MIRROR_STATE_REQUEST, () => { emitTo(MAIN_LABEL, MIRROR_STATE_EVENT, stateRef.current).catch(() => { }); });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const commandHandlerRef = useRef<(command: MirrorCommand) => void>(() => { });
  commandHandlerRef.current = (command) => {
    if (command.action === "measure") latencyProbe.run();
    else if (command.action === "record-macro" && !macro.macroRecording) macro.toggleRecording();
    else if (command.action === "run-macro") macro.playMacro(command.name);
  };

  useEffect(() => {
    const unlisten = getCurrentWebviewWindow().listen<MirrorCommand>(MIRROR_COMMAND_EVENT, (e) => commandHandlerRef.current(e.payload));
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const updateDevSetting = <K extends keyof DevSettings>(key: K, value: DevSettings[K]) => {
    const next = { ...devSettings, [key]: value };
    setDevSettings(next);
    store("dev_settings", JSON.stringify(next));
  };

  const togglePin = (id: QuickActionId) => {
    const next = pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id];
    setPins(next);
    store("toolbar_pins", JSON.stringify(next));
  };

  const toggleRecording = () => {
    const wasRecording = connection.recording;
    connection.toggleRecording();
    if (wasRecording) setTimeout(() => announce("recordings"), RECORDING_SAVED_MS);
  };

  const rotate = () => { invoke("rotate_device").catch((e) => showToast("Could not rotate the screen", "error", { detail: `${e}` })); };
  const toggleStats = () => updateDevSetting("perfOverlay", !devSettings.perfOverlay);
  const retry = () => connectToDevice(device, settingsRef.current, false, devSettingsRef.current);

  const commands: KeyedCommand[] = useMemo(() => [
    { id: "rotate", label: "Rotate the screen", icon: "rotate", keys: [MOD, "R"], key: "r", section: "Phone", action: rotate },
    { id: "home", label: "Home", icon: "home", keys: [MOD, "H"], key: "h", section: "Phone", action: () => pressButton("home") },
    { id: "back", label: "Back", icon: "back", keys: [MOD, "B"], key: "b", section: "Phone", action: () => pressButton("back") },
    { id: "recents", label: "Recent apps", icon: "recents", keys: [], section: "Phone", action: () => pressButton("recents") },
    { id: "power", label: "Power", icon: "power", keys: [MOD, "P"], key: "p", section: "Phone", action: () => pressButton("power") },
    { id: "vol-up", label: "Volume up", icon: "volumeUp", keys: [MOD, "+"], key: "=", section: "Phone", action: () => pressButton("volume_up") },
    { id: "vol-down", label: "Volume down", icon: "volumeDown", keys: [MOD, "-"], key: "-", section: "Phone", action: () => pressButton("volume_down") },
    { id: "mute", label: connection.muted ? "Unmute the phone" : "Mute the phone", icon: "mute", keys: [MOD, "M"], key: "m", section: "Phone", action: () => connection.setMuted(!connection.muted) },
    { id: "screenshot", label: "Take a screenshot", icon: "shot", keys: ["⇧", MOD, "S"], key: "s", shift: true, section: "Phone", action: takeScreenshot },
    { id: "record", label: connection.recording ? "Stop recording" : "Start recording", icon: "record", keys: ["⇧", MOD, "R"], key: "r", shift: true, section: "Phone", action: toggleRecording },
    { id: "stats", label: devSettings.perfOverlay ? "Hide stream stats" : "Show stream stats", icon: "stats", keys: [MOD, "I"], key: "i", section: "Phone", action: toggleStats },
    { id: "measure", label: "Measure touch to screen latency", icon: "timer", keys: [], section: "Phone", hidden: !connection.streamReady, action: latencyProbe.run },
    { id: "disconnect", label: "Disconnect", icon: "unplug", keys: [MOD, "D"], key: "d", section: "Phone", action: closeWindow },
    { id: "cmdbar", label: "Command bar", icon: "search", keys: [MOD, "K"], key: "k", section: "App", action: () => setShowCommandBar((s) => !s) },
    { id: "devices", label: "Show all phones", icon: "apps", keys: [], section: "App", action: showMainWindow },
    { id: "settings", label: "Settings", icon: "settings", keys: [MOD, ","], key: ",", section: "App", action: openSettings },
    { id: "theme", label: "Change the theme", icon: "sun", keys: [MOD, "T"], key: "t", section: "App", action: cycleTheme },
    { id: "always-on-top", label: alwaysOnTop ? "Stop keeping on top" : "Keep on top of other windows", icon: "pin", keys: ["⇧", MOD, "T"], key: "t", shift: true, section: "App", action: toggleAlwaysOnTop },
    { id: "macro-toggle", label: macro.macroRecording ? "Stop recording the macro" : "Record a macro", icon: "wand", keys: ["⇧", MOD, "M"], key: "m", shift: true, section: "Macros", action: macro.toggleRecording },
    ...macro.macros.map((m) => ({ id: `macro:${m.name}`, label: m.name, icon: "wand" as const, keys: [], meta: `${m.event_count} events`, section: "Macros", action: () => macro.playMacro(m.name) })),
  ], [connection.muted, connection.recording, connection.streamReady, devSettings.perfOverlay, alwaysOnTop, macro.macroRecording, macro.macros, takeScreenshot, pressButton, cycleTheme, toggleAlwaysOnTop, openSettings, closeWindow, latencyProbe.run]);

  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      if (showCommandBar && e.key.toLowerCase() !== "k") return;
      const cmd = commandsRef.current.find((c) => c.key && !c.hidden && c.key === e.key.toLowerCase() && !c.shift === !e.shiftKey);
      if (cmd) {
        e.preventDefault();
        cmd.action();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showCommandBar]);

  const inMirror = connection.screen === "another";
  const steps: StartStep[] = [
    { label: devSettings.anotherServer ? "Send the Another server" : "Send the scrcpy server", state: inMirror ? "done" : "active" },
    { label: "Start the encoder", state: !inMirror ? "pending" : connection.streamConfigured ? "done" : "active" },
    { label: "Open the video stream", state: connection.streamReady ? "done" : connection.streamConfigured ? "active" : "pending" },
  ];

  return (
    <>
      {connection.failure ? (
        <div className="app-window flex-col">
          <div className="shrink-0" style={{ height: 36 }} data-tauri-drag-region />
          <main className="card flex-1 min-h-0 flex items-center justify-center p-6">
            <FailedState name={identity.title} brand={identity.brand} reason={cleanError(connection.failure)} onClose={closeWindow} onRetry={retry} />
          </main>
        </div>
      ) : (
        <MirrorScreen
          name={identity.title}
          brand={identity.brand}
          path={identity.path}
          streamReady={connection.streamReady}
          steps={steps}
          deviceSize={connection.deviceSize}
          canvasRef={connection.canvasRef}
          isMouseDownRef={connection.isMouseDownRef}
          nativeVideo={connection.nativeActive}
          latencyMs={connection.latencyMs}
          perfStats={connection.perfStats}
          statsOn={devSettings.perfOverlay}
          recording={connection.recording}
          muted={connection.muted}
          macroRecording={macro.macroRecording}
          pins={pins}
          onTogglePin={togglePin}
          macros={macro.macros.map((m) => m.name)}
          onRunMacro={macro.playMacro}
          adaptive={adaptiveEnabled ? { tier: adaptive.metrics.tierName, fps: adaptive.metrics.fps, lagMs: adaptive.metrics.lagMs } : null}
          alwaysOnTop={alwaysOnTop}
          onToggleAlwaysOnTop={toggleAlwaysOnTop}
          onOpenSettings={openSettings}
          reconnecting={connection.connectingSerial && connection.streamReady ? { message: "Reconnecting" } : null}
          onToggleStats={toggleStats}
          onToggleRecording={toggleRecording}
          onToggleMacroRecording={macro.toggleRecording}
          onToggleMute={() => connection.setMuted(!connection.muted)}
          onScreenshot={takeScreenshot}
          onRotate={rotate}
          onPressButton={pressButton}
          onOpenCommandBar={() => setShowCommandBar(true)}
          onDisconnect={closeWindow}
          onCanvasMouseEvent={connection.handleCanvasMouseEvent}
          onWheel={connection.handleWheel}
          onKeyDown={connection.handleKeyDown}
          onCompositionStart={connection.handleCompositionStart}
          onCompositionEnd={connection.handleCompositionEnd}
        />
      )}
      <CommandBar open={showCommandBar} onOpenChange={setShowCommandBar} commands={commands} />
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
