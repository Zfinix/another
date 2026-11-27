import { useState, useRef, useCallback, useEffect } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import type { Device, Settings, FrameEvent, Screen, MacroEvent, PerfStats, EncoderTuning, DevSettings } from "../types";

export const CHROME_H = 40;
export const FRAME_PAD = 8;
const MAX_VIEW = 860;
const PERF_INTERVAL_MS = 1000;
const VIDEO_KIND_CONFIG = 0;
const VIDEO_KIND_KEY = 1;
const VIDEO_HEADER_LEN = 25;
const MAX_TRACKED_DECODES = 300;

interface PerfCounters {
  packets: number;
  bytes: number;
  decoded: number;
  rendered: number;
  dropped: number;
  decodeMsTotal: number;
  decodeSamples: number;
  pipelineMsTotal: number;
  pipelineSamples: number;
  lagMsTotal: number;
  lagMsMax: number;
  screenMsTotal: number;
  screenMsMax: number;
  screenSamples: number;
}

const emptyCounters = (): PerfCounters => ({
  packets: 0,
  bytes: 0,
  decoded: 0,
  rendered: 0,
  dropped: 0,
  decodeMsTotal: 0,
  decodeSamples: 0,
  pipelineMsTotal: 0,
  pipelineSamples: 0,
  lagMsTotal: 0,
  lagMsMax: 0,
  screenMsTotal: 0,
  screenMsMax: 0,
  screenSamples: 0,
});

const epochNow = () => performance.timeOrigin + performance.now();

const SAME_ASPECT_TOLERANCE = 0.02;

