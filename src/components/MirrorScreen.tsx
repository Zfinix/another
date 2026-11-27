import { useState, useEffect } from "react";
import type React from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "@/components/Icon";
import { Menu, MenuPopup, MenuItem, MenuSeparator, MenuSubmenu } from "@/components/ui/menu";
import { StartingState, type StartStep } from "@/components/StateViews";
import type { IconName } from "@/lib/icons";
import type { PerfStats, QuickActionId } from "../types";
import { QUICK_ACTION_ORDER } from "../types";

interface QuickAction {
  label: string;
  icon: IconName;
  keys: string;
  on?: boolean;
  run: () => void;
}

export interface ReconnectingInfo {
  message: string;
  action?: { label: string; run: () => void };
}

interface MirrorScreenProps {
  name: string;
  brand: string;
  path: string;
  streamReady: boolean;
  steps: StartStep[];
  deviceSize: { width: number; height: number };
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  isMouseDownRef: React.MutableRefObject<boolean>;
  nativeVideo: boolean;
  latencyMs: number | null;
  perfStats: PerfStats | null;
  statsOn: boolean;
  recording: boolean;
  muted: boolean;
  macroRecording: boolean;
  pins: QuickActionId[];
  onTogglePin: (id: QuickActionId) => void;
  macros: string[];
  onRunMacro: (name: string) => void;
  reconnecting: ReconnectingInfo | null;
  adaptive: { tier: string; fps: number; lagMs: number } | null;
  alwaysOnTop: boolean;
  onToggleAlwaysOnTop: () => void;
  onOpenSettings: () => void;
  onToggleStats: () => void;
  onToggleRecording: () => void;
  onToggleMacroRecording: () => void;
  onToggleMute: () => void;
  onScreenshot: () => void;
  onRotate: () => void;
  onPressButton: (button: string) => void;
  onOpenCommandBar: () => void;
  onDisconnect: () => void;
  onCanvasMouseEvent: (e: React.MouseEvent<HTMLCanvasElement>, action: string) => void;
  onWheel: (e: React.WheelEvent<HTMLCanvasElement>) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (e: React.CompositionEvent) => void;
}

function useElapsed(running: boolean) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    if (!running) return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function RailButton({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button type="button" className="icon-button" style={{ width: 32, height: 32 }} aria-label={label} title={label} onClick={onClick}>
      <Icon name={icon} />
    </button>
  );
}

const RAIL_GAP = <span aria-hidden="true" style={{ width: 16, height: 1, margin: "4px 0", background: "var(--border)" }} />;

