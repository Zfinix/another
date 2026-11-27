import { useState, useEffect, useRef } from "react";
import type React from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Cog6ToothIcon,
  CameraIcon,
  ChevronLeftIcon,
  XMarkIcon,
  HomeIcon,
  Square2StackIcon,
  CommandLineIcon,
  StopIcon,
  VideoCameraIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
  PowerIcon,
  ArrowPathIcon,
} from "@heroicons/react/24/outline";
import type { Device, PerfStats } from "../types";
import { getDeviceDisplayName, type QuickActionId } from "../types";
import { Button } from "@/components/ui/button";

const QUICK_ACTION_ICONS: Record<QuickActionId, (props: { muted?: boolean; recording?: boolean; macroRecording?: boolean }) => React.ReactNode> = {
  record: ({ recording }) => recording ? <StopIcon className="text-danger" /> : <VideoCameraIcon />,
  mute: ({ muted }) => muted ? <SpeakerXMarkIcon /> : <SpeakerWaveIcon />,
  volume_up: () => <span className="text-[11px] font-bold">V+</span>,
  volume_down: () => <span className="text-[11px] font-bold">V-</span>,
  power: () => <PowerIcon />,
  "macro-toggle": ({ macroRecording }) => macroRecording ? <StopIcon className="text-[#f5a524]" /> : (
    <svg width="15" height="15" viewBox="0 0 24 25" fill="none" className="text-current">
      <path d="M11.41 2.068c-.57 0-1.08 0-1.55.17-.1.04-.19.08-.29.12-.46.22-.81.58-1.21.98L3.58 8.148c-.47.47-.88.88-1.11 1.43-.22.54-.22 1.13-.22 1.8v3.47c0 1.78 0 3.22.15 4.35.16 1.17.49 2.16 1.27 2.95.78.78 1.76 1.12 2.93 1.28 1.12.15 2.55.15 4.33.15s3.31 0 4.43-.15c-.49-1.1-1.51-2.09-2.61-2.52-1.66-.65-1.66-3.01 0-3.66 1.16-.46 2.22-1.52 2.67-2.67.66-1.66 3.01-1.66 3.66 0 .16.41.39.81.67 1.17V14.858c0-1.53 0-2.77-.11-3.75-.12-1.02-.37-1.89-.96-2.63-.22-.27-.46-.52-.73-.74-.73-.6-1.6-.85-2.61-.97-1.18-.11-2.4-.11-3.92-.11z" fill="currentColor" opacity="0.5"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M9.569 2.358c.09-.05.19-.09.29-.12.21-.07.42-.12.65-.14v1.99c0 1.36 0 2.01-.12 2.88-.12.9-.38 1.66-.98 2.26s-1.36.86-2.26.98c-.87.12-1.52.12-2.88.12H2.289c.03-.26.09-.51.18-.75.22-.54.64-.96 1.11-1.43l4.78-4.81c.4-.4.76-.77 1.21-.98zM17.919 23.118c-.24.61-1.09.61-1.33 0l-.04-.1a5.73 5.73 0 00-3.23-3.23l-.11-.04c-.6-.24-.6-1.1 0-1.33l.11-.04a5.73 5.73 0 003.23-3.23l.04-.1c.24-.61 1.09-.61 1.33 0l.04.1a5.73 5.73 0 003.23 3.23l.11.04c.6.24.6 1.1 0 1.33l-.11.04a5.73 5.73 0 00-3.23 3.23l-.04.1z" fill="currentColor"/>
    </svg>
  ),
  rotate: () => <ArrowPathIcon />,
};

