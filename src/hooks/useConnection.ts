import { useState, useRef, useCallback, useEffect } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import type { Device, Settings, FrameEvent, Screen, MacroEvent } from "../types";

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
  onFrameReceived?: () => void;
  onCodecFallback?: (codec: string) => void;
  onRecordEvent?: (event: MacroEvent) => void;
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
  const isMouseDownRef = useRef(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isReconnecting = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunks = useRef<Blob[]>([]);
  const nativeSize = useRef({ width: 1080, height: 1920 });
  const displaySizeRef = useRef({ width: 1080, height: 1920 });
  const resizeSnapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isProgrammaticResize = useRef(false);

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
    try { await invoke("set_muted", { muted: m }); } catch { }
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
              opts.onFrameReceived?.();
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
                    setDeviceSize((prev) => {
                      if (prev.width === f.displayWidth && prev.height === f.displayHeight) return prev;
                      const prevLandscape = prev.width > prev.height;
                      const nowLandscape = f.displayWidth > f.displayHeight;
                      if (prevLandscape !== nowLandscape) {
                        nativeSize.current = { width: nativeSize.current.height, height: nativeSize.current.width };
                      }
                      invoke("update_screen_size", { width: nativeSize.current.width, height: nativeSize.current.height });
                      displaySizeRef.current = { width: f.displayWidth, height: f.displayHeight };
                      const chromeH = 36;
                      const aspect = f.displayWidth / f.displayHeight;
                      const isLandscape = aspect > 1;
                      let viewW: number, viewH: number;
                      if (isLandscape) {
                        const maxViewW = 860;
                        viewW = maxViewW;
                        viewH = Math.round(maxViewW / aspect);
                      } else {
                        const maxViewH = 860;
                        viewH = maxViewH;
                        viewW = Math.round(maxViewH * aspect);
                      }
                      isProgrammaticResize.current = true;
                      getCurrentWindow().setSize(new LogicalSize(Math.max(viewW, 280), viewH + chromeH)).finally(() => {
                        isProgrammaticResize.current = false;
                      });
                      return { width: f.displayWidth, height: f.displayHeight };
                    });
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
          VideoDecoder.isConfigSupported(config).then((result) => {
            if (!result.supported) {
              // showToast("H.265 not supported on this platform, falling back to H.264", "info");
              opts.onCodecFallback?.("h264");
              return;
            }
            decoder.configure(config);
            decoderRef.current = decoder;
          });
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

      const { adaptive: _, ...streamSettings } = s;
      const [width, height] = await invoke<[number, number]>("connect_device", {
        serial: device.serial,
        onFrame: channel,
        settings: streamSettings,
      });
      nativeSize.current = { width, height };
      displaySizeRef.current = { width, height };
      setDeviceSize({ width, height });
      setConnectedDevice(device);
      setScreen("another");

      const chromeH = 36;
      const aspect = width / height;
      const isLandscape = aspect > 1;
      let viewW: number, viewH: number;
      if (isLandscape) {
        const maxViewW = 860;
        viewW = maxViewW;
        viewH = Math.round(maxViewW / aspect);
      } else {
        const maxViewH = 860;
        viewH = maxViewH;
        viewW = Math.round(maxViewH * aspect);
      }
      const win = getCurrentWindow();
      isProgrammaticResize.current = true;
      await win.setSize(new LogicalSize(Math.max(viewW, 280), viewH + chromeH));
      isProgrammaticResize.current = false;
    } catch (e) {
      if (!silent) showToast(`Failed to connect: ${e}`);
    } finally {
      setConnectingSerial(null);
      isReconnecting.current = false;
    }
  }, [showToast, cleanupDecoder]);

  const disconnect = useCallback(async () => {
    cleanupDecoder();
    try { await invoke("disconnect_device"); } catch { }
    setConnectedDevice(null);
    setScreen("welcome");
    try {
      await getCurrentWindow().setSize(new LogicalSize(380, 750));
    } catch { }
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
    recorder.onstop = async () => {
      const blob = new Blob(recordedChunks.current, { type: "video/webm" });
      const savePath = localStorage.getItem("save_path");
      if (savePath) {
        try {
          const buffer = await blob.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = "";
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const base64 = btoa(binary);
          const filename = `recording-${Date.now()}.webm`;
          await invoke("save_file", { path: `${savePath}/${filename}`, data: base64 });
        } catch {
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `recording-${Date.now()}.webm`;
          link.click();
          URL.revokeObjectURL(url);
        }
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `recording-${Date.now()}.webm`;
        link.click();
        URL.revokeObjectURL(url);
      }
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
    opts.onRecordEvent?.({ type: "button", button });
    try { await invoke("press_button", { button }); } catch { }
  }, []);

  const handleCanvasMouseEvent = async (e: React.MouseEvent<HTMLCanvasElement>, action: string) => {
    if (!connectedDevice) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    opts.onRecordEvent?.({ type: "touch", action, x, y });
    try { await invoke("send_touch", { action, x, y }); } catch { }
  };

  const handleWheel = async (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!connectedDevice) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const dy = e.deltaY > 0 ? -1 : 1;
    opts.onRecordEvent?.({ type: "scroll", x, y, dx: 0, dy });
    try { await invoke("send_scroll", { x, y, dx: 0, dy }); } catch { }
  };

  const composingRef = useRef(false);

  const handleCompositionStart = () => { composingRef.current = true; };
  const handleCompositionEnd = async (e: React.CompositionEvent) => {
    composingRef.current = false;
    if (!connectedDevice || !e.data) return;
    opts.onRecordEvent?.({ type: "text", text: e.data });
    try { await invoke("send_text", { text: e.data }); } catch { }
  };

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (!connectedDevice) return;
    if (composingRef.current || e.key === "Dead") return;
    e.preventDefault();
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      opts.onRecordEvent?.({ type: "text", text: e.key });
      try { await invoke("send_text", { text: e.key }); } catch { }
    } else {
      const keyMap: Record<string, number> = {
        Enter: 66, Backspace: 67, Delete: 112,
        ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
        Escape: 111, Tab: 61,
      };
      const keycode = keyMap[e.key];
      if (keycode) {
        opts.onRecordEvent?.({ type: "key", keycode, action: "down" });
        try {
          await invoke("send_key", { keycode, action: "down" });
          await invoke("send_key", { keycode, action: "up" });
        } catch { }
      }
    }
  };

  useEffect(() => {
    if (screen !== "another") return;
    let cancelled = false;
    const win = getCurrentWindow();
    const chromeH = 36;
    const resizeUnlisten = win.onResized(() => {
      if (isProgrammaticResize.current || cancelled) return;
      if (resizeSnapTimer.current) clearTimeout(resizeSnapTimer.current);
      resizeSnapTimer.current = setTimeout(() => {
        void (async () => {
          if (cancelled || isProgrammaticResize.current) return;
          try {
            const factor = await win.scaleFactor();
            const inner = await win.innerSize();
            const logical = inner.toLogical(factor);
            const cw = logical.width;
            const ch = logical.height - chromeH;
            if (ch < 200 || cw < 240) return;
            const { width: dw, height: dh } = displaySizeRef.current;
            const targetAspect = dw / dh;
            const currentAspect = cw / ch;
            if (Math.abs(currentAspect - targetAspect) < 0.01) return;
            let newW: number;
            let newH: number;
            if (currentAspect > targetAspect) {
              newH = ch;
              newW = Math.floor(ch * targetAspect);
            } else {
              newW = cw;
              newH = Math.floor(cw / targetAspect);
            }
            newW = Math.min(Math.max(newW, 280), cw);
            newH = Math.min(Math.max(newH, 240), ch);
            isProgrammaticResize.current = true;
            await win.setSize(new LogicalSize(newW, newH + chromeH));
            isProgrammaticResize.current = false;
          } catch {
            isProgrammaticResize.current = false;
          }
        })();
      }, 120);
    });
    return () => {
      cancelled = true;
      if (resizeSnapTimer.current) clearTimeout(resizeSnapTimer.current);
      void resizeUnlisten.then((fn) => fn());
    };
  }, [screen]);

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
  };
}
