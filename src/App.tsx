import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { downloadDir } from "@tauri-apps/api/path";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Settings, Device, QuickActionId, DevSettings, Profile, RemoteCommand, View, TailnetPeer } from "./types";
import { PRESETS, DEFAULT_PINNED_ACTIONS, DEFAULT_DEV_SETTINGS, QUICK_ACTION_ORDER, setDeviceNickname } from "./types";
import { isNetworkSerial } from "@/lib/utils";
import { describeFacts, deviceKind, deviceMaker, deviceName, getDeviceInfo, hasDeviceInfo, peerMaker, prettyModel, resolutionLabel, setDeviceInfo, KIND_ICON, KIND_PATH, type DeviceInfo } from "@/lib/devices";
import { useTheme } from "./hooks/useTheme";
import { useToasts } from "./hooks/useToasts";
import { useDevices } from "./hooks/useDevices";
import { useTailnet } from "./hooks/useTailnet";
import { usePreviews } from "./hooks/usePreviews";
import { useNotifications } from "./hooks/useNotifications";
import { useConnection } from "./hooks/useConnection";
import { useAdaptiveBitrate } from "./hooks/useAdaptiveBitrate";
import { useMacro } from "./hooks/useMacro";
import { useLatencyProbe } from "./hooks/useLatencyProbe";
import { useDeviceFacts } from "./hooks/useDeviceFacts";
import { useProfiles, sanitizeProfile } from "./hooks/useProfiles";
import { useUpdater } from "./hooks/useUpdater";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { Sidebar, type DeviceActions } from "./components/Sidebar";
import { DeviceView } from "./components/DeviceView";
import { EmptyState, TrustState, StartingState, DisconnectedState, type StartStep } from "./components/StateViews";
import { MacrosView } from "./components/MacrosView";
import { RecordingsView, type RecordingFile } from "./components/RecordingsView";
import { AgentsView } from "./components/AgentsView";
import { NotificationsView, NotificationBanners } from "./components/NotificationsView";
import { MirrorScreen } from "./components/MirrorScreen";
import { SettingsDialog, type SettingsPane, type NetworkPrefs } from "./components/SettingsDialog";
import { ConnectDialog, rememberAddress } from "./components/ConnectDialog";
import { CommandBar, type CommandDef } from "./components/CommandBar";
import { ToastContainer } from "./components/ToastContainer";
import { WhatsNew } from "./components/WhatsNew";
import { LATEST_NEWS, dismissNews, isNewsDismissed, type News } from "@/lib/news";

const isMac = navigator.userAgent.includes("Mac");
const MOD = isMac ? "⌘" : "Ctrl";

interface KeyedCommand extends CommandDef {
  key?: string;
  shift?: boolean;
}

const LIVE_KEYS: (keyof Settings)[] = ["video_bit_rate", "max_size", "max_fps"];
const LIVE_SIZE_DEBOUNCE_MS = 300;
const RECONNECT_DEV_KEYS: (keyof DevSettings)[] = ["directAdb", "lowLatency", "encoderTuning", "anotherServer", "nativeVideo", "networkStream"];
const STAY_ON_ALL_SOURCES = "7";
const MAX_GLASS_BLUR_PX = 60;
const PRESET_LABELS: Record<string, string> = { performance: "Performance", balanced: "Balanced", quality: "Quality" };

function readJson<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return stored ? { ...fallback, ...JSON.parse(stored) } : fallback;
  } catch {
    return fallback;
  }
}

function readList<T>(key: string, fallback: T[]): T[] {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  } catch {
    return fallback;
  }
}

function dropReason(device: Device) {
  const kind = deviceKind(device);
  if (kind === "usb") return "The USB cable was unplugged";
  if (kind === "emulator") return "The emulator stopped";
  return "The Wi-Fi connection dropped";
}

function peerPath(peer: TailnetPeer) {
  if (!peer.online) return "Offline";
  if (peer.direct) return "Tailnet, direct";
  return peer.relay ? `Relayed via ${peer.relay}` : "Tailnet, relayed";
}