interface MirrorScreenProps {
  connectedDevice: Device;
  connecting?: boolean;
  streamReady: boolean;
  deviceSize: { width: number; height: number };
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  isMouseDownRef: React.MutableRefObject<boolean>;
  recording: boolean;
  muted: boolean;
  macroRecording: boolean;
  pinnedActions: QuickActionId[];
  alwaysOnTop: boolean;
  adaptiveInfo?: { enabled: boolean; tierName: string; fps: number; lagMs: number };
  perfStats?: PerfStats | null;
  nativeVideo?: boolean;
  onToggleRecording: () => void;
  onToggleMacroRecording: () => void;
  onPressButton: (button: string) => void;
  onTakeScreenshot: () => void;
  onToggleSettings: () => void;
  onOpenCommandBar: () => void;
  onToggleAlwaysOnTop: () => void;
  onDisconnect: () => void;
  onRotate: () => void;
  onToggleMute: () => void;
  onCanvasMouseEvent: (e: React.MouseEvent<HTMLCanvasElement>, action: string) => void;
  onWheel: (e: React.WheelEvent<HTMLCanvasElement>) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (e: React.CompositionEvent) => void;
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

const mirrorToolbarBtnClass =
  "size-7 min-h-0 shrink-0 gap-0 rounded-md border-transparent p-0 shadow-none text-text-2 hover:bg-transparent dark:hover:bg-transparent hover:text-foreground press [&_svg]:!size-4";

const pillClass =
  "absolute left-1/2 -translate-x-1/2 flex items-center gap-2.5 h-9 pl-3.5 pr-1.5 bg-popover/90 border border-border backdrop-blur-xl rounded-full shadow-(--float-shadow) z-10 animate-in fade-in slide-in-from-bottom-2 duration-200";

export function MirrorScreen({
  connectedDevice,
  connecting,
  streamReady,
  deviceSize,
  canvasRef,
  isMouseDownRef,
  recording,
  muted,
  macroRecording,
  pinnedActions,
  alwaysOnTop,
  adaptiveInfo,
  perfStats,
  nativeVideo = false,
  onToggleRecording,
  onToggleMacroRecording,
  onPressButton,
  onTakeScreenshot,
  onToggleSettings,
  onOpenCommandBar,
  onToggleAlwaysOnTop,
  onDisconnect,
  onRotate,
  onToggleMute,
  onCanvasMouseEvent,
  onWheel,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
}: MirrorScreenProps) {
  const quickActionHandlers: Record<QuickActionId, () => void> = {
    record: onToggleRecording,
    mute: onToggleMute,
    volume_up: () => onPressButton("volume_up"),
    volume_down: () => onPressButton("volume_down"),
    power: () => onPressButton("power"),
    "macro-toggle": onToggleMacroRecording,
    rotate: onRotate,
  };

  const quickActionTitles: Record<QuickActionId, string> = {
    record: recording ? "Stop Recording" : "Record",
    mute: muted ? "Unmute" : "Mute",
    volume_up: "Volume Up",
    volume_down: "Volume Down",
    power: "Power",
    "macro-toggle": macroRecording ? "Stop Macro" : "Record Macro",
    rotate: "Rotate",
  };
  const [elapsed, setElapsed] = useState(0);
  const [macroElapsed, setMacroElapsed] = useState(0);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [slowStart, setSlowStart] = useState(false);

  useEffect(() => {
    setSlowStart(false);
    if (streamReady) return;
    const t = setTimeout(() => setSlowStart(true), 5000);
    return () => clearTimeout(t);
  }, [streamReady]);
  useEffect(() => {
    if (!nativeVideo) return;
    const root = document.documentElement;
    root.classList.add("native-video");
    const report = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      invoke("set_native_video_frame", { x: rect.left, y: rect.top, width: rect.width, height: rect.height }).catch(() => { });
    };
    report();
    const observer = new ResizeObserver(report);
    if (canvasRef.current) observer.observe(canvasRef.current);
    window.addEventListener("resize", report);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
      root.classList.remove("native-video");
    };
  }, [nativeVideo, canvasRef, deviceSize, streamReady]);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const macroIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === "Shift") setShiftHeld(true); };
    const up = (e: KeyboardEvent) => { if (e.key === "Shift") setShiftHeld(false); };
    const blur = () => setShiftHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  useEffect(() => {
    if (recording) {
      setElapsed(0);
      intervalRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [recording]);

  useEffect(() => {
    if (macroRecording) {
      setMacroElapsed(0);
      macroIntervalRef.current = setInterval(() => setMacroElapsed((s) => s + 1), 1000);
    } else {
      if (macroIntervalRef.current) clearInterval(macroIntervalRef.current);
      macroIntervalRef.current = null;
    }
    return () => { if (macroIntervalRef.current) clearInterval(macroIntervalRef.current); };
  }, [macroRecording]);

  return (
    <div className={`flex flex-col h-screen w-screen animate-in fade-in duration-300 ${nativeVideo ? "" : "bg-background"}`}>
      <div className={`h-10 shrink-0 flex items-center pl-[78px] pr-2 drag-region ${nativeVideo ? "relative z-10 bg-background" : ""}`} data-tauri-drag-region>
        <div className="flex items-center gap-1.5 min-w-0 mr-auto drag-region" data-tauri-drag-region>
          <span className="text-[12px] font-medium text-foreground truncate" data-tauri-drag-region>{getDeviceDisplayName(connectedDevice)}</span>
        </div>
        <div className="flex items-center gap-0.5 no-drag">
          {shiftHeld
            ? <Button variant="ghost" className={mirrorToolbarBtnClass} onClick={() => onPressButton("back")} title="Back"><ChevronLeftIcon /></Button>
            : <Button variant="ghost" className={mirrorToolbarBtnClass} onClick={() => onPressButton("home")} title="Home"><HomeIcon /></Button>}
          {shiftHeld
            ? <Button variant="ghost" className={mirrorToolbarBtnClass} onClick={() => onPressButton("power")} title="Power"><PowerIcon /></Button>
            : <Button variant="ghost" className={mirrorToolbarBtnClass} onClick={() => onPressButton("recents")} title="Recents"><Square2StackIcon /></Button>}
        </div>
        {pinnedActions.length > 0 && (
          <>
            <div className="w-px h-4 bg-border mx-1.5 shrink-0" />
            <div className="flex items-center gap-0.5 no-drag">
              {pinnedActions.map((id) => (
                <Button key={id} variant="ghost" className={mirrorToolbarBtnClass} onClick={quickActionHandlers[id]} title={quickActionTitles[id]}>
                  {QUICK_ACTION_ICONS[id]({ muted, recording, macroRecording })}
                </Button>
              ))}
            </div>
          </>
        )}
        <div className="w-px h-4 bg-border mx-1.5 shrink-0" />
        <div className="flex items-center gap-0.5 no-drag">
          {shiftHeld
            ? <Button variant="ghost" className={mirrorToolbarBtnClass} onClick={onRotate} title="Rotate"><ArrowPathIcon /></Button>
            : <Button variant="ghost" className={mirrorToolbarBtnClass} onClick={onOpenCommandBar} title="Commands"><CommandLineIcon /></Button>}
          {shiftHeld
            ? <Button variant="ghost" className={mirrorToolbarBtnClass} onClick={onToggleRecording} title={recording ? "Stop Recording" : "Record"}>{recording ? <StopIcon className="text-danger" /> : <VideoCameraIcon />}</Button>
            : <Button variant="ghost" className={mirrorToolbarBtnClass} onClick={onTakeScreenshot} title="Screenshot"><CameraIcon /></Button>}
          <Button variant="ghost" className={mirrorToolbarBtnClass} onClick={onToggleSettings} title="Settings"><Cog6ToothIcon /></Button>
          <Button variant="ghost" className={`${mirrorToolbarBtnClass} ${alwaysOnTop ? "text-brand" : ""}`} onClick={onToggleAlwaysOnTop} title={alwaysOnTop ? "Disable Always on Top" : "Always on Top"}>
            <svg viewBox="0 0 24 24" fill={alwaysOnTop ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 17v5" /><path d="M5 17h14" /><path d="M15 3H9v7l-2.5 7h11L15 10V3z" /></svg>
          </Button>
          <Button variant="ghost" className={mirrorToolbarBtnClass} onClick={onDisconnect} title="Disconnect"><XMarkIcon /></Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 px-2 pb-2">
        <div className={`relative size-full flex items-center justify-center overflow-hidden rounded-[12px] outline-none ${nativeVideo ? "native-video-frame" : "bg-canvas-bg"}`} tabIndex={0} onKeyDown={onKeyDown} onCompositionStart={onCompositionStart} onCompositionEnd={onCompositionEnd}>
          {connecting ? (
            <div className="flex flex-col items-center gap-3 text-text-2">
              <div className="size-5 border-[1.5px] border-border border-t-brand rounded-full animate-spin" />
              <p className="text-[12px]">Connecting</p>
            </div>
          ) : (
            <canvas
              ref={canvasRef}
              width={deviceSize.width}
              height={deviceSize.height}
              className={`max-w-full max-h-full object-contain cursor-default block transition-opacity duration-300 ${nativeVideo ? "native-video-hole" : streamReady ? "opacity-100" : "opacity-0"}`}
              onMouseDown={(e) => { isMouseDownRef.current = true; onCanvasMouseEvent(e, "down"); }}
              onMouseMove={(e) => { if (isMouseDownRef.current) onCanvasMouseEvent(e, "move"); }}
              onMouseUp={(e) => { isMouseDownRef.current = false; onCanvasMouseEvent(e, "up"); }}
              onMouseLeave={(e) => { if (isMouseDownRef.current) { isMouseDownRef.current = false; onCanvasMouseEvent(e, "up"); } }}
              onWheel={onWheel}
              onContextMenu={(e) => e.preventDefault()}
            />
          )}

          {!connecting && !streamReady && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center pointer-events-none animate-in fade-in duration-300">
              <div className="relative h-px w-24 bg-border overflow-hidden scan-bar" />
              <p className="text-[12px] text-text-2">Waiting for the screen</p>
              <p className={`text-[11.5px] leading-[1.5] text-text-3 max-w-[220px] transition-opacity duration-300 ${slowStart ? "opacity-100" : "opacity-0"}`}>
                Taking a while. Wake your phone, or close and reconnect.
              </p>
            </div>
          )}

          <div className="pointer-events-none absolute inset-0 rounded-[12px] ring-1 ring-inset ring-border" />

          {recording && (
            <div className={`${pillClass} bottom-3`}>
              <span className="size-2 rounded-full bg-danger shrink-0 motion-safe:animate-pulse" />
              <span className="text-[12.5px] font-medium font-mono tabular-nums text-foreground min-w-10">{formatTime(elapsed)}</span>
              <Button variant="ghost" className="flex items-center gap-1 h-6 px-2.5 bg-danger border-transparent rounded-full text-white text-[11.5px] font-medium hover:bg-danger/85 dark:hover:bg-danger/85 hover:text-white press [&_svg]:size-3" onClick={onToggleRecording}>
                <StopIcon />
                Stop
              </Button>
            </div>
          )}

          {macroRecording && (
            <div className={`${pillClass} ${recording ? "bottom-14" : "bottom-3"}`}>
              <svg width="12" height="12" viewBox="0 0 24 25" fill="none" className="text-[#f5a524] shrink-0 motion-safe:animate-pulse">
                <path d="M11.41 2.068c-.57 0-1.08 0-1.55.17-.1.04-.19.08-.29.12-.46.22-.81.58-1.21.98L3.58 8.148c-.47.47-.88.88-1.11 1.43-.22.54-.22 1.13-.22 1.8v3.47c0 1.78 0 3.22.15 4.35.16 1.17.49 2.16 1.27 2.95.78.78 1.76 1.12 2.93 1.28 1.12.15 2.55.15 4.33.15s3.31 0 4.43-.15c-.49-1.1-1.51-2.09-2.61-2.52-1.66-.65-1.66-3.01 0-3.66 1.16-.46 2.22-1.52 2.67-2.67.66-1.66 3.01-1.66 3.66 0 .16.41.39.81.67 1.17V14.858c0-1.53 0-2.77-.11-3.75-.12-1.02-.37-1.89-.96-2.63-.22-.27-.46-.52-.73-.74-.73-.6-1.6-.85-2.61-.97-1.18-.11-2.4-.11-3.92-.11z" fill="currentColor" opacity="0.5"/>
                <path fillRule="evenodd" clipRule="evenodd" d="M9.569 2.358c.09-.05.19-.09.29-.12.21-.07.42-.12.65-.14v1.99c0 1.36 0 2.01-.12 2.88-.12.9-.38 1.66-.98 2.26s-1.36.86-2.26.98c-.87.12-1.52.12-2.88.12H2.289c.03-.26.09-.51.18-.75.22-.54.64-.96 1.11-1.43l4.78-4.81c.4-.4.76-.77 1.21-.98zM17.919 23.118c-.24.61-1.09.61-1.33 0l-.04-.1a5.73 5.73 0 00-3.23-3.23l-.11-.04c-.6-.24-.6-1.1 0-1.33l.11-.04a5.73 5.73 0 003.23-3.23l.04-.1c.24-.61 1.09-.61 1.33 0l.04.1a5.73 5.73 0 003.23 3.23l.11.04c.6.24.6 1.1 0 1.33l-.11.04a5.73 5.73 0 00-3.23 3.23l-.04.1z" fill="currentColor"/>
              </svg>
              <span className="text-[12.5px] font-medium font-mono tabular-nums text-foreground min-w-10">{formatTime(macroElapsed)}</span>
              <Button variant="ghost" className="flex items-center gap-1 h-6 px-2.5 bg-[#f5a524] border-transparent rounded-full text-[#0a0a0a] text-[11.5px] font-medium hover:bg-[#f5a524]/85 dark:hover:bg-[#f5a524]/85 hover:text-[#0a0a0a] press [&_svg]:size-3" onClick={onToggleMacroRecording}>
                <StopIcon />
                Stop
              </Button>
            </div>
          )}

          {perfStats && (
            <div className="absolute top-2 right-2 flex flex-col gap-0.5 px-2.5 py-2 bg-popover/85 border border-border backdrop-blur-lg rounded-lg text-text-2 font-mono tabular-nums text-[10px] leading-tight z-5 pointer-events-none">
              <span className="text-foreground text-[11px] font-semibold">{perfStats.renderFps} fps</span>
              {perfStats.screenMs > 0 && (
                <span className="text-foreground">capture→screen {perfStats.screenMs.toFixed(1)} ms (max {perfStats.screenMaxMs.toFixed(0)})</span>
              )}
              <span>device lag {perfStats.deviceLagMs.toFixed(0)} ms (max {perfStats.deviceLagMaxMs.toFixed(0)})</span>
              <span>pipeline {perfStats.pipelineMs.toFixed(1)} ms</span>
              <span>decode {perfStats.decodeFps} fps · {perfStats.decodeMs.toFixed(1)} ms</span>
              <span>{perfStats.packetsPerSec} pkt/s · {(perfStats.bitrateKbps / 1000).toFixed(2)} Mbps</span>
              <span>dropped {perfStats.dropped} · queue {perfStats.decodeQueue}</span>
              <span>{perfStats.width}×{perfStats.height} · {perfStats.codec}</span>
            </div>
          )}

          {adaptiveInfo?.enabled && (
            <div className="absolute top-2 left-2 h-5 flex items-center px-2 bg-popover/80 border border-border backdrop-blur-lg rounded-full text-text-2 font-mono tabular-nums text-[10px] z-5 pointer-events-none">
              {adaptiveInfo.tierName} &middot; {adaptiveInfo.fps} fps &middot; {adaptiveInfo.lagMs} ms
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
