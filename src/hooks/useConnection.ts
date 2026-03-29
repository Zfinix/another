import { useState, useRef, useCallback, useEffect } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import type { Device, Settings, FrameEvent, Screen } from "../types";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

interface UseConnectionOptions {
  settings: Settings;
  showToast: (msg: string, type?: "error" | "info") => void;
  takeScreenshot: () => void;
  setShowSettings: (fn: (s: boolean) => boolean) => void;
  setThemePref: (fn: (p: "light" | "dark" | "auto") => "light" | "dark" | "auto") => void;
}

export function useConnection(opts: UseConnectionOptions) {
  const { showToast } = opts;
  const [screen, setScreen] = useState<Screen>("welcome");
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const [connectingSerial, setConnectingSerial] = useState<string | null>(null);
  const [deviceSize, setDeviceSize] = useState({ width: 1080, height: 1920 });
  const [muted, setMutedState] = useState(false);
  const [recording, setRecording] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const decoderRef = useRef<VideoDecoder | null>(null);
  const pendingFrame = useRef<VideoFrame | null>(null);
  const rafId = useRef<number>(0);
  const isMouseDown = useRef(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isReconnecting = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunks = useRef<Blob[]>([]);

  const cleanupDecoder = useCallback(() => {
    if (rafId.current) {
      cancelAnimationFrame(rafId.current);
      rafId.current = 0;
    }
    if (pendingFrame.current) {
      pendingFrame.current.close();
      pendingFrame.current = null;
    }
    if (decoderRef.current && decoderRef.current.state !== "closed") {
      decoderRef.current.close();
      decoderRef.current = null;
    }
    setMutedState(false);
    if (recorderRef.current && recorderRef.current.state === "recording") {
      recorderRef.current.stop();
    }
  }, []);

  const setMuted = useCallback(async (m: boolean) => {
    setMutedState(m);
    try { await invoke("set_muted", { muted: m }); } catch {}
  }, []);

  const connectToDevice = useCallback(async (device: Device, s: Settings, silent = false) => {
    setConnectingSerial(device.serial);
    cleanupDecoder();
    try {
      const channel = new Channel<FrameEvent>();
      channel.onmessage = (msg) => {
        if (msg.event === "config") {
          cleanupDecoder();
          const descBytes = b64ToBytes(msg.data.description);
          const decoder = new VideoDecoder({
            output: (frame: VideoFrame) => {
              if (pendingFrame.current) pendingFrame.current.close();
              pendingFrame.current = frame;
              if (!rafId.current) {
                rafId.current = requestAnimationFrame(() => {
                  rafId.current = 0;
                  const f = pendingFrame.current;
                  if (!f) return;
                  pendingFrame.current = null;
                  const canvas = canvasRef.current;
                  if (!canvas) { f.close(); return; }
                  if (canvas.width !== f.displayWidth || canvas.height !== f.displayHeight) {
                    canvas.width = f.displayWidth;
                    canvas.height = f.displayHeight;
                    setDeviceSize({ width: f.displayWidth, height: f.displayHeight });
                  }
                  const ctx = canvas.getContext("2d");
                  if (ctx) ctx.drawImage(f, 0, 0);
                  f.close();
                });
              }
            },
            error: (e: DOMException) => console.error("Decoder error:", e),
          });
          const config: VideoDecoderConfig = {
            codec: msg.data.codec,
            description: descBytes.buffer,
            hardwareAcceleration: "prefer-hardware",
          };
          decoder.configure(config);
          decoderRef.current = decoder;
        } else if (msg.event === "packet") {
          const decoder = decoderRef.current;
          if (!decoder || decoder.state !== "configured") return;
          const bytes = b64ToBytes(msg.data.data);
          decoder.decode(new EncodedVideoChunk({
            type: msg.data.key ? "key" : "delta",
            timestamp: msg.data.timestamp,
            data: bytes,
          }));
        } else if (msg.event === "disconnected") {
          cleanupDecoder();
          if (!isReconnecting.current) {
            setConnectedDevice(null);
            setScreen("welcome");
            showToast("Device disconnected", "info");
          }
        }
      };

      const [width, height] = await invoke<[number, number]>("connect_device", {
        serial: device.serial,
        onFrame: channel,
        settings: s,
      });
      setDeviceSize({ width, height });
      setConnectedDevice(device);
      setScreen("another");

      const chromeH = 52;
      const maxViewH = 860;
      const aspect = width / height;
      const viewW = Math.round(maxViewH * aspect);
      const totalH = maxViewH + chromeH;
      const win = getCurrentWindow();
      await win.setSize(new LogicalSize(Math.max(viewW, 280), totalH));
    } catch (e) {
      if (!silent) showToast(`Failed to connect: ${e}`);
    } finally {
      setConnectingSerial(null);
      isReconnecting.current = false;
    }
  }, [showToast, cleanupDecoder]);

  const disconnect = useCallback(async () => {
    cleanupDecoder();
    try { await invoke("disconnect_device"); } catch {}
    setConnectedDevice(null);
    setScreen("welcome");
    try {
      await getCurrentWindow().setSize(new LogicalSize(380, 750));
    } catch {}
  }, [cleanupDecoder]);

  const scheduleReconnect = useCallback((s: Settings) => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    reconnectTimer.current = setTimeout(() => {
      if (connectedDevice) {
        isReconnecting.current = true;
        connectToDevice(connectedDevice, s, true);
      }
    }, 800);
  }, [connectedDevice, connectToDevice]);

  const toggleRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === "recording") {
      recorderRef.current.stop();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const stream = canvas.captureStream(30);
    recordedChunks.current = [];
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(recordedChunks.current, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `recording-${Date.now()}.webm`;
      link.click();
      URL.revokeObjectURL(url);
      recordedChunks.current = [];
      recorderRef.current = null;
      setRecording(false);
      showToast("Recording saved", "info");
    };
    recorder.start(100);
    recorderRef.current = recorder;
    setRecording(true);
    showToast("Recording started", "info");
  }, [showToast]);

  const pressButton = useCallback(async (button: string) => {
    try { await invoke("press_button", { button }); } catch {}
  }, []);

  const handleCanvasMouseEvent = async (e: React.MouseEvent<HTMLCanvasElement>, action: string) => {
    if (!connectedDevice) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    try { await invoke("send_touch", { action, x, y }); } catch {}
  };

  const handleWheel = async (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!connectedDevice) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const dy = e.deltaY > 0 ? -1 : 1;
    try { await invoke("send_scroll", { x, y, dx: 0, dy }); } catch {}
  };

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (!connectedDevice) return;
    e.preventDefault();
    if (e.key.length === 1) {
      try { await invoke("send_text", { text: e.key }); } catch {}
    } else {
      const keyMap: Record<string, number> = {
        Enter: 66, Backspace: 67, Delete: 112,
        ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
        Escape: 111, Tab: 61,
      };
      const keycode = keyMap[e.key];
      if (keycode) {
        try {
          await invoke("send_key", { keycode, action: "down" });
          await invoke("send_key", { keycode, action: "up" });
        } catch {}
      }
    }
  };

  useEffect(() => {
    const unlisten = listen<string>("menu-event", (event) => {
      const id = event.payload;
      if (id === "disconnect") {
        disconnect();
      } else if (id === "toggle_theme") {
        opts.setThemePref((p) => p === "dark" ? "light" : p === "light" ? "dark" : "light");
      } else if (id === "settings") {
        opts.setShowSettings((s) => !s);
      } else if (id === "screenshot") {
        opts.takeScreenshot();
      } else if (["home", "back", "recents", "volume_up", "volume_down", "power"].includes(id)) {
        pressButton(id);
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [opts.takeScreenshot, pressButton, disconnect, opts.setThemePref, opts.setShowSettings]);

  return {
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
  };
}
