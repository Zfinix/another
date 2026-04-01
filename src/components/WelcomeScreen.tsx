import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  DevicePhoneMobileIcon,
  Cog6ToothIcon,
  ArrowPathIcon,
  ChevronRightIcon,
  SunIcon,
  MoonIcon,
  SignalIcon,
  ComputerDesktopIcon,
  WifiIcon,
} from "@heroicons/react/24/outline";
import {
  Dialog,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Device, ThemePreference } from "../types";
import { getDeviceDisplayName, getDeviceNickname, setDeviceNickname } from "../types";
import appIcon from "../assets/icon.png";

interface WelcomeScreenProps {
  devices: Device[];
  connectingSerial: string | null;
  themePref: ThemePreference;
  onCycleTheme: () => void;
  onOpenSettings: () => void;
  onRefreshDevices: () => void;
  onConnectDevice: (device: Device) => void;
  showToast: (msg: string, type?: "error" | "info") => void;
}

function truncateSerial(s: string) {
  return s.length > 16 ? s.slice(0, 6) + "..." + s.slice(-4) : s;
}

function isWifiDevice(serial: string) {
  return serial.includes(":");
}

export function WelcomeScreen({
  devices,
  connectingSerial,
  themePref,
  onCycleTheme,
  onOpenSettings,
  onRefreshDevices,
  onConnectDevice,
  showToast,
}: WelcomeScreenProps) {
  const [showWifiDialog, setShowWifiDialog] = useState(false);
  const [wifiAddress, setWifiAddress] = useState("");
  const [wifiConnecting, setWifiConnecting] = useState(false);
  const [togglingSerial, setTogglingSerial] = useState<string | null>(null);
  const [editingSerial, setEditingSerial] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; device: Device } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent, device: Device) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, device });
  };

  const handleWifiConnect = async () => {
    if (!wifiAddress.trim()) return;
    setWifiConnecting(true);
    try {
      const addr = wifiAddress.includes(":") ? wifiAddress : `${wifiAddress}:5555`;
      await invoke("wifi_connect", { address: addr });
      showToast("Device connected via WiFi", "info");
      setWifiAddress("");
      setShowWifiDialog(false);
      onRefreshDevices();
    } catch (e) {
      showToast(`Connection failed: ${e}`);
    } finally {
      setWifiConnecting(false);
    }
  };

  const handleToggleWifi = async (e: React.MouseEvent, device: Device) => {
    e.stopPropagation();
    setTogglingSerial(device.serial);
    try {
      if (isWifiDevice(device.serial)) {
        await invoke("wifi_disconnect", { address: device.serial });
        showToast(`${getDeviceDisplayName(device)} WiFi disconnected`, "info");
      } else if (device.wifi_available) {
        const ip = await invoke<string | null>("get_device_ip", { serial: device.serial });
        if (ip) {
          await invoke("wifi_disconnect", { address: `${ip}:5555` });
          showToast(`${getDeviceDisplayName(device)} WiFi disconnected`, "info");
        }
      } else {
        const addr = await invoke<string>("wifi_enable", { serial: device.serial });
        showToast(`${getDeviceDisplayName(device)} now available at ${addr}`, "info");
      }
      onRefreshDevices();
    } catch (e) {
      showToast(`${e}`);
    } finally {
      setTogglingSerial(null);
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-background relative animate-in fade-in duration-600 pt-[38px]">
      <div className="absolute top-0 left-0 right-0 h-[38px] drag-region bg-surface border-b border-border flex items-center justify-end" data-tauri-drag-region>
        <div className="flex items-center gap-0.5 pr-2.5 no-drag">
          <Button variant="ghost" size="icon-xs" className="text-text-3 [&_svg]:size-[15px]" onClick={onCycleTheme} title={themePref === "light" ? "Light" : themePref === "dark" ? "Dark" : "System"}>
            {themePref === "light" ? <SunIcon /> : themePref === "dark" ? <MoonIcon /> : <ComputerDesktopIcon />}
          </Button>
          <Button variant="ghost" size="icon-xs" className="text-text-3 [&_svg]:size-[15px]" onClick={() => setShowWifiDialog(true)} title="Connect via WiFi">
            <WifiIcon />
          </Button>
          <Button variant="ghost" size="icon-xs" className="text-text-3 [&_svg]:size-[15px]" onClick={onOpenSettings} title="Settings">
            <Cog6ToothIcon />
          </Button>
        </div>
      </div>

      <div className="flex flex-col items-center gap-3 mb-2">
        <img src={appIcon} alt="Another" className="size-16 rounded-2xl" />
        <h1 className="text-[28px] font-bold tracking-tight">Another</h1>
      </div>
      <p className="text-sm text-text-2 mb-10">Android screen mirroring and control</p>

      <div className="w-[360px] max-w-[90vw]">
        <div className="flex items-center justify-between mb-1.5 px-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-text-3">
            {devices.length > 0 ? `${devices.length} device${devices.length > 1 ? "s" : ""} found` : "Searching..."}
          </span>
          <Button variant="ghost" size="xs" className="text-text-3 text-[10px] gap-[3px] [&_svg]:size-2.5" onClick={onRefreshDevices}>
            <ArrowPathIcon /> Refresh
          </Button>
        </div>

        {devices.length === 0 ? (
          <div className="text-center py-8 px-5 bg-surface border border-dashed border-border rounded-xl flex flex-col items-center">
            <SignalIcon className="size-8 text-text-3 mb-3 opacity-50" />
            <p className="text-xs text-text-3 leading-relaxed">No devices detected.<br />Connect your Android via USB and enable USB debugging.</p>
          </div>
        ) : (
          devices.map((d) => (
            <div
              key={d.serial}
              className="bg-transparent border-none rounded-lg py-2.5 px-2 mb-0.5 cursor-pointer transition-all duration-200 flex items-center gap-2.5 hover:opacity-60"
              onClick={() => !connectingSerial && onConnectDevice(d)}
              onContextMenu={(e) => handleContextMenu(e, d)}
            >
              <div className="size-[30px] rounded-[7px] bg-surface-2 flex items-center justify-center text-text-2 shrink-0 [&_svg]:size-[15px]">
                <DevicePhoneMobileIcon />
              </div>
              <div className="flex-1 min-w-0">
                {editingSerial === d.serial ? (
                  <input
                    className="text-[13px] font-semibold leading-tight bg-surface-2 border border-brand rounded w-full text-foreground py-px px-1 outline-none"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => { setDeviceNickname(d.serial, editValue); setEditingSerial(null); }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") { setDeviceNickname(d.serial, editValue); setEditingSerial(null); }
                      if (e.key === "Escape") setEditingSerial(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                  />
                ) : (
                  <div
                    className="text-[13px] font-semibold leading-tight truncate cursor-default"
                    onDoubleClick={(e) => { e.stopPropagation(); setEditingSerial(d.serial); setEditValue(getDeviceDisplayName(d)); }}
                    title="Double-click to rename"
                  >
                    {getDeviceDisplayName(d)}
                  </div>
                )}
                <div className="text-[10px] font-mono text-text-3 leading-tight truncate">
                  {truncateSerial(d.serial)}
                </div>
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                {connectingSerial === d.serial ? (
                  <div className="size-4 border-2 border-border border-t-brand rounded-full animate-spin" />
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      className={cn(
                        "flex items-center justify-center size-7 border-transparent bg-transparent text-text-3 rounded-md opacity-40 transition-all duration-150 [&_svg]:size-[15px] shadow-none",
                        (isWifiDevice(d.serial) || d.wifi_available) && "opacity-100 text-brand drop-shadow-[0_0_4px_var(--brand-glow-strong)]",
                        "hover:opacity-100 hover:bg-surface-2",
                        "disabled:opacity-30 disabled:cursor-not-allowed"
                      )}
                      title={isWifiDevice(d.serial) ? "Disable WiFi" : "Enable WiFi"}
                      onClick={(e) => handleToggleWifi(e, d)}
                      disabled={togglingSerial === d.serial}
                    >
                      {togglingSerial === d.serial ? <div className="size-3.5 border-2 border-border border-t-brand rounded-full animate-spin" /> : <WifiIcon />}
                    </Button>
                    <ChevronRightIcon className="size-3.5 text-text-3" />
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-100 min-w-40 bg-surface border border-border rounded-lg p-1 shadow-[0_8px_24px_rgba(0,0,0,0.3)] animate-in fade-in duration-100"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <Button variant="ghost" className="block w-full h-auto justify-start py-1.5 px-2.5 text-xs font-normal text-foreground bg-transparent border-transparent rounded-[5px] shadow-none hover:bg-surface-hover" onClick={() => {
            onConnectDevice(contextMenu.device);
            setContextMenu(null);
          }}>
            Connect
          </Button>
          <Button variant="ghost" className="block w-full h-auto justify-start py-1.5 px-2.5 text-xs font-normal text-foreground bg-transparent border-transparent rounded-[5px] shadow-none hover:bg-surface-hover" onClick={() => {
            setEditingSerial(contextMenu.device.serial);
            setEditValue(getDeviceDisplayName(contextMenu.device));
            setContextMenu(null);
          }}>
            Rename
          </Button>
          {getDeviceNickname(contextMenu.device.serial) && (
            <Button variant="ghost" className="block w-full h-auto justify-start py-1.5 px-2.5 text-xs font-normal text-foreground bg-transparent border-transparent rounded-[5px] shadow-none hover:bg-surface-hover" onClick={() => {
              setDeviceNickname(contextMenu.device.serial, "");
              setContextMenu(null);
            }}>
              Reset Name
            </Button>
          )}
          <Button variant="ghost" className="block w-full h-auto justify-start py-1.5 px-2.5 text-xs font-normal text-foreground bg-transparent border-transparent rounded-[5px] shadow-none hover:bg-surface-hover" onClick={() => {
            handleToggleWifi({ stopPropagation: () => {} } as React.MouseEvent, contextMenu.device);
            setContextMenu(null);
          }}>
            {isWifiDevice(contextMenu.device.serial) ? "Disable WiFi" : "Enable WiFi"}
          </Button>
          <div className="h-px bg-border mx-1.5 my-1" />
          <Button variant="ghost" className="block w-full h-auto justify-start py-1.5 px-2.5 text-xs font-normal text-foreground bg-transparent border-transparent rounded-[5px] shadow-none hover:bg-surface-hover" onClick={() => {
            navigator.clipboard.writeText(contextMenu.device.serial);
            showToast("Serial copied", "info");
            setContextMenu(null);
          }}>
            Copy Serial
          </Button>
        </div>
      )}

      <span className="absolute bottom-3 text-[9px] text-text-3/50">v0.3.0</span>

      <Dialog open={showWifiDialog} onOpenChange={setShowWifiDialog}>
        <DialogPortal>
          <DialogOverlay />
          <DialogPrimitive.Popup className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[340px] max-w-[90vw] bg-surface border border-border rounded-[14px] z-50 shadow-lg animate-in fade-in zoom-in-95 duration-100">
            <DialogTitle className="text-[15px] font-semibold px-5 pt-5">Connect by IP</DialogTitle>
            <div className="px-5 py-4">
              <p className="text-xs text-muted-foreground leading-relaxed mb-3">
                On your Android device, go to <strong className="text-foreground">Settings &gt; About phone &gt; Status</strong> to find your IP address. Both devices must be on the same network.
              </p>
              <div className="flex gap-2">
                <input
                  className="flex-1 min-w-0 py-2 px-2.5 bg-surface-2 border border-border rounded-lg text-[13px] text-foreground outline-none focus:border-brand placeholder:text-text-3"
                  type="text"
                  placeholder="192.168.1.100"
                  value={wifiAddress}
                  onChange={(e) => setWifiAddress(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleWifiConnect()}
                  autoFocus
                />
                <Button
                  className="shrink-0"
                  onClick={handleWifiConnect}
                  disabled={wifiConnecting || !wifiAddress.trim()}
                >
                  {wifiConnecting ? <div className="size-3.5 border-2 border-border border-t-brand rounded-full animate-spin" /> : "Connect"}
                </Button>
              </div>
            </div>
          </DialogPrimitive.Popup>
        </DialogPortal>
      </Dialog>
    </div>
  );
}