export function MirrorScreen(props: MirrorScreenProps) {
  const { name, streamReady, deviceSize, canvasRef, isMouseDownRef, nativeVideo, latencyMs, perfStats, statsOn, recording, muted, macroRecording, pins } = props;
  const [moreOpen, setMoreOpen] = useState(false);
  const recordTime = useElapsed(recording);
  const macroTime = useElapsed(macroRecording);
  const landscape = deviceSize.width > deviceSize.height;

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

  const actions: Record<QuickActionId, QuickAction> = {
    screenshot: { label: "Take a screenshot", icon: "shot", keys: "⇧⌘S", run: props.onScreenshot },
    record: { label: recording ? "Stop recording" : "Start recording", icon: recording ? "recDot" : "record", keys: "⇧⌘R", on: recording, run: props.onToggleRecording },
    stats: { label: statsOn ? "Hide stream stats" : "Show stream stats", icon: statsOn ? "statsOn" : "stats", keys: "⌘I", on: statsOn, run: props.onToggleStats },
    mute: { label: muted ? "Unmute the phone" : "Mute the phone", icon: muted ? "speakerMute" : "mute", keys: "⌘M", on: muted, run: props.onToggleMute },
    rotate: { label: "Rotate", icon: "rotate", keys: "⌘R", run: props.onRotate },
  };

  const pinned = QUICK_ACTION_ORDER.filter((id) => pins.includes(id));

  return (
    <div className={`app-window flex-col ${nativeVideo ? "native" : ""}`}>
      <div className="drag relative z-10 flex items-center gap-1 shrink-0" style={{ height: 36 }} data-tauri-drag-region>
        <div className="flex-1 min-w-0 flex items-center gap-2" style={{ paddingLeft: 96 }} data-tauri-drag-region>
          <span className="truncate" style={{ fontWeight: 500 }} data-tauri-drag-region>{name}</span>
          {streamReady && latencyMs !== null && (
            <span className="mono shrink-0" style={{ color: "var(--muted)" }} title="Capture to screen latency">{Math.round(latencyMs)} ms</span>
          )}
          {props.adaptive && streamReady && (
            <span className="mono shrink-0 truncate" style={{ color: "var(--muted)" }} title="Adaptive quality">{props.adaptive.tier}</span>
          )}
          {recording && (
            <span className="mono inline-flex items-center gap-2 shrink-0" style={{ color: "var(--rec)" }}>
              <span className="dot" style={{ background: "currentColor" }} />{recordTime}
            </span>
          )}
        </div>
        {pinned.map((id) => {
          const a = actions[id];
          return (
            <button key={id} type="button" className={a.on && id === "stats" ? "icon-button on" : "icon-button"} aria-label={a.label} title={`${a.label} (${a.keys})`} style={id === "record" && recording ? { color: "var(--rec)" } : undefined} onClick={a.run}>
              <Icon name={a.icon} />
            </button>
          );
        })}
        <Menu.Root open={moreOpen} onOpenChange={setMoreOpen}>
          <Menu.Trigger className={moreOpen ? "icon-button on" : "icon-button"} aria-label="More actions" title="More actions">
            <Icon name="more" />
          </Menu.Trigger>
          <MenuPopup width={280} align="end">
            {QUICK_ACTION_ORDER.map((id) => {
              const a = actions[id];
              const isPinned = pins.includes(id);
              return (
                <MenuItem
                  key={id}
                  icon={a.icon}
                  label={a.label}
                  keys={a.keys}
                  closeOnClick={false}
                  onClick={() => {
                    setMoreOpen(false);
                    a.run();
                  }}
                  trailing={
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={isPinned ? "Unpin from the toolbar" : "Pin to the toolbar"}
                      title={isPinned ? "Unpin from the toolbar" : "Pin to the toolbar"}
                      className="flex"
                      style={{ color: isPinned ? "var(--foreground)" : "var(--muted)", cursor: "pointer" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onTogglePin(id);
                      }}
                    >
                      <Icon name={isPinned ? "pinOn" : "pin"} />
                    </span>
                  }
                />
              );
            })}
            <MenuSeparator />
            <MenuSubmenu icon="wand" label="Run a macro" disabled={props.macros.length === 0}>
              {props.macros.map((m) => (
                <MenuItem key={m} icon="play" label={m} onClick={() => props.onRunMacro(m)} />
              ))}
            </MenuSubmenu>
            <MenuItem icon="wand" label={macroRecording ? "Stop recording the macro" : "Record a macro"} keys="⇧⌘M" onClick={props.onToggleMacroRecording} />
            <MenuItem icon="search" label="Command bar" keys="⌘K" onClick={props.onOpenCommandBar} />
            <MenuItem icon={props.alwaysOnTop ? "pinOn" : "pin"} label={props.alwaysOnTop ? "Stop keeping on top" : "Keep on top"} keys="⇧⌘T" onClick={props.onToggleAlwaysOnTop} />
            <MenuItem icon="settings" label="Settings" keys="⌘," onClick={props.onOpenSettings} />
            <MenuSeparator />
            <MenuItem icon="unplug" label="Disconnect" keys="⌘D" danger onClick={props.onDisconnect} />
          </MenuPopup>
        </Menu.Root>
      </div>

      <div className="flex-1 min-h-0 flex gap-2">
        <div
          className={`relative flex-1 min-w-0 flex items-center justify-center overflow-hidden outline-none ${nativeVideo ? "native-video-frame" : ""}`}
          style={{ borderRadius: 12, background: nativeVideo ? undefined : "#0a0a0b" }}
          tabIndex={0}
          onKeyDown={props.onKeyDown}
          onCompositionStart={props.onCompositionStart}
          onCompositionEnd={props.onCompositionEnd}
        >
          <canvas
            ref={canvasRef}
            width={deviceSize.width}
            height={deviceSize.height}
            className={`max-w-full max-h-full object-contain cursor-default block transition-opacity duration-300 ${nativeVideo ? "native-video-hole" : streamReady ? "opacity-100" : "opacity-0"}`}
            onMouseDown={(e) => { isMouseDownRef.current = true; props.onCanvasMouseEvent(e, "down"); }}
            onMouseMove={(e) => { if (isMouseDownRef.current) props.onCanvasMouseEvent(e, "move"); }}
            onMouseUp={(e) => { isMouseDownRef.current = false; props.onCanvasMouseEvent(e, "up"); }}
            onMouseLeave={(e) => { if (isMouseDownRef.current) { isMouseDownRef.current = false; props.onCanvasMouseEvent(e, "up"); } }}
            onWheel={props.onWheel}
            onContextMenu={(e) => e.preventDefault()}
          />

          {!streamReady && (
            <div className="t-dark absolute inset-0 flex items-center justify-center p-6" style={{ background: "radial-gradient(120% 70% at 20% 10%, #2b2e35 0%, #17181b 55%, #101012 100%)", color: "var(--foreground)" }}>
              <StartingState name={name} brand={props.brand} path={props.path} steps={props.steps} />
            </div>
          )}

          {statsOn && perfStats && (
            <div className="glass mono t-dark absolute pointer-events-none" style={{ top: 8, left: 8, padding: "8px 12px", borderRadius: 16, color: "#fcfcfc", lineHeight: "20px", display: "grid", gridTemplateColumns: "auto auto", columnGap: 16 }}>
              <span style={{ color: "#9f9fa9" }}>fps</span><span className="text-right">{perfStats.renderFps}</span>
              <span style={{ color: "#9f9fa9" }}>latency</span><span className="text-right">{perfStats.screenMs > 0 ? `${perfStats.screenMs.toFixed(0)} ms` : `${perfStats.deviceLagMs.toFixed(0)} ms`}</span>
              <span style={{ color: "#9f9fa9" }}>decode</span><span className="text-right">{perfStats.decodeMs.toFixed(1)} ms</span>
              <span style={{ color: "#9f9fa9" }}>bitrate</span><span className="text-right">{(perfStats.bitrateKbps / 1000).toFixed(1)} Mbps</span>
              <span style={{ color: "#9f9fa9" }}>device lag</span><span className="text-right">{perfStats.deviceLagMs.toFixed(0)} ms</span>
              <span style={{ color: "#9f9fa9" }}>dropped</span><span className="text-right">{perfStats.dropped}</span>
              {perfStats.width > 0 && <><span style={{ color: "#9f9fa9" }}>size</span><span className="text-right">{perfStats.width}×{perfStats.height} {perfStats.codec}</span></>}
              {props.adaptive && <><span style={{ color: "#9f9fa9" }}>adaptive</span><span className="text-right">{props.adaptive.tier}</span></>}
            </div>
          )}

          {props.reconnecting && (
            <>
              <div className="absolute inset-0 pointer-events-none" style={{ background: "rgba(0,0,0,.35)", backdropFilter: "grayscale(1)", WebkitBackdropFilter: "grayscale(1)" }} />
              <div className="glass toast t-dark absolute" style={{ left: 12, right: 12, bottom: 12, color: "#fcfcfc" }}>
                <span className="spinner" />
                <span className="flex-1 min-w-0">{props.reconnecting.message}</span>
                {props.reconnecting.action && <button type="button" className="button button--secondary" onClick={props.reconnecting.action.run}>{props.reconnecting.action.label}</button>}
              </div>
            </>
          )}

          {macroRecording && !props.reconnecting && (
            <div className="glass toast t-dark absolute" style={{ left: 12, right: 12, bottom: 12, color: "#fcfcfc" }}>
              <span className="dot" style={{ width: 8, height: 8, margin: "0 6px", background: "var(--rec)" }} />
              <span className="flex-1 min-w-0">Recording a macro <span style={{ fontVariantNumeric: "tabular-nums", color: "#9f9fa9" }}>{macroTime}</span></span>
              <button type="button" className="button button--secondary" onClick={props.onToggleMacroRecording}>Stop</button>
            </div>
          )}
        </div>

        <div className="relative z-10 flex flex-col items-center gap-1 shrink-0" style={{ width: 32 }}>
          <RailButton icon="backOn" label="Back" onClick={() => props.onPressButton("back")} />
          <RailButton icon="homeOn" label="Home" onClick={() => props.onPressButton("home")} />
          <RailButton icon="recentsOn" label="Recent apps" onClick={() => props.onPressButton("recents")} />
          {!landscape && (
            <>
              {RAIL_GAP}
              <RailButton icon="volumeUp" label="Volume up" onClick={() => props.onPressButton("volume_up")} />
              <RailButton icon="volumeDown" label="Volume down" onClick={() => props.onPressButton("volume_down")} />
              <RailButton icon="powerOn" label="Power" onClick={() => props.onPressButton("power")} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
