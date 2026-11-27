import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getVersion } from "@tauri-apps/api/app";
import { downloadDir } from "@tauri-apps/api/path";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Settings, Device, DevSettings, Profile, LinkCommand, RemoteCommand, View, TailnetPeer } from "./types";
import { PRESETS, bestSettings, DEFAULT_DEV_SETTINGS, setDeviceNickname } from "./types";
import { isNetworkSerial } from "@/lib/utils";
import { describeFacts, deviceKind, deviceMaker, deviceName, getDeviceInfo, hasDeviceInfo, peerMaker, prettyModel, resolutionLabel, setDeviceInfo, KIND_ICON, KIND_PATH, type DeviceInfo } from "@/lib/devices";
import { useTheme } from "./hooks/useTheme";
import { useToasts } from "./hooks/useToasts";
import { useDevices } from "./hooks/useDevices";
import { useTailnet } from "./hooks/useTailnet";
import { usePreviews } from "./hooks/usePreviews";
import { useNotifications } from "./hooks/useNotifications";
import { useMacro } from "./hooks/useMacro";
import { useDeviceFacts } from "./hooks/useDeviceFacts";
import { useGlass } from "./hooks/useGlass";
import { useProfiles, sanitizeProfile, describeProfile } from "./hooks/useProfiles";
import { useUpdater } from "./hooks/useUpdater";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { Sidebar, type DeviceActions } from "./components/Sidebar";
import { DeviceView } from "./components/DeviceView";
import { EmptyState, TrustState, DisconnectedState } from "./components/StateViews";
import { MacrosView } from "./components/MacrosView";
import { RecordingsView, type RecordingFile } from "./components/RecordingsView";
import { AgentsView } from "./components/AgentsView";
import { NotificationsView } from "./components/NotificationsView";
import { SettingsDialog, type SettingsPane, type NetworkPrefs } from "./components/SettingsDialog";
import { ConnectDialog, rememberAddress } from "./components/ConnectDialog";
import { CommandBar, type CommandDef } from "./components/CommandBar";
import { ToastContainer } from "./components/ToastContainer";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { WhatsNew } from "./components/WhatsNew";
import { LATEST_NEWS, dismissNews, isNewsDismissed, type News } from "@/lib/news";
import { onAnnounced, onStored, parseJson, store } from "@/lib/sync";
import {
  mirrorLabel,
  openMirror,
  MIRROR_CLOSED_EVENT,
  MIRROR_COMMAND_EVENT,
  MIRROR_DROPPED_EVENT,
  MIRROR_STATE_EVENT,
  MIRROR_STATE_REQUEST,
  OPEN_SETTINGS_EVENT,
  type MirrorCommand,
  type MirrorState,
} from "@/lib/mirror";

const isMac = navigator.userAgent.includes("Mac");
const MOD = isMac ? "⌘" : "Ctrl";

interface KeyedCommand extends CommandDef {
  key?: string;
  shift?: boolean;
}

