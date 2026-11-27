import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import {
  DevicePhoneMobileIcon,
  Cog6ToothIcon,
  ArrowPathIcon,
  ChevronRightIcon,
  SunIcon,
  MoonIcon,
  ComputerDesktopIcon,
  WifiIcon,
  GlobeAltIcon,
} from "@heroicons/react/24/outline";
import {
  Dialog,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Button } from "@/components/ui/button";
import { cn, isNetworkSerial } from "@/lib/utils";
import type { Device, TailnetPeer, TailnetStatus, ThemePreference } from "../types";
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

const TAILNET_POLL_MS = 15000;

function tailnetPath(peer: TailnetPeer) {
  if (!peer.online) return "Offline";
  if (peer.direct) return "Tailnet · direct";
  return peer.relay ? `Tailnet · relayed via ${peer.relay}` : "Tailnet · relayed";
}

function truncateSerial(s: string) {
  return s.length > 16 ? s.slice(0, 6) + "..." + s.slice(-4) : s;
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
  const [refreshSpin, setRefreshSpin] = useState(0);
  const [version, setVersion] = useState<string | null>(null);
  const [tailnet, setTailnet] = useState<TailnetStatus | null>(null);
  const [tailnetConnecting, setTailnetConnecting] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => { });
  }, []);

  const refreshTailnet = () => {
    invoke<TailnetStatus>("tailnet_status").then(setTailnet).catch(() => setTailnet(null));
  };

  useEffect(() => {
    refreshTailnet();
    const timer = setInterval(refreshTailnet, TAILNET_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const tailnetPeers = tailnet?.running
    ? tailnet.peers.filter((peer) => !devices.some((d) => d.serial === peer.address))
    : [];

  const handleTailnetConnect = async (peer: TailnetPeer) => {
    if (!peer.online || connectingSerial || tailnetConnecting) return;
    setTailnetConnecting(peer.address);
    try {
      await invoke("wifi_connect", { address: peer.address });
      onRefreshDevices();
      onConnectDevice({ serial: peer.address, model: peer.name, state: "device" });
    } catch {
      showToast(`Could not reach ${peer.name} over the tailnet. Connect it by USB once and turn on Wi-Fi debugging, then try again.`);
    } finally {
      setTailnetConnecting(null);
    }
  };

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
      if (isNetworkSerial(device.serial)) {
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

  const menuItemClass = "flex w-full h-7 items-center justify-start px-2.5 text-[12.5px] font-normal text-foreground bg-transparent border-transparent rounded-md shadow-none hover:bg-surface-2 dark:hover:bg-surface-2";
  const chromeBtnClass = "size-7 rounded-md text-text-2 hover:bg-transparent dark:hover:bg-transparent hover:text-foreground press [&_svg]:size-4";

  const handleRefresh = () => {
    setRefreshSpin((n) => n + 1);
    onRefreshDevices();
    refreshTailnet();
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-background animate-in fade-in duration-300">
      <header className="h-10 shrink-0 flex items-center justify-end pr-2 drag-region" data-tauri-drag-region>
        <div className="flex items-center gap-0.5 no-drag">
          <Button variant="ghost" size="icon-sm" className={chromeBtnClass} onClick={onCycleTheme} title={themePref === "light" ? "Theme: Light" : themePref === "dark" ? "Theme: Dark" : "Theme: System"}>
            {themePref === "light" ? <SunIcon /> : themePref === "dark" ? <MoonIcon /> : <ComputerDesktopIcon />}
          </Button>
          <Button variant="ghost" size="icon-sm" className={chromeBtnClass} onClick={onOpenSettings} title="Settings">
            <Cog6ToothIcon />
          </Button>
        </div>
      </header>

      <main className="mx-2 mb-2 flex-1 min-h-0 flex flex-col rounded-[14px] bg-surface border border-border overflow-hidden">
        <div className="px-5 pt-7 pb-6 animate-in fade-in slide-in-from-bottom-1 duration-500">
          <img src={appIcon} alt="" className="size-11 rounded-[11px]" draggable={false} />
          <h1 className="mt-4 text-[22px] leading-tight font-semibold tracking-[-0.02em]">Another</h1>
          <p className="mt-1 text-[13px] leading-normal text-text-2">Mirror and control your Android from your desktop.</p>
        </div>

        <section className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center justify-between px-5 h-8 shrink-0">
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-3">
              {devices.length > 0 ? `Devices · ${devices.length}` : "Looking for devices"}
            </span>
            <Button variant="ghost" size="icon-xs" className="size-6 rounded-md text-text-3 hover:bg-transparent dark:hover:bg-transparent hover:text-foreground press [&_svg]:size-3.5" onClick={handleRefresh} title="Refresh">
              <ArrowPathIcon key={refreshSpin} className={refreshSpin ? "motion-safe:animate-[spin_600ms_cubic-bezier(0.23,1,0.32,1)_1]" : ""} />
            </Button>
          </div>
          <div className={cn("relative h-px mx-5 shrink-0 bg-border overflow-hidden", devices.length === 0 && "scan-bar")} />

          {devices.length === 0 ? (
            <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-5 py-5 animate-in fade-in duration-300">
              <p className="text-[13px] font-medium">No phone connected</p>
              <ol className="mt-3 flex flex-col gap-2.5">
                {[
                  "Plug your phone in with a USB cable.",
                  "Turn on USB debugging in Developer options.",
                  "Tap Allow when your phone asks to trust this computer.",
                ].map((step, i) => (
                  <li key={step} className="flex gap-2.5 text-[12px] leading-[1.5] text-text-2">
                    <span className="mt-px size-[18px] shrink-0 rounded-full border border-border flex items-center justify-center font-mono text-[10px] text-text-3">{i + 1}</span>
                    <span className="min-w-0">{step}</span>
                  </li>
                ))}
              </ol>
              <Button variant="outline" size="sm" className="mt-5 h-8 rounded-lg px-3 text-[12.5px] gap-1.5 border-input press [&_svg]:size-3.5" onClick={() => setShowWifiDialog(true)}>
                <WifiIcon /> Connect by IP
              </Button>
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-2 py-1.5">
              {devices.map((d, i) => {
                const isConnecting = connectingSerial === d.serial;
                const wifiOn = isNetworkSerial(d.serial) || !!d.wifi_available;
                return (
                  <div
                    key={d.serial}
                    role="button"
                    tabIndex={0}
                    style={{ animationDelay: `${i * 40}ms` }}
                    className={cn(
                      "group h-[52px] px-3 rounded-[10px] flex items-center gap-3 cursor-default outline-none press animate-in fade-in slide-in-from-bottom-1 duration-300 fill-mode-both",
                      "focus-visible:bg-surface-2",
                      isConnecting ? "bg-surface-2" : !connectingSerial && "hover-dim",
                      connectingSerial && !isConnecting && "opacity-50",
                    )}
                    onClick={() => !connectingSerial && onConnectDevice(d)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !connectingSerial) onConnectDevice(d); }}
                    onContextMenu={(e) => handleContextMenu(e, d)}
                  >
                    <div className="size-8 rounded-lg bg-surface-2 border border-border flex items-center justify-center text-text-2 shrink-0 [&_svg]:size-4">
                      <DevicePhoneMobileIcon />
                    </div>
                    <div className="flex-1 min-w-0">
                      {editingSerial === d.serial ? (
                        <input
                          className="text-[13px] font-medium leading-tight bg-surface-2 border border-input focus:border-brand rounded-md w-full text-foreground py-0.5 px-1.5 outline-none"
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
                          className="text-[13px] font-medium leading-tight truncate"
                          onDoubleClick={(e) => { e.stopPropagation(); setEditingSerial(d.serial); setEditValue(getDeviceDisplayName(d)); }}
                          title="Double-click to rename"
                        >
                          {getDeviceDisplayName(d)}
                        </div>
                      )}
                      <div className="mt-0.5 text-[11px] leading-tight truncate text-text-3">
                        {isConnecting ? "Starting stream..." : <>{isNetworkSerial(d.serial) ? "Wi-Fi" : "USB"} · <span className="font-mono">{truncateSerial(d.serial)}</span></>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {isConnecting ? (
                        <div className="size-4 border-[1.5px] border-border border-t-brand rounded-full animate-spin" />
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            className={cn(
                              "size-7 p-0 rounded-md border-transparent bg-transparent shadow-none press [&_svg]:size-[15px]",
                              "hover:bg-transparent dark:hover:bg-transparent hover:text-foreground",
                              wifiOn ? "text-brand hover:text-brand" : "text-text-3",
                            )}
                            title={wifiOn ? "Turn off Wi-Fi debugging" : "Turn on Wi-Fi debugging"}
                            onClick={(e) => handleToggleWifi(e, d)}
                            disabled={togglingSerial === d.serial}
                          >
                            {togglingSerial === d.serial ? <div className="size-3.5 border-[1.5px] border-border border-t-brand rounded-full animate-spin" /> : <WifiIcon />}
                          </Button>
                          <ChevronRightIcon className="size-3.5 text-text-3" />
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {tailnetPeers.length > 0 && (
            <div className="shrink-0 max-h-[180px] flex flex-col animate-in fade-in duration-300">
              <div className="flex items-center px-5 h-8 shrink-0 border-t border-border">
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-3">
                  Tailnet · {tailnetPeers.length}
                </span>
              </div>
              <div className="min-h-0 overflow-y-auto no-scrollbar px-2 pb-1.5">
                {tailnetPeers.map((peer) => {
                  const isConnecting = tailnetConnecting === peer.address || connectingSerial === peer.address;
                  return (
                    <div
                      key={peer.address}
                      role="button"
                      tabIndex={0}
                      title={peer.dns_name || peer.address}
                      className={cn(
                        "group h-[52px] px-3 rounded-[10px] flex items-center gap-3 cursor-default outline-none press",
                        "focus-visible:bg-surface-2",
                        isConnecting ? "bg-surface-2" : peer.online && !connectingSerial && "hover-dim",
                        !peer.online && "opacity-50",
                      )}
                      onClick={() => handleTailnetConnect(peer)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleTailnetConnect(peer); }}
                    >
                      <div className="size-8 rounded-lg bg-surface-2 border border-border flex items-center justify-center text-text-2 shrink-0 [&_svg]:size-4">
                        <GlobeAltIcon />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium leading-tight truncate">{peer.name}</div>
                        <div className="mt-0.5 text-[11px] leading-tight truncate text-text-3">
                          {isConnecting ? "Connecting..." : tailnetPath(peer)}
                        </div>
                      </div>
                      {isConnecting ? (
                        <div className="size-4 border-[1.5px] border-border border-t-brand rounded-full animate-spin" />
                      ) : (
                        peer.online && <ChevronRightIcon className="size-3.5 text-text-3" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        <footer className="h-11 shrink-0 border-t border-border px-3 flex items-center justify-between">
          {devices.length > 0 ? <Button variant="ghost" size="sm" className="h-7 px-2 rounded-md text-[12px] font-normal gap-1.5 text-text-2 hover:bg-transparent dark:hover:bg-transparent hover:text-foreground press [&_svg]:size-3.5" onClick={() => setShowWifiDialog(true)}>
            <WifiIcon /> Connect by IP
          </Button> : <span />}
          {version && <span className="pr-2 font-mono text-[10.5px] text-text-3">v{version}</span>}
        </footer>
      </main>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-100 min-w-44 bg-popover border border-border rounded-[10px] p-1 shadow-(--float-shadow) animate-in fade-in zoom-in-95 duration-100 origin-top-left"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <Button variant="ghost" className={menuItemClass} onClick={() => {
            onConnectDevice(contextMenu.device);
            setContextMenu(null);
          }}>
            Connect
          </Button>
          <Button variant="ghost" className={menuItemClass} onClick={() => {
            setEditingSerial(contextMenu.device.serial);
            setEditValue(getDeviceDisplayName(contextMenu.device));
            setContextMenu(null);
          }}>
            Rename
          </Button>
          {getDeviceNickname(contextMenu.device.serial) && (
            <Button variant="ghost" className={menuItemClass} onClick={() => {
              setDeviceNickname(contextMenu.device.serial, "");
              setContextMenu(null);
            }}>
              Reset name
            </Button>
          )}
          <Button variant="ghost" className={menuItemClass} onClick={() => {
            handleToggleWifi({ stopPropagation: () => {} } as React.MouseEvent, contextMenu.device);
            setContextMenu(null);
          }}>
            {isNetworkSerial(contextMenu.device.serial) ? "Turn off Wi-Fi debugging" : "Turn on Wi-Fi debugging"}
          </Button>
          <div className="h-px bg-border mx-1.5 my-1" />
          <Button variant="ghost" className={menuItemClass} onClick={() => {
            navigator.clipboard.writeText(contextMenu.device.serial);
            showToast("Serial copied", "info");
            setContextMenu(null);
          }}>
            Copy serial
          </Button>
        </div>
      )}

      <Dialog open={showWifiDialog} onOpenChange={setShowWifiDialog}>
        <DialogPortal>
          <DialogOverlay />
          <DialogPrimitive.Popup className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[320px] max-w-[calc(100vw-32px)] bg-popover border border-border rounded-xl z-50 shadow-(--float-shadow) outline-none animate-in fade-in zoom-in-[0.97] duration-150">
            <div className="flex items-center justify-between px-4 pt-3.5">
              <DialogTitle className="text-[13.5px] font-semibold">Connect by IP</DialogTitle>
              <kbd className="h-[18px] px-1.5 inline-flex items-center rounded-[4px] border border-border bg-surface-2 font-mono text-[10px] text-text-3">esc</kbd>
            </div>
            <div className="px-4 pt-3">
              <input
                aria-label="IP address"
                className="w-full h-8 px-2.5 bg-surface-2 border border-border rounded-lg font-mono text-[12.5px] text-foreground outline-none transition-colors focus:border-input placeholder:text-text-3"
                type="text"
                placeholder="192.168.1.24:5555"
                value={wifiAddress}
                onChange={(e) => setWifiAddress(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleWifiConnect()}
                spellCheck={false}
                autoFocus
              />
              <p className="mt-2 text-[11.5px] leading-[1.5] text-text-3">
                Same Wi-Fi as this computer. The IP is in Settings &gt; About phone &gt; Status.
              </p>
            </div>
            <div className="mt-4 px-4 py-3 border-t border-border flex justify-end gap-2">
              <Button
                variant="outline"
                className="h-7 rounded-lg px-3 text-[12px] font-medium border-input bg-transparent dark:bg-transparent hover:bg-transparent dark:hover:bg-transparent hover-dim press"
                onClick={() => setShowWifiDialog(false)}
              >
                Cancel
              </Button>
              <Button
                className="h-7 min-w-[76px] rounded-lg px-3 text-[12px] font-medium bg-foreground text-background hover:bg-foreground hover-dim press disabled:opacity-35"
                onClick={handleWifiConnect}
                disabled={wifiConnecting || !wifiAddress.trim()}
              >
                {wifiConnecting ? <div className="size-3 border-[1.5px] border-background/30 border-t-background rounded-full animate-spin" /> : "Connect"}
              </Button>
            </div>
          </DialogPrimitive.Popup>
        </DialogPortal>
      </Dialog>
    </div>
  );
}
