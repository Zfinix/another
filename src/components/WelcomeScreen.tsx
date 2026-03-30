import { useState } from "react";
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
import { Dialog } from "@base-ui-components/react/dialog";
import type { Device, ThemePreference } from "../types";
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
        showToast(`${device.model} WiFi disconnected`, "info");
      } else {
        const addr = await invoke<string>("wifi_enable", { serial: device.serial });
        showToast(`${device.model} now available at ${addr}`, "info");
      }
      onRefreshDevices();
    } catch (e) {
      showToast(`${e}`);
    } finally {
      setTogglingSerial(null);
    }
  };

  return (
    <div className="welcome">
      <div className="window-drag" data-tauri-drag-region>
        <div className="toolbar-actions">
          <button className="toolbar-btn" onClick={onCycleTheme} title={themePref === "light" ? "Light" : themePref === "dark" ? "Dark" : "System"}>
            {themePref === "light" ? <SunIcon /> : themePref === "dark" ? <MoonIcon /> : <ComputerDesktopIcon />}
          </button>
          <button className="toolbar-btn" onClick={() => setShowWifiDialog(true)} title="Connect via WiFi">
            <WifiIcon />
          </button>
          <button className="toolbar-btn" onClick={onOpenSettings} title="Settings">
            <Cog6ToothIcon />
          </button>
        </div>
      </div>
      <div className="welcome-header">
        <img src={appIcon} alt="Another" className="welcome-logo" />
        <h1 className="welcome-title">Another</h1>
      </div>
      <p className="welcome-subtitle">Android screen mirroring and control</p>

      <div className="device-list">
        <div className="device-list-header">
          <span className="device-list-title">
            {devices.length > 0 ? `${devices.length} device${devices.length > 1 ? "s" : ""} found` : "Searching..."}
          </span>
          <button className="device-list-refresh" onClick={onRefreshDevices}>
            <ArrowPathIcon /> Refresh
          </button>
        </div>

        {devices.length === 0 ? (
          <div className="device-empty">
            <SignalIcon />
            <p>No devices detected.<br />Connect your Android via USB and enable USB debugging.</p>
          </div>
        ) : (
          devices.map((d) => (
            <div
              key={d.serial}
              className="device-card"
              onClick={() => !connectingSerial && onConnectDevice(d)}
            >
              <div className="device-card-icon">
                {isWifiDevice(d.serial) ? <WifiIcon /> : <DevicePhoneMobileIcon />}
              </div>
              <div className="device-card-info">
                <div className="device-card-name">{d.model}</div>
                <div className="device-card-serial">
                  {d.wifi_available && <span className="device-wifi-badge">WiFi</span>}
                  {truncateSerial(d.serial)}
                </div>
              </div>
              <div className="device-card-actions">
                <button
                  className={`device-wifi-toggle ${isWifiDevice(d.serial) ? "active" : ""}`}
                  title={isWifiDevice(d.serial) ? "Disable WiFi" : "Enable WiFi"}
                  onClick={(e) => handleToggleWifi(e, d)}
                  disabled={togglingSerial === d.serial}
                >
                  {togglingSerial === d.serial ? <div className="spinner-sm" /> : <WifiIcon />}
                </button>
                {connectingSerial === d.serial ? <div className="spinner-sm" /> : <ChevronRightIcon className="device-card-chevron" />}
              </div>
            </div>
          ))
        )}
      </div>

      <Dialog.Root open={showWifiDialog} onOpenChange={setShowWifiDialog}>
        <Dialog.Portal>
          <Dialog.Backdrop className="dialog-backdrop" />
          <Dialog.Popup className="wifi-dialog">
            <Dialog.Title className="wifi-dialog-title">Connect by IP</Dialog.Title>
            <div className="wifi-dialog-section">
              <p className="wifi-dialog-desc">
                On your Android device, go to <strong>Settings &gt; About phone &gt; Status</strong> to find your IP address. Both devices must be on the same network.
              </p>
              <div className="wifi-dialog-form">
                <input
                  className="wifi-input"
                  type="text"
                  placeholder="192.168.1.100"
                  value={wifiAddress}
                  onChange={(e) => setWifiAddress(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleWifiConnect()}
                  autoFocus
                />
                <button
                  className="wifi-connect-btn"
                  onClick={handleWifiConnect}
                  disabled={wifiConnecting || !wifiAddress.trim()}
                >
                  {wifiConnecting ? <div className="spinner-sm" /> : "Connect"}
                </button>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