const PRESET_LABELS: Record<string, string> = { best: "Best for this phone", performance: "Performance", balanced: "Balanced", quality: "Quality" };

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
  const [activePreset, setActivePreset] = useState(() => localStorage.getItem("active_preset") ?? "best");
  const [devSettings, setDevSettings] = useState<DevSettings>(() => readJson("dev_settings", DEFAULT_DEV_SETTINGS));
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
  const [mirrors, setMirrors] = useState<Record<string, MirrorState>>({});
  const [activeSerial, setActiveSerial] = useState<string | null>(null);
  const [dropped, setDropped] = useState<{ device: Device; reason: string } | null>(null);

  useWindowDrag();
  const { themePref, setThemePref, cycleTheme } = useTheme();
  const { toasts, showToast, dismissToast } = useToasts();
  const { devices, loaded: devicesLoaded, refreshDevices } = useDevices(showToast);
  const tailnet = useTailnet();
  const previews = usePreviews();
  const macro = useMacro({ showToast });
  const updater = useUpdater(showToast);
  const { glass, setGlass } = useGlass();

  useEffect(() => {
    getVersion().then(setVersion).catch(() => { });
  }, []);

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

  const refreshRecordingsRef = useRef(refreshRecordings);
  refreshRecordingsRef.current = refreshRecordings;
  useEffect(() => onAnnounced("recordings", () => refreshRecordingsRef.current()), []);
  useEffect(() => onStored("dev_settings", (value) => setDevSettings(parseJson(value, DEFAULT_DEV_SETTINGS))), []);

  const toggleAlwaysOnTop = useCallback(async () => {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    await getCurrentWindow().setAlwaysOnTop(next);
  }, [alwaysOnTop]);

  const activeMirror = activeSerial ? mirrors[activeSerial] ?? null : null;

  const sendToMirror = useCallback((serial: string, command: MirrorCommand) => {
    const label = mirrorLabel(serial);
    emitTo(label, MIRROR_COMMAND_EVENT, command).catch(() => { });
    Window.getByLabel(label).then((win) => win?.setFocus()).catch(() => { });
  }, []);

  useEffect(() => {
    const window = getCurrentWebviewWindow();
    const subscriptions = [
      window.listen<MirrorState>(MIRROR_STATE_EVENT, ({ payload }) => {
        setMirrors((prev) => ({ ...prev, [payload.serial]: payload }));
        setActiveSerial((current) => (payload.focused || !current ? payload.serial : current));
        if (payload.latencyMs !== null) {
          const value = Math.round(payload.latencyMs);
          setLatencies((prev) => {
            if (prev[payload.serial] === value) return prev;
            const next = { ...prev, [payload.serial]: value };
            localStorage.setItem("latencies", JSON.stringify(Object.entries(next)));
            return next;
          });
        }
      }),
      window.listen<{ serial: string; model: string; reason: string }>(MIRROR_DROPPED_EVENT, ({ payload }) => {
        setDropped({ device: { serial: payload.serial, model: payload.model, state: "device" }, reason: payload.reason });
        setView({ kind: "device", serial: payload.serial });
      }),
      window.listen(OPEN_SETTINGS_EVENT, () => setShowSettings(true)),
      listen<string>(MIRROR_CLOSED_EVENT, ({ payload: label }) => {
        setMirrors((prev) => Object.fromEntries(Object.entries(prev).filter(([, m]) => m.label !== label)));
        setActiveSerial((current) => (current && mirrorLabel(current) === label ? null : current));
      }),
    ];
    Promise.all(subscriptions).then(() => emit(MIRROR_STATE_REQUEST)).catch(() => { });
    return () => { subscriptions.forEach((s) => s.then((fn) => fn())); };
  }, []);

  useEffect(() => {
    if (activeSerial && mirrors[activeSerial]) return;
    const next = Object.keys(mirrors)[0] ?? null;
    if (next !== activeSerial) setActiveSerial(next);
  }, [mirrors, activeSerial]);

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const next = { ...settings, [key]: value };
    if (key !== "audio" && key !== "adaptive" && key !== "adaptive_network") {
      next.adaptive = false;
      setActivePreset("");
      store("active_preset", "");
    }
    setSettings(next);
    store("stream_settings", JSON.stringify(next));
  };

  const updateDevSetting = <K extends keyof DevSettings>(key: K, value: DevSettings[K]) => {
    const next = { ...devSettings, [key]: value };
    setDevSettings(next);
    store("dev_settings", JSON.stringify(next));
  };

  const devSettingsRef = useRef(devSettings);
  devSettingsRef.current = devSettings;
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /** Saves the profile; open mirror windows see the change and apply it live or reconnect. */
  const applyProfile = useCallback((profile: Profile): { settings: Settings; dev: DevSettings } => {
    const clean = sanitizeProfile(profile);
    const nextSettings = { ...settingsRef.current, ...clean.stream };
    const nextDev = { ...devSettingsRef.current, ...clean.dev };
    setSettings(nextSettings);
    setDevSettings(nextDev);
    setActivePreset("");
    store("active_preset", "");
    store("stream_settings", JSON.stringify(nextSettings));
    store("dev_settings", JSON.stringify(nextDev));
    return { settings: nextSettings, dev: nextDev };
  }, []);

  const profiles = useProfiles({ settings, devSettings, onApply: applyProfile, showToast });

  const presetSettings = (name: string, serial?: string) => {
    const base = name === "best" ? bestSettings(!!serial && isNetworkSerial(serial)) : PRESETS[name];
    return { ...base, audio: settings.audio, adaptive_network: settings.adaptive_network };
  };

  const applyPreset = (name: string) => {
    const next = presetSettings(name, activeSerial ?? undefined);
    setSettings(next);
    setActivePreset(name);
    store("active_preset", name);
    store("stream_settings", JSON.stringify(next));
  };

  const openMirrorFor = useCallback((device: Device) => {
    openMirror({ serial: device.serial, title: deviceName(device), model: device.model, brand: deviceMaker(device), path: pathLabelRef.current(device) })
      .catch((e) => showToast(`Could not open ${deviceName(device)}`, "error", { detail: `${e}` }));
  }, [showToast]);

  const connectBySerial = (serial: string) => {
    const device = devicesRef.current.find((d) => d.serial === serial) ?? { serial, model: serial, state: "device" };
    openMirrorFor(device);
  };

  const [linkQueue, setLinkQueue] = useState<LinkCommand[]>([]);
  const linkCommand = linkQueue[0] ?? null;

  const describeLink = (command: LinkCommand): string => {
    const serial = command.action === "connect" ? command.serial : command.connect;
    const device = devicesRef.current.find((d) => d.serial === serial);
    const changes = command.action === "apply" ? describeProfile(command.profile) : [];
    const steps = [
      ...(changes.length ? [`change ${changes.join(", ")}`] : []),
      ...(serial ? [`connect to ${device ? `${deviceName(device)} (${serial})` : serial}`] : []),
    ];
    return `A link wants to ${steps.join(" and ")}. Only allow links you trust.`;
  };

  const remoteHandlerRef = useRef<(command: RemoteCommand) => void>(() => { });
  remoteHandlerRef.current = (command) => {
    if (command.action === "link") {
      setLinkQueue((queue) => [...queue, command.command]);
    } else if (command.action === "apply") {
      applyProfile(command.profile);
      if (command.connect) connectBySerial(command.connect);
    } else if (command.action === "connect") {
      connectBySerial(command.serial);
    } else if (command.action === "disconnect") {
      const serials = command.serial ? [command.serial] : Object.keys(mirrors);
      serials.forEach((serial) => invoke("close_mirror", { serial }).catch(() => { }));
    } else if (command.action === "measure") {
      if (activeSerial) sendToMirror(activeSerial, { action: "measure" });
    }
  };

  const menuHandlerRef = useRef<(id: string) => void>(() => { });
  menuHandlerRef.current = (id) => {
    if (id === "toggle_theme") setThemePref((p) => (p === "dark" ? "light" : p === "light" ? "dark" : "light"));
    else if (id === "settings") setShowSettings((open) => !open);
    else if (id === "always_on_top") toggleAlwaysOnTop();
  };

  useEffect(() => {
    const unlisten = getCurrentWebviewWindow().listen<string>("menu-event", (e) => menuHandlerRef.current(e.payload));
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const [remoteReady, setRemoteReady] = useState(false);
  useEffect(() => {
    const unlisten = listen<RemoteCommand>("remote-command", (e) => remoteHandlerRef.current(e.payload));
    unlisten.then(() => setRemoteReady(true));
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    if (!remoteReady) return;
    const modelOf = (serial: string) => devices.find((d) => d.serial === serial)?.model ?? null;
    invoke("report_ui_state", {
      state: {
        connected: activeMirror?.serial ?? null,
        model: activeMirror ? modelOf(activeMirror.serial) : null,
        streamReady: activeMirror?.streamReady ?? false,
        nativeActive: activeMirror?.nativeActive ?? false,
        sessions: Object.values(mirrors).map((m) => ({ serial: m.serial, model: modelOf(m.serial), streamReady: m.streamReady, nativeActive: m.nativeActive, active: m.serial === activeSerial })),
        profile: profiles.currentProfile(),
        devices: devices.map((d) => ({ serial: d.serial, model: d.model, state: d.state })),
      },
    }).catch(() => { });
  }, [remoteReady, mirrors, activeMirror, activeSerial, devices, profiles]);

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

  const setStayAwake = (on: boolean) => {
    setStayAwakeState(on);
    store("stay_awake", String(on));
  };

  useEffect(() => {
    if (!dropped || !networkPrefs.autoReconnect || mirrors[dropped.device.serial]) return;
    const back = devices.find((d) => d.serial === dropped.device.serial && d.state === "device");
    if (!back) return;
    setDropped(null);
    openMirrorFor(back);
  }, [dropped, devices, networkPrefs.autoReconnect, mirrors, openMirrorFor]);

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

  const selectedMirroring = !!selectedDevice && !!mirrors[selectedDevice.serial];
  useEffect(() => {
    if (!selectedDevice || selectedDevice.state !== "device" || selectedMirroring) return;
    const serial = selectedDevice.serial;
    if (!previews.preview(serial)) previews.capture(serial);
  }, [selectedDevice?.serial, selectedDevice?.state, selectedMirroring]);

  const activeDevice = activeSerial ? devices.find((d) => d.serial === activeSerial) ?? null : null;
  const onlineDevice = activeDevice ?? (selectedDevice?.state === "device" ? selectedDevice : devices.find((d) => d.state === "device") ?? null);
  const notifications = useNotifications({ serial: onlineDevice?.serial ?? null, deviceName: onlineDevice ? deviceName(onlineDevice) : "", mirroring: !!onlineDevice && !!mirrors[onlineDevice.serial] });

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    showToast("Code copied", "success");
  };

  const mirror = useCallback((device: Device) => {
    if (device.state !== "device") return;
    setDropped((current) => (current?.device.serial === device.serial ? null : current));
    setView({ kind: "device", serial: device.serial });
    openMirrorFor(device);
  }, [openMirrorFor]);

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
    if (!peer.online) return;
    setBusySerial(peer.address);
    try {
      await invoke("wifi_connect", { address: peer.address });
      await refreshDevices();
      mirror({ serial: peer.address, model: peer.name, state: "device" });
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

  const toggleStats = () => updateDevSetting("perfOverlay", !devSettings.perfOverlay);
  const runMacro = (name: string) => {
    if (activeSerial) sendToMirror(activeSerial, { action: "run-macro", name });
  };
  const recordMacro = () => {
    if (activeSerial) sendToMirror(activeSerial, { action: "record-macro" });
    else showToast("Mirror a phone to record a macro", "info");
  };

  const commands: KeyedCommand[] = useMemo(() => [
    { id: "mirror", label: selectedMirroring ? "Show the mirror window" : "Mirror the selected phone", icon: "play", keys: [MOD, "↩"], key: "enter", section: "Phone", hidden: !selectedDevice, action: () => { if (selectedDevice) mirror(selectedDevice); } },
    { id: "stats", label: devSettings.perfOverlay ? "Hide stream stats" : "Show stream stats", icon: "stats", keys: [MOD, "I"], key: "i", section: "Phone", action: toggleStats },
    { id: "cmdbar", label: "Command bar", icon: "search", keys: [MOD, "K"], key: "k", section: "App", action: () => setShowCommandBar((s) => !s) },
    { id: "settings", label: "Settings", icon: "settings", keys: [MOD, ","], key: ",", section: "App", action: () => openSettings() },
    { id: "connect", label: "Connect a phone", icon: "qr", keywords: "qr code pair wifi address", keys: [], section: "App", action: () => setShowConnect(true) },
    { id: "whats-new", label: "What's new", icon: "sparkle", keys: [], section: "App", action: () => setShowNews(true) },
    { id: "refresh", label: "Refresh devices", icon: "refresh", keys: [], section: "App", action: () => { refreshDevices(); tailnet.refresh(); } },
    { id: "theme", label: "Change the theme", icon: "sun", keys: [MOD, "T"], key: "t", section: "App", action: cycleTheme },
    { id: "always-on-top", label: alwaysOnTop ? "Stop keeping on top" : "Keep on top of other windows", icon: "pin", keys: ["⇧", MOD, "T"], key: "t", shift: true, section: "App", action: toggleAlwaysOnTop },
    { id: "updates", label: "Check for updates", icon: "refresh", keys: ["⇧", MOD, "U"], key: "u", shift: true, section: "App", action: () => updater.checkForUpdates() },
    { id: "agents", label: "AI and CLI", icon: "sparkle", keys: [], section: "App", action: () => setView({ kind: "agents" }) },
    { id: "macro-toggle", label: "Record a macro", icon: "wand", keys: ["⇧", MOD, "M"], key: "m", shift: true, section: "Macros", hidden: !activeSerial, action: recordMacro },
    { id: "macro-manage", label: "Open macros", icon: "wand", keys: ["⇧", MOD, "L"], key: "l", shift: true, section: "Macros", action: () => setView({ kind: "macros" }) },
    { id: "macro-import", label: "Import macros", icon: "folder", keys: ["⇧", MOD, "I"], key: "i", shift: true, section: "Macros", action: macro.importMacros },
    { id: "macro-export", label: "Export all macros", icon: "copy", keys: ["⇧", MOD, "E"], key: "e", shift: true, section: "Macros", action: macro.exportAllMacros },
    ...macro.macros.map((m) => ({ id: `macro:${m.name}`, label: m.name, icon: "wand" as const, keys: [], meta: `${m.event_count} events`, section: "Macros", hidden: !activeSerial, action: () => runMacro(m.name) })),
  ], [selectedDevice, selectedMirroring, activeSerial, mirror, devSettings.perfOverlay, alwaysOnTop, macro.macros, cycleTheme, toggleAlwaysOnTop]);

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

  const pathLabel = (device: Device) => {
    const kind = deviceKind(device);
    if (kind === "wifi") return devSettings.anotherServer && devSettings.networkStream ? "Wi-Fi, direct stream" : "Wi-Fi";
    return KIND_PATH[kind];
  };
  const pathLabelRef = useRef(pathLabel);
  pathLabelRef.current = pathLabel;

  const streamSummary = (network: boolean, refreshHz?: number | null) => {
    const shown = activePreset === "best" ? bestSettings(network) : settings;
    const fps = activePreset === "best" ? (refreshHz ? `${refreshHz} fps` : "Full frame rate") : `${shown.max_fps} fps`;
    return [resolutionLabel(shown.max_size), fps, shown.adaptive || (network && settings.adaptive_network !== false) ? "Adaptive" : null].filter(Boolean).join(" · ");
  };

  const profileOptions = [
    ...(activePreset ? [] : [{ value: "custom", label: "Your settings" }]),
    ...Object.keys(PRESETS).map((p) => ({ value: p, label: PRESET_LABELS[p] ?? p })),
  ];
  const profileControl = { value: activePreset || "custom", options: profileOptions, onChange: (v: string) => { if (v !== "custom") applyPreset(v); } };

  const mainContent = () => {
    if (view?.kind === "macros") {
      return (
        <MacrosView
          macros={macro.macros}
          macrosDir={macro.macrosDir}
          playingMacro={macro.playingMacro}
          canRun={!!activeSerial}
          onRecord={recordMacro}
          onRun={runMacro}
          onRename={macro.renameMacro}
          onDelete={macro.deleteMacro}
          onExport={macro.exportMacro}
          onImport={macro.importMacros}
        />
      );
    }
    if (view?.kind === "recordings") {
      return <RecordingsView files={recordings} folder={savePath} canRecord={!!activeSerial} onOpen={openRecording} onReveal={revealPath} onDelete={deleteRecording} />;
    }
    if (view?.kind === "agents") return <AgentsView showToast={showToast} />;
    if (view?.kind === "notifications" && onlineDevice) {
      return (
        <NotificationsView
          deviceName={deviceName(onlineDevice)}
          items={notifications.items}
          icons={notifications.icons}
          systemCenter={notifications.systemCenter}
          onSystemCenter={notifications.setSystemCenter}
          offerCodes={notifications.offerCodes}
          onOfferCodes={notifications.setOfferCodes}
          onCopyCode={copyCode}
        />
      );
    }
    if (dropped && (!view || (view.kind === "device" && view.serial === dropped.device.serial))) {
      const back = devices.find((d) => d.serial === dropped.device.serial && d.state === "device");
      return (
        <Centered>
          <DisconnectedState
            name={deviceName(dropped.device)}
            brand={deviceMaker(dropped.device)}
            reason={networkPrefs.autoReconnect ? `${dropReason(dropped.device)}. Reconnecting when it comes back` : dropReason(dropped.device)}
            onBack={() => { setDropped(null); setView(devices[0] ? { kind: "device", serial: devices[0].serial } : null); }}
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
      const mirrorState = mirrors[selectedDevice.serial];
      return (
        <DeviceView
          title={name}
          brand={brand}
          online
          status={mirrorState ? (mirrorState.streamReady ? "Mirroring" : "Starting") : "Ready"}
          detail={`${version ? `Android ${version}` : prettyModel(selectedDevice.model)} · ${selectedDevice.serial}`}
          preview={previews.preview(selectedDevice.serial)}
          facts={deviceFacts ? describeFacts(deviceFacts) : undefined}
          connection={{ icon: KIND_ICON[kind], value: pathLabel(selectedDevice), healthy: true }}
          latency={latency ? `${latency} ms` : "Not measured"}
          stream={streamSummary(kind === "wifi", deviceFacts?.refresh_hz)}
          profile={profileControl}
          audio={{ checked: settings.audio, onChange: (on) => updateSetting("audio", on) }}
          awake={{ checked: stayAwake, onChange: setStayAwake }}
          secondary={secondary}
          onMirror={() => mirror(selectedDevice)}
          mirrorLabel={mirrorState ? "Show window" : undefined}
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
          mirrorBusy={busySerial === selectedPeer.address}
        />
      );
    }
    if (!devicesLoaded) return null;
    return <Centered><EmptyState onConnectByAddress={() => setShowConnect(true)} /></Centered>;
  };

  return (
    <>
        <div className="app-window relative">
          <Sidebar
            devices={devices}
            tailnetPeers={sidebarPeers}
            view={view}
            onSelect={(next) => { setDropped(null); setView(next); }}
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
        latencyProbe={activeMirror ? { ...activeMirror.probe, run: () => sendToMirror(activeMirror.serial, { action: "measure" }) } : null}
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
      <ConfirmDialog
        open={!!linkCommand}
        title="Allow this link?"
        detail={linkCommand ? describeLink(linkCommand) : ""}
        action="Allow"
        danger={false}
        onCancel={() => setLinkQueue((queue) => queue.slice(1))}
        onConfirm={() => { if (linkCommand) remoteHandlerRef.current(linkCommand); setLinkQueue((queue) => queue.slice(1)); }}
      />
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="min-h-full flex items-center justify-center">{children}</div>;
}

export default App;
