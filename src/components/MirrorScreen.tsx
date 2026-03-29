import type React from "react";
import {
  Cog6ToothIcon,
  CameraIcon,
  ChevronLeftIcon,
  XMarkIcon,
  HomeIcon,
  Square2StackIcon,
  CommandLineIcon,
} from "@heroicons/react/24/outline";
import type { Device } from "../types";

interface MirrorScreenProps {
  connectedDevice: Device;
  connecting?: boolean;
  deviceSize: { width: number; height: number };
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  isMouseDown: React.MutableRefObject<boolean>;
  onPressButton: (button: string) => void;
  onTakeScreenshot: () => void;
  onToggleSettings: () => void;
  onOpenCommandBar: () => void;
  onDisconnect: () => void;
  onCanvasMouseEvent: (e: React.MouseEvent<HTMLCanvasElement>, action: string) => void;
  onWheel: (e: React.WheelEvent<HTMLCanvasElement>) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export function MirrorScreen({
  connectedDevice,
  connecting,
  deviceSize,
  canvasRef,
  isMouseDown,
  onPressButton,
  onTakeScreenshot,
  onToggleSettings,
  onOpenCommandBar,
  onDisconnect,
  onCanvasMouseEvent,
  onWheel,
  onKeyDown,
}: MirrorScreenProps) {
  return (
    <div className="another">
      <div className="titlebar" data-tauri-drag-region>
        <div className="titlebar-info" data-tauri-drag-region>
          <span className="titlebar-device">{connectedDevice.model}</span>
          <span className="titlebar-os">Android</span>
        </div>

        <div className="titlebar-group">
          <button className="titlebar-btn" onClick={() => onPressButton("back")} title="Back">
            <ChevronLeftIcon />
          </button>
          <button className="titlebar-btn" onClick={() => onPressButton("home")} title="Home">
            <HomeIcon />
          </button>
          <button className="titlebar-btn" onClick={() => onPressButton("recents")} title="Recents">
            <Square2StackIcon />
          </button>
        </div>

        <div className="titlebar-group">
          <button className="titlebar-btn" onClick={onOpenCommandBar} title="Commands (⌘K)">
            <CommandLineIcon />
          </button>
          <button className="titlebar-btn" onClick={onTakeScreenshot} title="Screenshot">
            <CameraIcon />
          </button>
          <button className="titlebar-btn" onClick={onToggleSettings} title="Settings">
            <Cog6ToothIcon />
          </button>
          <button className="titlebar-btn" onClick={onDisconnect} title="Disconnect">
            <XMarkIcon />
          </button>
        </div>
      </div>

      <div className="viewport" tabIndex={0} onKeyDown={onKeyDown}>
        {connecting ? (
          <div className="viewport-loading">
            <div className="spinner" />
            <p>Connecting...</p>
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            width={deviceSize.width}
            height={deviceSize.height}
            onMouseDown={(e) => { isMouseDown.current = true; onCanvasMouseEvent(e, "down"); }}
            onMouseMove={(e) => { if (isMouseDown.current) onCanvasMouseEvent(e, "move"); }}
            onMouseUp={(e) => { isMouseDown.current = false; onCanvasMouseEvent(e, "up"); }}
            onMouseLeave={(e) => { if (isMouseDown.current) { isMouseDown.current = false; onCanvasMouseEvent(e, "up"); } }}
            onWheel={onWheel}
            onContextMenu={(e) => e.preventDefault()}
          />
        )}
      </div>
    </div>
  );
}