function App() {
  const [view, setView] = useState<View | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsPane, setSettingsPane] = useState<SettingsPane>("stream");
  const [showCommandBar, setShowCommandBar] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => readJson("stream_settings", PRESETS.balanced));
  const [activePreset, setActivePreset] = useState(() => localStorage.getItem("active_preset") || "balanced");
  const [devSettings, setDevSettings] = useState<DevSettings>(() => readJson("dev_settings", DEFAULT_DEV_SETTINGS));
  const [pins, setPins] = useState<QuickActionId[]>(() => readList<QuickActionId>("toolbar_pins", DEFAULT_PINNED_ACTIONS).filter((id) => QUICK_ACTION_ORDER.includes(id)));
  const [networkPrefs, setNetworkPrefsState] = useState<NetworkPrefs>(() => readJson("network_prefs", { autoReconnect: true, showTailnet: true }));
  const [stayAwake, setStayAwakeState] = useState(() => localStorage.getItem("stay_awake") === "true");
  const [savePath, setSavePathState] = useState(() => localStorage.getItem("save_path") || "");
  const [wifiPort, setWifiPortState] = useState(() => parseInt(localStorage.getItem("wifi_port") || "5555", 10));
  const [hiddenPeers, setHiddenPeers] = useState<string[]>(() => readList<string>("hidden_peers", []));
  const [latencies, setLatencies] = useState<Record<string, number>>(() => readList<[string, number]>("latencies", []).reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {}));
  const [recordings, setRecordings] = useState<RecordingFile[]>([]);
  const [busySerial, setBusySerial] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [, setNamesVersion] = useState(0);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [showNews, setShowNews] = useState(() => !isNewsDismissed(LATEST_NEWS.id));
  const [glass, setGlassState] = useState(() => readJson("window_glass", { opacity: 72, blur: 40 }));

  useWindowDrag();
  const { themePref, setThemePref, cycleTheme } = useTheme();
  const { toasts, showToast, dismissToast } = useToasts();
  const { devices, loaded: devicesLoaded, refreshDevices } = useDevices(showToast);
  const tailnet = useTailnet();
  const previews = usePreviews();
  const macro = useMacro({ showToast, onRecordingStopped: () => setView({ kind: "macros" }) });
  const updater = useUpdater(showToast);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => { });
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--glass-alpha", String(glass.opacity / 100));
    root.style.setProperty("--glass-blur", `${(glass.blur * MAX_GLASS_BLUR_PX) / 100}px`);
  }, [glass]);

  const setGlass = (next: { opacity: number; blur: number }) => {
    setGlassState(next);
    localStorage.setItem("window_glass", JSON.stringify(next));
  };

  useEffect(() => {
    if (savePath) return;
    downloadDir().then((dir) => {
      const path = dir.replace(/\/$/, "");
      setSavePathState(path);
      localStorage.setItem("save_path", path);
    }).catch(() => { });
  }, [savePath]);

  const refreshRecordings = useCallback(() => {
    if (!savePath) return;
    invoke<RecordingFile[]>("list_files", { dir: savePath, prefix: "recording-" }).then(setRecordings).catch(() => setRecordings([]));
  }, [savePath]);

  useEffect(() => { refreshRecordings(); }, [refreshRecordings]);

  const toggleAlwaysOnTop = useCallback(async () => {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    await getCurrentWindow().setAlwaysOnTop(next);
  }, [alwaysOnTop]);

  const saveBase64 = useCallback(async (prefix: string, ext: string, base64: string) => {
    const dir = savePath || (await downloadDir()).replace(/\/$/, "");
    const path = `${dir}/${prefix}-${Date.now()}.${ext}`;
    await invoke("save_file", { path, data: base64 });
    return path;
  }, [savePath]);

  const takeScreenshot = useCallback(async () => {
    try {
      const base64 = await invoke<string>("take_screenshot");
      const path = await saveBase64("screenshot", "png", base64);
      const folder = path.split("/").slice(-2, -1)[0];
      showToast(`Screenshot saved to ${folder}`, "success", { action: { label: "Show", run: () => { revealItemInDir(path).catch(() => { }); } } });
    } catch (e) {
      showToast("Could not take a screenshot", "error", { detail: `${e}` });
    }
  }, [saveBase64, showToast]);

  const adaptiveRef = useRef<{
    frameReceived: () => void;
    packetReceived: (ptsUs: number) => void;
    nativeSample: (fps: number, lagMinMs: number) => void;
    disableAdaptive: () => void;
  }>({ frameReceived: () => { }, packetReceived: () => { }, nativeSample: () => { }, disableAdaptive: () => { } });

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const connectedDeviceRef = useRef<Device | null>(null);
  const scheduleReconnectRef = useRef<((s: Settings) => void) | null>(null);

  const handleCodecFallback = useCallback((codec: string) => {
    const next = { ...settingsRef.current, video_codec: codec };
    setSettings(next);
    if (connectedDeviceRef.current) scheduleReconnectRef.current?.(next);
  }, []);

  const connection = useConnection({
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
  const { screen, connectedDevice, connectingSerial, connectToDevice, disconnect, scheduleReconnect, pressButton, dropped } = connection;

  const latencyProbe = useLatencyProbe({ canvasRef: connection.canvasRef, frameDrawnRef: connection.frameDrawnRef, native: connection.nativeActive });
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
    native: connection.nativeActive,
    decoder: connection.decoderRef,
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
    if (RECONNECT_DEV_KEYS.includes(key) && connectedDevice) scheduleReconnect(settings);
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

  const applyPreset = (name: string) => {
    const next = { ...PRESETS[name], audio: settings.audio };
    setSettings(next);
    setActivePreset(name);
    localStorage.setItem("stream_settings", JSON.stringify(next));
    localStorage.setItem("active_preset", name);
    adaptive.disableAdaptive();
    if (connectedDevice) scheduleReconnect(next);
  };

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
        streamReady: connection.streamReady,
        nativeActive: connection.nativeActive,
        profile: profiles.currentProfile(),
        devices: devices.map((d) => ({ serial: d.serial, model: d.model, state: d.state })),
      },
    }).catch(() => { });
  }, [remoteReady, connectedDevice, connection.streamReady, connection.nativeActive, devices, profiles]);

  useEffect(() => {
    if (!remoteReady) return;
    invoke<RemoteCommand[]>("take_pending_commands")
      .then((pending) => pending.forEach((command) => remoteHandlerRef.current(command)))
      .catch(() => { });
  }, [remoteReady]);

  useEffect(() => {
    const mcpEnabled = localStorage.getItem("mcp_enabled") !== "false";
    if (mcpEnabled) {
      const port = parseInt(localStorage.getItem("mcp_port") || "7070", 10);
      invoke("start_mcp_server", { port }).catch(() => { });
    }
    updater.checkForUpdates(true);
  }, []);

  const stayOnPrevious = useRef<{ serial: string; value: string } | null>(null);

  const restoreStayOn = useCallback(() => {
    const previous = stayOnPrevious.current;
    stayOnPrevious.current = null;
    if (previous) invoke("set_stay_on", { serial: previous.serial, value: previous.value }).catch(() => { });
  }, []);

  useEffect(() => {
    if (screen !== "another" || !connectedDevice || !stayAwake || stayOnPrevious.current) return;
    const serial = connectedDevice.serial;
    invoke<string>("set_stay_on", { serial, value: STAY_ON_ALL_SOURCES })
      .then((value) => { stayOnPrevious.current = { serial, value: value === "null" ? "0" : value }; })
      .catch(() => { });
  }, [screen, connectedDevice, stayAwake]);

  useEffect(() => {
    if (screen === "welcome") restoreStayOn();
  }, [screen, restoreStayOn]);

  const setStayAwake = (on: boolean) => {
    setStayAwakeState(on);
    localStorage.setItem("stay_awake", String(on));
    if (!on) restoreStayOn();
  };

  useEffect(() => {
    if (!connectedDevice || connection.latencyMs === null) return;
    const value = Math.round(connection.latencyMs);
    setLatencies((prev) => {
      if (prev[connectedDevice.serial] === value) return prev;
      const next = { ...prev, [connectedDevice.serial]: value };
      localStorage.setItem("latencies", JSON.stringify(Object.entries(next)));
      return next;
    });
  }, [connectedDevice, connection.latencyMs]);

  useEffect(() => {
    if (connectedDevice) setView({ kind: "device", serial: connectedDevice.serial });
  }, [connectedDevice]);

  useEffect(() => {
    if (!dropped || !networkPrefs.autoReconnect || connectingSerial) return;
    const back = devices.find((d) => d.serial === dropped.device.serial && d.state === "device");
    if (back) connectToDevice(back, settings);
  }, [dropped, devices, networkPrefs.autoReconnect, connectingSerial]);

  const infoRequested = useRef(new Set<string>());
  useEffect(() => {
    devices
      .filter((d) => d.state === "device" && !hasDeviceInfo(d.serial) && !infoRequested.current.has(d.serial))
      .forEach((d) => {
        infoRequested.current.add(d.serial);
        invoke<DeviceInfo>("device_info", { serial: d.serial })
          .then((info) => { setDeviceInfo(d.serial, info); setNamesVersion((n) => n + 1); })
          .catch(() => infoRequested.current.delete(d.serial));
      });
  }, [devices]);

  const peers = useMemo(() => {
    if (!tailnet.status?.running) return [];
    return tailnet.status.peers.filter((p) => !devices.some((d) => d.serial === p.address) && !hiddenPeers.includes(p.address));
  }, [tailnet.status, devices, hiddenPeers]);
  const sidebarPeers = networkPrefs.showTailnet ? peers : [];

  const selectedDevice = view?.kind === "device" ? devices.find((d) => d.serial === view.serial) ?? null : null;
  const selectedPeer = view?.kind === "tailnet" ? peers.find((p) => p.address === view.address) ?? null : null;
  const deviceFacts = useDeviceFacts(selectedDevice?.state === "device" ? selectedDevice.serial : null);

  useEffect(() => {
    if (!devicesLoaded) return;
    if (dropped && view?.kind === "device" && view.serial === dropped.device.serial) return;
    const stillThere = view?.kind === "device" ? !!selectedDevice : view?.kind === "tailnet" ? !!selectedPeer : !!view;
    if (stillThere) return;
    if (devices[0]) setView({ kind: "device", serial: devices[0].serial });
    else if (sidebarPeers[0]) setView({ kind: "tailnet", address: sidebarPeers[0].address });
    else setView(null);
  }, [devicesLoaded, devices, sidebarPeers, view, selectedDevice, selectedPeer, dropped]);

  useEffect(() => {
    if (!selectedDevice || selectedDevice.state !== "device" || screen !== "welcome") return;
    const serial = selectedDevice.serial;
    if (!previews.preview(serial)) previews.capture(serial);
  }, [selectedDevice?.serial, selectedDevice?.state, screen]);

  const onlineDevice = connectedDevice ?? (selectedDevice?.state === "device" ? selectedDevice : devices.find((d) => d.state === "device") ?? null);
  const notifications = useNotifications({ serial: onlineDevice?.serial ?? null, deviceName: onlineDevice ? deviceName(onlineDevice) : "" });

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    showToast("Code copied", "success");
  };

  const openOnPhone = (pkg: string) => {
    if (onlineDevice) invoke("open_phone_app", { serial: onlineDevice.serial, package: pkg }).catch((e) => showToast("Could not open the app", "error", { detail: `${e}` }));
  };

  const mirror = useCallback((device: Device) => {
    if (connectingSerial || device.state !== "device") return;
    connection.clearDropped();
    setView({ kind: "device", serial: device.serial });
    connectToDevice(device, settings);
  }, [connectingSerial, connectToDevice, settings, connection.clearDropped]);

  const toggleWifi = async (device: Device) => {
    setBusySerial(device.serial);
    try {
      if (isNetworkSerial(device.serial)) {
        await invoke("wifi_disconnect", { address: device.serial });
        const usb = devices.find((d) => d.model === device.model && !isNetworkSerial(d.serial));
        if (usb) setView({ kind: "device", serial: usb.serial });
        showToast(`${deviceName(device)} left Wi-Fi debugging`, "info");
      } else {
        const twin = devices.find((d) => d.model === device.model && isNetworkSerial(d.serial));
        if (twin) {
          setView({ kind: "device", serial: twin.serial });
        } else {
          const address = await invoke<string>("wifi_enable", { serial: device.serial, port: wifiPort });
          rememberAddress(deviceName(device), address);
          await refreshDevices();
          setView({ kind: "device", serial: address });
          showToast(`${deviceName(device)} is on Wi-Fi`, "success", { detail: address });
        }
      }
      refreshDevices();
    } catch (e) {
      showToast("Could not change Wi-Fi debugging", "error", { detail: `${e}` });
    } finally {
      setBusySerial(null);
    }
  };

  const actions: DeviceActions = {
    mirror,
    rename: (serial, name) => {
      setDeviceNickname(serial, name);
      setNamesVersion((n) => n + 1);
    },
    copyAddress: (device) => {
      navigator.clipboard.writeText(device.serial);
      showToast(deviceKind(device) === "usb" ? "Serial copied" : "Address copied", "success");
    },
    toggleWifi,
    forget: async (device) => {
      try {
        await invoke("wifi_disconnect", { address: device.serial });
        localStorage.setItem("recent_addresses", JSON.stringify(readList<{ address: string }>("recent_addresses", []).filter((r) => r.address !== device.serial)));
        refreshDevices();
      } catch (e) {
        showToast("Could not forget the phone", "error", { detail: `${e}` });
      }
    },
  };

  const connectPeer = async (peer: TailnetPeer) => {
    if (!peer.online || connectingSerial) return;
    setBusySerial(peer.address);
    try {
      await invoke("wifi_connect", { address: peer.address });
      await refreshDevices();
      connectToDevice({ serial: peer.address, model: peer.name, state: "device" }, settings);
    } catch {
      showToast(`Could not reach ${peer.name} over the tailnet`, "error", { detail: "Connect it by USB once and turn on Wi-Fi debugging" });
    } finally {
      setBusySerial(null);
    }
  };

  const revealPath = (path: string) => {
    revealItemInDir(path).catch((e) => showToast("Could not open Finder", "error", { detail: `${e}` }));
  };

  const openRecording = (file: RecordingFile) => {
    openPath(file.path).catch((e) => showToast("Could not open the recording", "error", { detail: `${e}` }));
  };

  const deleteRecording = async (file: RecordingFile) => {
    try {
      await invoke("delete_file", { path: file.path });
      refreshRecordings();
    } catch (e) {
      showToast("Could not delete the recording", "error", { detail: `${e}` });
    }
  };

  const toggleRecording = () => {
    const wasRecording = connection.recording;
    connection.toggleRecording();
    if (wasRecording) setTimeout(refreshRecordings, 1500);
  };

  const togglePin = (id: QuickActionId) => {
    const next = pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id];
    setPins(next);
    localStorage.setItem("toolbar_pins", JSON.stringify(next));
  };

  const setNetworkPrefs = (prefs: NetworkPrefs) => {
    setNetworkPrefsState(prefs);
    localStorage.setItem("network_prefs", JSON.stringify(prefs));
  };

  const setSavePath = (path: string) => {
    setSavePathState(path);
    localStorage.setItem("save_path", path);
  };

  const openSettings = (pane?: SettingsPane) => {
    if (pane) setSettingsPane(pane);
    setShowSettings(true);
  };

  const closeNews = () => {
    dismissNews(LATEST_NEWS.id);
    setShowNews(false);
  };

  const actOnNews = (item: News) => {
    closeNews();
    if (item.action.kind === "view") setView(item.action.view);
    if (item.action.kind === "settings") openSettings(item.action.pane);
    if (item.action.kind === "connect") setShowConnect(true);
  };

  const rotate = () => { invoke("rotate_device").catch((e) => showToast("Could not rotate the screen", "error", { detail: `${e}` })); };
  const toggleStats = () => updateDevSetting("perfOverlay", !devSettings.perfOverlay);
  const runMacro = (name: string) => {
    setView({ kind: "device", serial: connectedDevice?.serial ?? "" });
    macro.playMacro(name);
  };

  const commands: KeyedCommand[] = useMemo(() => [
    { id: "mirror", label: "Mirror the selected phone", icon: "play", keys: [MOD, "↩"], key: "enter", section: "Phone", hidden: !!connectedDevice || !selectedDevice, action: () => { if (selectedDevice) mirror(selectedDevice); } },
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
    { id: "disconnect", label: "Disconnect", icon: "unplug", keys: [MOD, "D"], key: "d", section: "Phone", hidden: !connectedDevice, action: disconnect },
    { id: "cmdbar", label: "Command bar", icon: "search", keys: [MOD, "K"], key: "k", section: "App", action: () => setShowCommandBar((s) => !s) },
    { id: "settings", label: "Settings", icon: "settings", keys: [MOD, ","], key: ",", section: "App", action: () => openSettings() },
    { id: "connect", label: "Connect a phone", icon: "qr", keywords: "qr code pair wifi address", keys: [], section: "App", action: () => setShowConnect(true) },
    { id: "whats-new", label: "What's new", icon: "sparkle", keys: [], section: "App", action: () => setShowNews(true) },
    { id: "refresh", label: "Refresh devices", icon: "refresh", keys: [], section: "App", action: () => { refreshDevices(); tailnet.refresh(); } },
    { id: "theme", label: "Change the theme", icon: "sun", keys: [MOD, "T"], key: "t", section: "App", action: cycleTheme },
    { id: "always-on-top", label: alwaysOnTop ? "Stop keeping on top" : "Keep on top of other windows", icon: "pin", keys: ["⇧", MOD, "T"], key: "t", shift: true, section: "App", action: toggleAlwaysOnTop },
    { id: "updates", label: "Check for updates", icon: "refresh", keys: ["⇧", MOD, "U"], key: "u", shift: true, section: "App", action: () => updater.checkForUpdates() },
    { id: "agents", label: "AI and CLI", icon: "sparkle", keys: [], section: "App", action: () => setView({ kind: "agents" }) },
    { id: "macro-toggle", label: macro.macroRecording ? "Stop recording the macro" : "Record a macro", icon: "wand", keys: ["⇧", MOD, "M"], key: "m", shift: true, section: "Macros", action: macro.toggleRecording },
    { id: "macro-manage", label: "Open macros", icon: "wand", keys: ["⇧", MOD, "L"], key: "l", shift: true, section: "Macros", action: () => setView({ kind: "macros" }) },
    { id: "macro-import", label: "Import macros", icon: "folder", keys: ["⇧", MOD, "I"], key: "i", shift: true, section: "Macros", action: macro.importMacros },
    { id: "macro-export", label: "Export all macros", icon: "copy", keys: ["⇧", MOD, "E"], key: "e", shift: true, section: "Macros", action: macro.exportAllMacros },
    ...macro.macros.map((m) => ({ id: `macro:${m.name}`, label: m.name, icon: "wand" as const, keys: [], meta: `${m.event_count} events`, section: "Macros", hidden: !connectedDevice, action: () => runMacro(m.name) })),
  ], [connectedDevice, selectedDevice, mirror, connection.muted, connection.recording, devSettings.perfOverlay, alwaysOnTop, macro.macroRecording, macro.macros, takeScreenshot, pressButton, disconnect, cycleTheme, toggleAlwaysOnTop]);

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

  const shortcuts = commands.filter((c) => c.keys.length > 0 && !c.id.startsWith("macro:")).map((c) => ({ name: c.label, keys: c.keys.join("") }));

  const startSteps = (): StartStep[] => {
    const inMirror = screen === "another";
    const serverLabel = devSettings.anotherServer ? "Send the Another server" : "Send the scrcpy server";
    return [
      { label: serverLabel, state: inMirror ? "done" : "active" },
      { label: "Start the encoder", state: !inMirror ? "pending" : connection.streamConfigured ? "done" : "active" },
      { label: "Open the video stream", state: connection.streamReady ? "done" : connection.streamConfigured ? "active" : "pending" },
    ];
  };

  const pathLabel = (device: Device) => {
    const kind = deviceKind(device);
    if (kind === "wifi") return devSettings.anotherServer && devSettings.networkStream ? "Wi-Fi, direct stream" : "Wi-Fi";
    return KIND_PATH[kind];
  };

  const streamSummary = (network: boolean) =>
    [resolutionLabel(settings.max_size), `${settings.max_fps} fps`, settings.adaptive || (network && settings.adaptive_network !== false) ? "Adaptive" : null].filter(Boolean).join(" · ");

  const profileOptions = [
    ...(activePreset ? [] : [{ value: "custom", label: "Your settings" }]),
    ...Object.keys(PRESETS).map((p) => ({ value: p, label: PRESET_LABELS[p] ?? p })),
  ];
  const profileControl = { value: activePreset || "custom", options: profileOptions, onChange: (v: string) => { if (v !== "custom") applyPreset(v); } };

  const connectingDevice = connectingSerial ? devices.find((d) => d.serial === connectingSerial) ?? connectedDevice ?? { serial: connectingSerial, model: connectingSerial, state: "device" } : null;

  const mainContent = () => {
    if (view?.kind === "macros") {
      return (
        <MacrosView
          macros={macro.macros}
          macrosDir={macro.macrosDir}
          playingMacro={macro.playingMacro}
          canRun={!!connectedDevice}
          onRecord={macro.toggleRecording}
          onRun={runMacro}
          onRename={macro.renameMacro}
          onDelete={macro.deleteMacro}
          onExport={macro.exportMacro}
          onImport={macro.importMacros}
        />
      );
    }
    if (view?.kind === "recordings") {
      return <RecordingsView files={recordings} folder={savePath} canRecord={!!connectedDevice} onOpen={openRecording} onReveal={revealPath} onDelete={deleteRecording} />;
    }
    if (view?.kind === "agents") return <AgentsView showToast={showToast} />;
    if (view?.kind === "notifications" && onlineDevice) {
      return (
        <NotificationsView
          deviceName={deviceName(onlineDevice)}
          items={notifications.items}
          systemCenter={notifications.systemCenter}
          onSystemCenter={notifications.setSystemCenter}
          offerCodes={notifications.offerCodes}
          onOfferCodes={notifications.setOfferCodes}
          onCopyCode={copyCode}
        />
      );
    }
    if (connectingDevice && screen === "welcome") {
      return <Centered><StartingState name={deviceName(connectingDevice)} brand={deviceMaker(connectingDevice)} path={pathLabel(connectingDevice)} steps={startSteps()} /></Centered>;
    }
    if (dropped && (!view || (view.kind === "device" && view.serial === dropped.device.serial))) {
      const back = devices.find((d) => d.serial === dropped.device.serial && d.state === "device");
      return (
        <Centered>
          <DisconnectedState
            name={deviceName(dropped.device)}
            brand={deviceMaker(dropped.device)}
            reason={networkPrefs.autoReconnect ? `${dropReason(dropped.device)}. Reconnecting when it comes back` : dropReason(dropped.device)}
            onBack={() => { connection.clearDropped(); setView(devices[0] ? { kind: "device", serial: devices[0].serial } : null); }}
            onReconnect={() => (back ? mirror(back) : showToast(`${deviceName(dropped.device)} is not connected yet`, "error", { detail: "Plug it in or bring it back on Wi-Fi, then try again" }))}
          />
        </Centered>
      );
    }
    if (selectedDevice) {
      const kind = deviceKind(selectedDevice);
      const brand = deviceMaker(selectedDevice);
      const name = deviceName(selectedDevice);
      if (selectedDevice.state === "unauthorized") return <Centered><TrustState name={name} brand={brand} /></Centered>;
      const version = getDeviceInfo(selectedDevice.serial)?.android_version;
      const latency = latencies[selectedDevice.serial];
      const twinWifi = kind === "usb" ? devices.find((d) => d.model === selectedDevice.model && isNetworkSerial(d.serial)) : null;
      const secondary =
        kind === "usb"
          ? { label: twinWifi ? "Use Wi-Fi" : "Switch to Wi-Fi", run: () => toggleWifi(selectedDevice), busy: busySerial === selectedDevice.serial }
          : kind === "wifi"
            ? { label: "Disconnect", run: () => toggleWifi(selectedDevice), busy: busySerial === selectedDevice.serial }
            : null;
      return (
        <DeviceView
          title={name}
          brand={brand}
          online
          status="Ready"
          detail={`${version ? `Android ${version}` : prettyModel(selectedDevice.model)} · ${selectedDevice.serial}`}
          preview={previews.preview(selectedDevice.serial)}
          facts={deviceFacts ? describeFacts(deviceFacts) : undefined}
          connection={{ icon: KIND_ICON[kind], value: pathLabel(selectedDevice), healthy: true }}
          latency={latency ? `${latency} ms` : "Not measured"}
          stream={streamSummary(kind === "wifi")}
          profile={profileControl}
          audio={{ checked: settings.audio, onChange: (on) => updateSetting("audio", on) }}
          awake={{ checked: stayAwake, onChange: setStayAwake }}
          secondary={secondary}
          onMirror={() => mirror(selectedDevice)}
          mirrorBusy={connectingSerial === selectedDevice.serial}
        />
      );
    }
    if (selectedPeer) {
      const latency = latencies[selectedPeer.address];
      return (
        <DeviceView
          title={selectedPeer.name}
          brand={peerMaker(selectedPeer.name)}
          online={selectedPeer.online}
          status={selectedPeer.online ? "Online" : "Offline"}
          detail={`Tailnet · ${selectedPeer.address}`}
          preview={previews.preview(selectedPeer.address)}
          connection={{ icon: KIND_ICON.tailnet, value: peerPath(selectedPeer), healthy: selectedPeer.online && selectedPeer.direct }}
          latency={latency ? `${latency} ms` : "Not measured"}
          stream={streamSummary(true)}
          profile={profileControl}
          audio={{ checked: settings.audio, onChange: (on) => updateSetting("audio", on) }}
          awake={{ checked: stayAwake, onChange: setStayAwake }}
          secondary={
            selectedPeer.online
              ? { label: "Copy address", run: () => { navigator.clipboard.writeText(selectedPeer.address); showToast("Address copied", "success"); } }
              : { label: "Forget", run: () => { const next = [...hiddenPeers, selectedPeer.address]; setHiddenPeers(next); localStorage.setItem("hidden_peers", JSON.stringify(next)); } }
          }
          onMirror={() => connectPeer(selectedPeer)}
          mirrorBusy={busySerial === selectedPeer.address || connectingSerial === selectedPeer.address}
        />
      );
    }
    if (!devicesLoaded) return null;
    return <Centered><EmptyState onConnectByAddress={() => setShowConnect(true)} /></Centered>;
  };

  const mirrorTarget = connectedDevice;
  const usbTwin = mirrorTarget && isNetworkSerial(mirrorTarget.serial) ? devices.find((d) => d.model === mirrorTarget.model && !isNetworkSerial(d.serial)) : null;

  return (
    <>
      {screen === "another" && mirrorTarget ? (
        <MirrorScreen
          name={deviceName(mirrorTarget)}
          brand={deviceMaker(mirrorTarget)}
          path={pathLabel(mirrorTarget)}
          streamReady={connection.streamReady}
          steps={startSteps()}
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
          onRunMacro={runMacro}
          adaptive={adaptiveEnabled ? { tier: adaptive.metrics.tierName, fps: adaptive.metrics.fps, lagMs: adaptive.metrics.lagMs } : null}
          alwaysOnTop={alwaysOnTop}
          onToggleAlwaysOnTop={toggleAlwaysOnTop}
          onOpenSettings={() => openSettings()}
          reconnecting={connectingSerial && connection.streamReady ? { message: "Reconnecting", action: usbTwin ? { label: "Use USB", run: () => connectToDevice(usbTwin, settings) } : undefined } : null}
          onToggleStats={toggleStats}
          onToggleRecording={toggleRecording}
          onToggleMacroRecording={macro.toggleRecording}
          onToggleMute={() => connection.setMuted(!connection.muted)}
          onScreenshot={takeScreenshot}
          onRotate={rotate}
          onPressButton={pressButton}
          onOpenCommandBar={() => setShowCommandBar(true)}
          onDisconnect={disconnect}
          onCanvasMouseEvent={connection.handleCanvasMouseEvent}
          onWheel={connection.handleWheel}
          onKeyDown={connection.handleKeyDown}
          onCompositionStart={connection.handleCompositionStart}
          onCompositionEnd={connection.handleCompositionEnd}
        />
      ) : (
        <div className="app-window relative">
          <Sidebar
            devices={devices}
            tailnetPeers={sidebarPeers}
            view={view}
            onSelect={(next) => { connection.clearDropped(); setView(next); }}
            actions={actions}
            macroCount={macro.macros.length}
            recordingCount={recordings.length}
            notificationCount={notifications.items.length}
            notificationsAvailable={!!onlineDevice}
            onConnectByAddress={() => setShowConnect(true)}
            onOpenSettings={() => openSettings()}
          />
          <main className="card scroll flex-1 min-w-0 p-8">{mainContent()}</main>
          {showNews && <WhatsNew start={LATEST_NEWS} onClose={closeNews} onAction={actOnNews} />}
        </div>
      )}

      <SettingsDialog
        open={showSettings}
        onOpenChange={setShowSettings}
        pane={settingsPane}
        onPaneChange={setSettingsPane}
        settings={settings}
        onUpdateSetting={updateSetting}
        devSettings={devSettings}
        onUpdateDevSetting={updateDevSetting}
        themePref={themePref}
        onThemePref={setThemePref}
        glass={glass}
        onGlass={setGlass}
        savePath={savePath}
        onSavePath={setSavePath}
        macrosDir={macro.macrosDir}
        onMacrosDir={(dir) => { macro.setMacrosDir(dir); showToast("Macros folder changed", "success", { detail: dir }); }}
        networkPrefs={networkPrefs}
        wifiPort={wifiPort}
        onWifiPort={(port) => { setWifiPortState(port); localStorage.setItem("wifi_port", String(port)); }}
        onNetworkPrefs={setNetworkPrefs}
        tailscaleRunning={!!tailnet.status?.running}
        shortcuts={shortcuts}
        profileSummary={streamSummary(false)}
        latencyProbe={connectedDevice ? latencyProbe : null}
        onExportProfile={profiles.exportProfile}
        onImportProfile={profiles.importProfile}
        onCopyProfileLink={profiles.copyProfileLink}
        version={version}
        onCheckForUpdates={() => updater.checkForUpdates()}
        onWhatsNew={() => { setShowSettings(false); setShowNews(true); }}
        onConnectPhone={() => { setShowSettings(false); setShowConnect(true); }}
        onOpenAgents={() => { setShowSettings(false); setView({ kind: "agents" }); }}
      />
      <ConnectDialog
        open={showConnect}
        onOpenChange={setShowConnect}
        peers={tailnet.status?.running ? peers : null}
        wifiPort={wifiPort}
        onConnected={(serial) => { refreshDevices(); setView({ kind: "device", serial }); }}
        showToast={showToast}
      />
      <CommandBar open={showCommandBar} onOpenChange={setShowCommandBar} commands={commands} />
      <NotificationBanners banners={notifications.banners} onDismiss={notifications.dismissBanner} onCopyCode={copyCode} onOpen={openOnPhone} />
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="min-h-full flex items-center justify-center">{children}</div>;
}

export default App;
