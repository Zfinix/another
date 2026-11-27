import { useEffect, useRef, useState } from "react";
import { ContextMenu, MenuPopup, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { Icon } from "@/components/Icon";
import { DeviceTile } from "@/components/DeviceTile";
import { deviceKind, deviceMaker, deviceName, peerMaker, KIND_LABEL } from "@/lib/devices";
import { isNetworkSerial } from "@/lib/utils";
import type { Device, TailnetPeer, View } from "../types";
import { getDeviceNickname } from "../types";
import logo from "../assets/logo.png";

export interface DeviceActions {
  mirror: (device: Device) => void;
  rename: (serial: string, name: string) => void;
  copyAddress: (device: Device) => void;
  toggleWifi: (device: Device) => void;
  forget: (device: Device) => void;
}

interface SidebarProps {
  devices: Device[];
  tailnetPeers: TailnetPeer[];
  view: View | null;
  onSelect: (view: View) => void;
  actions: DeviceActions;
  macroCount: number;
  recordingCount: number;
  notificationCount: number;
  notificationsAvailable: boolean;
  onConnectByAddress: () => void;
  onOpenSettings: () => void;
}

function matches(query: string, ...values: string[]) {
  const q = query.trim().toLowerCase();
  return !q || values.some((v) => v.toLowerCase().includes(q));
}

export function Sidebar({
  devices,
  tailnetPeers,
  view,
  onSelect,
  actions,
  macroCount,
  recordingCount,
  notificationCount,
  notificationsAvailable,
  onConnectByAddress,
  onOpenSettings,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const shownDevices = devices.filter((d) => matches(query, deviceName(d), d.serial));
  const shownPeers = tailnetPeers.filter((p) => matches(query, p.name, p.address));
  const library = [
    { id: "macros" as const, label: "Macros", icon: "wandOn" as const, tone: "g-violet", count: macroCount, show: true },
    { id: "recordings" as const, label: "Recordings", icon: "recDot" as const, tone: "g-red", count: recordingCount, show: true },
    { id: "notifications" as const, label: "Notifications", icon: "alert" as const, tone: "g-orange", count: notificationCount, show: notificationsAvailable },
    { id: "agents" as const, label: "AI and CLI", icon: "sparkle" as const, tone: "g-blue", count: 0, show: true },
  ].filter((l) => l.show && matches(query, l.label));

  const startRename = (device: Device) => {
    setDraft(deviceName(device));
    setRenaming(device.serial);
  };
  const saveRename = () => {
    if (renaming) actions.rename(renaming, draft);
    setRenaming(null);
  };

  return (
    <aside className="flex-[0_0_232px] min-w-0 px-3 pb-3 box-border flex flex-col gap-4 overflow-hidden">
      <div className="traffic drag" data-tauri-drag-region />
      <div className="brand" data-tauri-drag-region>
        <img src={logo} alt="" draggable={false} />
        <span>Another</span>
      </div>
      <label className="field">
        <Icon name="search" />
        <input ref={searchRef} placeholder="Search" aria-label="Search devices and macros" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} spellCheck={false} />
        <span className="kbd">⌘F</span>
      </label>

      <nav className="scroll flex-1 min-h-0 flex flex-col gap-4">
        {shownDevices.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <div className="label">Devices</div>
            {shownDevices.map((d) => {
              const kind = deviceKind(d);
              if (renaming === d.serial) {
                return (
                  <label key={d.serial} className="field" style={{ margin: 0 }}>
                    <span style={{ marginLeft: -4 }}><DeviceTile maker={deviceMaker(d)} /></span>
                    <input
                      value={draft}
                      aria-label="Device name"
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveRename();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={saveRename}
                    />
                    <button type="button" className="button button--primary" style={{ height: 28, padding: "0 12px", fontSize: 12 }} onMouseDown={(e) => e.preventDefault()} onClick={saveRename}>Save</button>
                  </label>
                );
              }
              const selected = view?.kind === "device" && view.serial === d.serial;
              const unauthorized = d.state === "unauthorized";
              return (
                <ContextMenu.Root key={d.serial}>
                  <ContextMenu.Trigger
                    render={<button type="button" className={selected ? "item on" : "item"} onClick={() => onSelect({ kind: "device", serial: d.serial })} onDoubleClick={() => !unauthorized && actions.mirror(d)} />}
                  >
                    <DeviceTile maker={deviceMaker(d)} off={unauthorized} />
                    <span className="flex-1 min-w-0 truncate text-left">{deviceName(d)}</span>
                    <span className="count">{KIND_LABEL[kind]}</span>
                  </ContextMenu.Trigger>
                  <MenuPopup context width={240}>
                    <MenuItem icon="play" label="Mirror" keys="⌘↩" disabled={unauthorized} onClick={() => actions.mirror(d)} />
                    <MenuItem icon="edit" label="Rename" onClick={() => startRename(d)} />
                    {getDeviceNickname(d.serial) && <MenuItem icon="refresh" label="Reset name" onClick={() => actions.rename(d.serial, "")} />}
                    <MenuItem icon="copy" label={kind === "usb" ? "Copy serial" : "Copy address"} onClick={() => actions.copyAddress(d)} />
                    {kind !== "emulator" && !unauthorized && (
                      <MenuItem icon="wifi" label={isNetworkSerial(d.serial) || d.wifi_available ? "Turn off Wi-Fi debugging" : "Turn on Wi-Fi debugging"} onClick={() => actions.toggleWifi(d)} />
                    )}
                    {kind === "wifi" && (
                      <>
                        <MenuSeparator />
                        <MenuItem icon="trash" label="Forget" danger onClick={() => actions.forget(d)} />
                      </>
                    )}
                  </MenuPopup>
                </ContextMenu.Root>
              );
            })}
          </div>
        )}

        {shownPeers.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <div className="label">Tailnet</div>
            {shownPeers.map((p) => {
              const selected = view?.kind === "tailnet" && view.address === p.address;
              return (
                <button key={p.address} type="button" className={selected ? "item on" : "item"} title={p.dns_name || p.address} onClick={() => onSelect({ kind: "tailnet", address: p.address })}>
                  <DeviceTile maker={peerMaker(p.name)} off={!p.online} />
                  <span className="flex-1 min-w-0 truncate text-left" style={{ color: p.online ? "inherit" : "var(--muted)" }}>{p.name}</span>
                  <span className="dot" style={{ background: p.online ? "var(--live)" : "var(--muted)" }} />
                </button>
              );
            })}
          </div>
        )}

        {library.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <div className="label">Library</div>
            {library.map((l) => (
              <button
                key={l.id}
                type="button"
                className={view?.kind === l.id ? "item on" : "item"}
                onClick={() => onSelect({ kind: l.id })}
              >
                <span className={`gi logo ${l.tone}`}><Icon name={l.icon} /></span>
                <span className="flex-1 text-left">{l.label}</span>
                {l.count > 0 && <span className="count">{l.count}</span>}
              </button>
            ))}
          </div>
        )}
      </nav>

      <div className="flex flex-col gap-0.5">
        <button type="button" className="item" style={{ color: "var(--muted)" }} onClick={onConnectByAddress}>
          <Icon name="add" />
          <span className="flex-1 text-left">Connect by address</span>
        </button>
        <button type="button" className="item" style={{ color: "var(--muted)" }} onClick={onOpenSettings}>
          <Icon name="settings" />
          <span className="flex-1 text-left">Settings</span>
          <span className="kbd">⌘,</span>
        </button>
      </div>
    </aside>
  );
}