function windowSizeFor(width: number, height: number) {
  const aspect = width / height;
  const viewW = aspect > 1 ? MAX_VIEW : Math.round(MAX_VIEW * aspect);
  const viewH = aspect > 1 ? Math.round(MAX_VIEW / aspect) : MAX_VIEW;
  return new LogicalSize(Math.max(viewW, 280) + FRAME_PAD * 2, viewH + CHROME_H + FRAME_PAD);
}

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
  onToggleAlwaysOnTop: () => void;
  onFrameReceived?: () => void;
  onPacketReceived?: (ptsUs: number) => void;
  onNativeStats?: (fps: number, lagMinMs: number) => void;
  onCodecFallback?: (codec: string) => void;
  onRecordEvent?: (event: MacroEvent) => void;
  perfOverlay?: boolean;
  directAdb?: boolean;
  lowLatency?: boolean;
  encoderTuning?: EncoderTuning;
  anotherServer?: boolean;
  nativeVideo?: boolean;
  networkStream?: boolean;
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
  const connectionGen = useRef(0);
  const pendingPackets = useRef<EncodedVideoChunk[]>([]);
  const awaitingKeyFrame = useRef(true);
  const [streamReady, setStreamReady] = useState(false);
  const streamReadyRef = useRef(false);
  const perfCounters = useRef<PerfCounters>(emptyCounters());
  const decodeStarts = useRef(new Map<number, number>());
  const recvTimes = useRef(new Map<number, number>());
  const captureTimes = useRef(new Map<number, number>());
  const lagBaseline = useRef<{ offset: number; lastPts: number } | null>(null);
  const codecRef = useRef("");
  const [perfStats, setPerfStats] = useState<PerfStats | null>(null);
  const directAdbRef = useRef(!!opts.directAdb);
  directAdbRef.current = !!opts.directAdb;
  const lowLatencyRef = useRef(!!opts.lowLatency);
  lowLatencyRef.current = !!opts.lowLatency;
  const encoderTuningRef = useRef<EncoderTuning>(opts.encoderTuning ?? "default");
  encoderTuningRef.current = opts.encoderTuning ?? "default";
  const anotherServerRef = useRef(!!opts.anotherServer);
  anotherServerRef.current = !!opts.anotherServer;
  const nativeVideoRef = useRef(!!opts.nativeVideo);
  nativeVideoRef.current = !!opts.nativeVideo;
  const networkStreamRef = useRef(opts.networkStream !== false);
  networkStreamRef.current = opts.networkStream !== false;
  const [nativeActive, setNativeActive] = useState(false);
  const nativeActiveRef = useRef(false);
  nativeActiveRef.current = nativeActive;
  const perfOverlayRef = useRef(!!opts.perfOverlay);
  perfOverlayRef.current = !!opts.perfOverlay;
  const videoSocketRef = useRef<WebSocket | null>(null);
  const videoSocketFailed = useRef(false);
  const frameDrawnRef = useRef<(() => void) | null>(null);
  const reconnectRef = useRef<((device: Device, s: Settings) => void) | null>(null);

  const closeVideoSocket = useCallback(() => {
    const ws = videoSocketRef.current;
    videoSocketRef.current = null;
    if (ws) {
      ws.onmessage = null;
      ws.onerror = null;
      ws.close();
    }
  }, []);

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
    }
    decoderRef.current = null;
    pendingPackets.current = [];
    awaitingKeyFrame.current = true;
    setMutedState(false);
    if (recorderRef.current && recorderRef.current.state === "recording") {
      recorderRef.current.stop();
    }
  }, []);

  const setMuted = useCallback(async (m: boolean) => {
    setMutedState(m);
    try { await invoke("set_muted", { muted: m }); } catch { }
  }, []);

  const feedChunk = useCallback((chunk: EncodedVideoChunk) => {
    const decoder = decoderRef.current;
    if (!decoder || decoder.state !== "configured") return;
    if (awaitingKeyFrame.current) {
      if (chunk.type !== "key") return;
      awaitingKeyFrame.current = false;
    }
    try {
      if (decodeStarts.current.size > MAX_TRACKED_DECODES) decodeStarts.current.clear();
      decodeStarts.current.set(chunk.timestamp, performance.now());
      decoder.decode(chunk);
    } catch (e) {
      console.error("Decode failed:", e);
      awaitingKeyFrame.current = true;
    }
  }, []);

  const connectToDevice = useCallback(async (device: Device, s: Settings, silent = false, dev?: DevSettings) => {
    if (dev) {
      directAdbRef.current = dev.directAdb;
      lowLatencyRef.current = dev.lowLatency;
      encoderTuningRef.current = dev.encoderTuning;
      anotherServerRef.current = dev.anotherServer;
      nativeVideoRef.current = dev.nativeVideo;
      networkStreamRef.current = dev.networkStream;
      perfOverlayRef.current = dev.perfOverlay;
    }
    const gen = ++connectionGen.current;
    const keepLastFrame = silent && streamReadyRef.current;
    if (!keepLastFrame) {
      streamReadyRef.current = false;
      setStreamReady(false);
    }
    setConnectingSerial(device.serial);
    cleanupDecoder();
    closeVideoSocket();
    const lowLatency = lowLatencyRef.current && !videoSocketFailed.current;
    const anotherServer = anotherServerRef.current;
    try {
      const resizeToFrame = (canvas: HTMLCanvasElement, width: number, height: number) => {
        if (canvas.width === width && canvas.height === height) return;
        canvas.width = width;
        canvas.height = height;
        if (nativeSize.current.width === width && nativeSize.current.height === height) return;
        const previous = nativeSize.current;
        nativeSize.current = { width, height };
        displaySizeRef.current = { width, height };
        invoke("update_screen_size", { width, height });
        setDeviceSize({ width, height });
        if (previous.width > 0 && Math.abs(previous.width / previous.height - width / height) < SAME_ASPECT_TOLERANCE) return;
        isProgrammaticResize.current = true;
        getCurrentWindow().setSize(windowSizeFor(width, height)).finally(() => {
          isProgrammaticResize.current = false;
        });
      };

      const markStreamReady = () => {
        if (!streamReadyRef.current) {
          streamReadyRef.current = true;
          setStreamReady(true);
        }
      };

      const handleConfig = (codec: string, descBytes: Uint8Array) => {
        cleanupDecoder();
        codecRef.current = codec;
        const config: VideoDecoderConfig = {
          codec,
          description: descBytes,
          hardwareAcceleration: "prefer-hardware",
          ...(lowLatency ? { optimizeForLatency: true } : {}),
        };
        const createDecoder = (): VideoDecoder => {
          const decoder: VideoDecoder = new VideoDecoder({
            output: (frame: VideoFrame) => {
              opts.onFrameReceived?.();
              const counters = perfCounters.current;
              counters.decoded++;
              const started = decodeStarts.current.get(frame.timestamp);
              if (started !== undefined) {
                decodeStarts.current.delete(frame.timestamp);
                counters.decodeMsTotal += performance.now() - started;
                counters.decodeSamples++;
              }
              if (pendingFrame.current) {
                counters.dropped++;
                pendingFrame.current.close();
              }
              pendingFrame.current = frame;
              if (!rafId.current) {
                const draw = () => {
                  rafId.current = 0;
                  const f = pendingFrame.current;
                  if (!f) return;
                  const canvas = canvasRef.current;
                  if (!canvas) {
                    rafId.current = requestAnimationFrame(draw);
                    return;
                  }
                  pendingFrame.current = null;
                  resizeToFrame(canvas, f.displayWidth, f.displayHeight);
                  const ctx = canvas.getContext("2d");
                  if (ctx) ctx.drawImage(f, 0, 0);
                  frameDrawnRef.current?.();
                  const captureMs = captureTimes.current.get(f.timestamp);
                  if (captureMs !== undefined) {
                    captureTimes.current.delete(f.timestamp);
                    const screenMs = epochNow() - captureMs;
                    perfCounters.current.screenMsTotal += screenMs;
                    perfCounters.current.screenSamples++;
                    if (screenMs > perfCounters.current.screenMsMax) perfCounters.current.screenMsMax = screenMs;
                  }
                  const recvMs = recvTimes.current.get(f.timestamp);
                  if (recvMs !== undefined) {
                    recvTimes.current.delete(f.timestamp);
                    perfCounters.current.pipelineMsTotal += epochNow() - recvMs;
                    perfCounters.current.pipelineSamples++;
                  }
                  f.close();
                  perfCounters.current.rendered++;
                  markStreamReady();
                };
                draw();
              }
            },
            error: (e: DOMException) => {
              console.error("Decoder error:", e);
              if (gen !== connectionGen.current) return;
              decoderRef.current = null;
              awaitingKeyFrame.current = true;
              if (anotherServer) invoke("request_key_frame").catch(() => { });
              const fresh = createDecoder();
              fresh.configure(config);
              decoderRef.current = fresh;
            },
          });
          return decoder;
        };
        VideoDecoder.isConfigSupported(config).then((result) => {
          if (gen !== connectionGen.current) return;
          if (!result.supported) {
            opts.onCodecFallback?.("h264");
            return;
          }
          const decoder = createDecoder();
          decoder.configure(config);
          decoderRef.current = decoder;
          const queued = pendingPackets.current;
          pendingPackets.current = [];
          for (const chunk of queued) feedChunk(chunk);
        });
      };

      const handlePacket = (key: boolean, timestamp: number, recvMs: number, captureMs: number | null, data: Uint8Array) => {
        const chunk = new EncodedVideoChunk({
          type: key ? "key" : "delta",
          timestamp,
          data,
        });
        opts.onPacketReceived?.(timestamp);
        if (recvTimes.current.size > MAX_TRACKED_DECODES) recvTimes.current.clear();
        recvTimes.current.set(timestamp, recvMs);
        if (captureMs !== null && Number.isFinite(captureMs)) {
          if (captureTimes.current.size > MAX_TRACKED_DECODES) captureTimes.current.clear();
          captureTimes.current.set(timestamp, captureMs);
        }
        const offset = recvMs - timestamp / 1000;
        const base = lagBaseline.current;
        if (!base || timestamp < base.lastPts || offset < base.offset) {
          lagBaseline.current = { offset, lastPts: timestamp };
        } else {
          base.lastPts = timestamp;
        }
        const lag = offset - lagBaseline.current!.offset;
        perfCounters.current.lagMsTotal += lag;
        if (lag > perfCounters.current.lagMsMax) perfCounters.current.lagMsMax = lag;
        perfCounters.current.packets++;
        perfCounters.current.bytes += chunk.byteLength;
        if (!decoderRef.current) {
          if (chunk.type === "key") pendingPackets.current = [chunk];
          else if (pendingPackets.current.length > 0) pendingPackets.current.push(chunk);
          return;
        }
        feedChunk(chunk);
      };

      const channel = new Channel<FrameEvent>();
      channel.onmessage = (msg) => {
        if (gen !== connectionGen.current) return;
        if (msg.event === "config") {
          handleConfig(msg.data.codec, b64ToBytes(msg.data.description));
        } else if (msg.event === "packet") {
          handlePacket(msg.data.key, msg.data.timestamp, msg.data.recv_ms, msg.data.capture_ms, b64ToBytes(msg.data.data));
        } else if (msg.event === "native_size") {
          const canvas = canvasRef.current;
          if (canvas) resizeToFrame(canvas, msg.data.width, msg.data.height);
          markStreamReady();
        } else if (msg.event === "native_stats") {
          opts.onNativeStats?.(msg.data.fps, msg.data.lag_min_ms);
          if (!perfOverlayRef.current) return;
          const canvas = canvasRef.current;
          invoke("log_perf", { stats: { renderer: "native", ...msg.data } }).catch(() => { });
          setPerfStats({
            renderFps: msg.data.fps,
            decodeFps: msg.data.fps,
            packetsPerSec: msg.data.fps,
            dropped: 0,
            bitrateKbps: msg.data.kbps,
            decodeMs: msg.data.decode_ms,
            pipelineMs: msg.data.decode_ms,
            deviceLagMs: msg.data.lag_ms,
            deviceLagMaxMs: msg.data.lag_max_ms,
            screenMs: msg.data.screen_ms,
            screenMaxMs: msg.data.screen_max_ms,
            decodeQueue: 0,
            width: canvas?.width ?? 0,
            height: canvas?.height ?? 0,
            codec: "native",
          });
        } else if (msg.event === "disconnected") {
          cleanupDecoder();
          closeVideoSocket();
          if (!isReconnecting.current) {
            setConnectedDevice(null);
            setScreen("welcome");
            showToast("Device disconnected", "info");
          }
        }
      };

      const { adaptive: _, ...streamSettings } = s;
      const [width, height, videoUrl, native] = await invoke<[number, number, string | null, boolean]>("connect_device", {
        serial: device.serial,
        onFrame: channel,
        settings: {
          ...streamSettings,
          direct_adb: directAdbRef.current,
          low_latency: lowLatency,
          encoder_tuning: encoderTuningRef.current,
          another_server: anotherServer,
          native_video: nativeVideoRef.current,
          network_stream: networkStreamRef.current,
        },
      });
      if (gen !== connectionGen.current) return;
      setNativeActive(native);
      if (videoUrl) {
        const ws = new WebSocket(videoUrl);
        ws.binaryType = "arraybuffer";
        ws.onmessage = (e: MessageEvent<ArrayBuffer>) => {
          if (gen !== connectionGen.current) return;
          receivedVideo = true;
          const buf = e.data;
          const view = new DataView(buf);
          const kind = view.getUint8(0);
          if (kind === VIDEO_KIND_CONFIG) {
            const codecLen = view.getUint8(1);
            const codec = new TextDecoder().decode(new Uint8Array(buf, 2, codecLen));
            handleConfig(codec, new Uint8Array(buf, 2 + codecLen));
          } else {
            const timestamp = Number(view.getBigUint64(1));
            const recvMs = view.getFloat64(9);
            const captureMs = view.getFloat64(17);
            handlePacket(kind === VIDEO_KIND_KEY, timestamp, recvMs, captureMs, new Uint8Array(buf, VIDEO_HEADER_LEN));
          }
        };
        let receivedVideo = false;
        ws.onerror = () => {
          if (gen !== connectionGen.current || receivedVideo) return;
          console.warn("Video WebSocket failed, falling back to IPC");
          videoSocketFailed.current = true;
          isReconnecting.current = true;
          reconnectRef.current?.(device, s);
        };
        videoSocketRef.current = ws;
      }
      nativeSize.current = { width, height };
      displaySizeRef.current = { width, height };
      setDeviceSize({ width, height });
      setConnectedDevice(device);
      setScreen("another");

      isProgrammaticResize.current = true;
      await getCurrentWindow().setSize(windowSizeFor(width, height));
      isProgrammaticResize.current = false;
    } catch (e) {
      if (!silent) showToast(`Failed to connect: ${e}`);
      else if (gen === connectionGen.current) {
        streamReadyRef.current = false;
        setStreamReady(false);
        showToast(`Reconnect failed: ${e}`);
      }
    } finally {
      if (gen === connectionGen.current) {
        setConnectingSerial(null);
        isReconnecting.current = false;
      }
    }
  }, [showToast, cleanupDecoder, feedChunk, closeVideoSocket]);
  reconnectRef.current = (device, s) => { connectToDevice(device, s, true); };

  const disconnect = useCallback(async () => {
    connectionGen.current++;
    isReconnecting.current = false;
    cleanupDecoder();
    closeVideoSocket();
    try { await invoke("disconnect_device"); } catch { }
    setConnectedDevice(null);
    setScreen("welcome");
    try {
      await getCurrentWindow().setSize(new LogicalSize(380, 750));
    } catch { }
  }, [cleanupDecoder, closeVideoSocket]);

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
            const cw = logical.width - FRAME_PAD * 2;
            const ch = logical.height - CHROME_H - FRAME_PAD;
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
            await win.setSize(new LogicalSize(newW + FRAME_PAD * 2, newH + CHROME_H + FRAME_PAD));
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
      } else if (id === "always_on_top") {
        opts.onToggleAlwaysOnTop();
      } else if (["home", "back", "recents", "volume_up", "volume_down", "power"].includes(id)) {
        pressButton(id);
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [opts.takeScreenshot, pressButton, disconnect, opts.setThemePref, opts.setShowSettings]);

  useEffect(() => {
    if (!opts.perfOverlay) {
      setPerfStats(null);
      return;
    }
    perfCounters.current = emptyCounters();
    let last = performance.now();
    const timer = setInterval(() => {
      if (nativeActiveRef.current) return;
      const now = performance.now();
      const secs = (now - last) / 1000;
      last = now;
      const c = perfCounters.current;
      perfCounters.current = emptyCounters();
      const stats: PerfStats = {
        renderFps: Math.round(c.rendered / secs),
        decodeFps: Math.round(c.decoded / secs),
        packetsPerSec: Math.round(c.packets / secs),
        dropped: c.dropped,
        bitrateKbps: Math.round((c.bytes * 8) / secs / 1000),
        decodeMs: c.decodeSamples ? c.decodeMsTotal / c.decodeSamples : 0,
        pipelineMs: c.pipelineSamples ? c.pipelineMsTotal / c.pipelineSamples : 0,
        deviceLagMs: c.packets ? c.lagMsTotal / c.packets : 0,
        deviceLagMaxMs: c.lagMsMax,
        screenMs: c.screenSamples ? c.screenMsTotal / c.screenSamples : 0,
        screenMaxMs: c.screenMsMax,
        decodeQueue: decoderRef.current?.decodeQueueSize ?? 0,
        width: canvasRef.current?.width ?? 0,
        height: canvasRef.current?.height ?? 0,
        codec: codecRef.current,
      };
      setPerfStats(stats);
      if (c.packets > 0) invoke("log_perf", { stats }).catch(() => { });
    }, PERF_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [opts.perfOverlay]);

  return {
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
  };
}
