import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppDialog, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/Icon";
import type { ShowToast, TailnetPeer } from "../types";

type Tab = "address" | "pair" | "tailnet";

const TABS: { id: Tab; name: string; action: string }[] = [
  { id: "address", name: "Address", action: "Connect" },
  { id: "pair", name: "Pair with code", action: "Pair and connect" },
  { id: "tailnet", name: "Tailnet", action: "Connect" },
];

const RECENTS_KEY = "recent_addresses";
const MAX_RECENTS = 5;
const CODE_LENGTH = 6;

export interface RecentAddress {
  name: string;
  address: string;
}

export function readRecents(): RecentAddress[] {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
  } catch {
    return [];
  }
}

export function rememberAddress(name: string, address: string) {
  const next = [{ name, address }, ...readRecents().filter((r) => r.address !== address)].slice(0, MAX_RECENTS);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
}

function withPort(address: string, port: number) {
  const trimmed = address.trim();
  return trimmed.includes(":") ? trimmed : `${trimmed}:${port}`;
}

function peerPath(peer: TailnetPeer) {
  if (!peer.online) return "Offline";
  if (peer.direct) return "Direct";
  return peer.relay ? `Relayed via ${peer.relay}` : "Relayed";
}

interface ConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  peers: TailnetPeer[] | null;
  wifiPort: number;
  onConnected: (serial: string, name: string) => void;
  showToast: ShowToast;
}

export function ConnectDialog({ open, onOpenChange, peers, wifiPort, onConnected, showToast }: ConnectDialogProps) {
  const [tab, setTab] = useState<Tab>("address");
  const [address, setAddress] = useState("");
  const [pairAddress, setPairAddress] = useState("");
  const [code, setCode] = useState("");
  const [peer, setPeer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recents, setRecents] = useState<RecentAddress[]>([]);

  useEffect(() => {
    if (!open) return;
    setRecents(readRecents());
    setBusy(false);
  }, [open]);

  const connectTo = async (target: string, name: string) => {
    await invoke("wifi_connect", { address: target });
    rememberAddress(name, target);
    onConnected(target, name);
    onOpenChange(false);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (tab === "address") {
        const target = withPort(address, wifiPort);
        await connectTo(target, recents.find((r) => r.address === target)?.name ?? target);
      } else if (tab === "pair") {
        await invoke("adb_pair", { address: pairAddress.trim(), code });
        const host = pairAddress.trim().split(":")[0];
        showToast("Paired with the phone", "success", { detail: "Now connecting over Wi-Fi" });
        await connectTo(withPort(host, wifiPort), host);
      } else {
        const chosen = peers?.find((p) => p.address === peer);
        if (chosen) await connectTo(chosen.address, chosen.name);
      }
    } catch (e) {
      const target = tab === "pair" ? pairAddress : tab === "tailnet" ? peer ?? "" : withPort(address, wifiPort);
      showToast(`Could not reach ${target}`, "error", {
        detail: tab === "tailnet" ? "Connect it by USB once and turn on Wi-Fi debugging" : tab === "pair" ? `${e}` : "Check the phone is on the same Wi-Fi",
      });
    } finally {
      setBusy(false);
    }
  };

  const ready =
    tab === "address" ? !!address.trim() : tab === "pair" ? !!pairAddress.trim() && code.length === CODE_LENGTH : !!peer;
  const action = TABS.find((t) => t.id === tab)!.action;

  return (
    <AppDialog open={open} onOpenChange={onOpenChange} className="dialog" label="Connect a phone" top={120}>
      <header className="flex items-start gap-4">
        <span className="gi gi--md logo g-blue"><Icon name="link" /></span>
        <div className="flex-1 flex flex-col gap-1">
          <DialogTitle className="title">Connect a phone</DialogTitle>
          <span className="meta">Over Wi-Fi or your tailnet</span>
        </div>
      </header>

      <div className="tabs self-stretch" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "tab on" : "tab"} style={{ flex: 1 }} onClick={() => setTab(t.id)}>{t.name}</button>
        ))}
      </div>

      {tab === "address" && (
        <>
          <div className="flex flex-col gap-2">
            <label className="label" htmlFor="connect-address">Address</label>
            <div className="field">
              <input id="connect-address" value={address} placeholder={`192.168.1.24:${wifiPort}`} autoFocus spellCheck={false} style={{ fontVariantNumeric: "tabular-nums" }} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ready && submit()} />
            </div>
          </div>
          {recents.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="label">Recent</div>
              <div className="list">
                {recents.map((r) => (
                  <button key={r.address} type="button" className="row" onClick={() => setAddress(r.address)}>
                    <span>{r.name}</span>
                    <span className="value" style={{ fontVariantNumeric: "tabular-nums" }}>{r.address}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {tab === "pair" && (
        <>
          <div className="flex flex-col gap-2">
            <label className="label" htmlFor="pair-address">IP address and port</label>
            <div className="field">
              <input id="pair-address" value={pairAddress} placeholder="192.168.1.24:37099" autoFocus spellCheck={false} style={{ fontVariantNumeric: "tabular-nums" }} onChange={(e) => setPairAddress(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <label className="label" htmlFor="pair-code">Pairing code</label>
            <div className="relative grid gap-2" style={{ gridTemplateColumns: `repeat(${CODE_LENGTH}, minmax(0, 1fr))` }}>
              {Array.from({ length: CODE_LENGTH }, (_, i) => (
                <span key={i} className="flex items-center justify-center" style={{ height: 40, borderRadius: 12, background: "var(--field)", boxShadow: i === code.length ? "inset 0 0 0 2px var(--accent)" : "var(--field-shadow)", fontSize: 16, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{code[i] ?? ""}</span>
              ))}
              <input
                id="pair-code"
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="Pairing code"
                className="absolute inset-0 opacity-0"
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))}
                onKeyDown={(e) => e.key === "Enter" && ready && submit()}
              />
            </div>
            <span className="meta" style={{ padding: "0 12px" }}>On the phone: Developer options, Wireless debugging, Pair device with pairing code</span>
          </div>
        </>
      )}

      {tab === "tailnet" && (
        <div className="flex flex-col gap-2">
          <div className="label">Phones on your tailnet</div>
          <div className="list">
            {!peers && <div className="row" style={{ color: "var(--muted)", fontWeight: 400 }}><span>Tailscale is not running on this Mac</span></div>}
            {peers && peers.length === 0 && <div className="row" style={{ color: "var(--muted)", fontWeight: 400 }}><span>No phones on your tailnet</span></div>}
            {peers?.map((p) => (
              <button key={p.address} type="button" className="row row--icon" disabled={!p.online} onClick={() => setPeer(p.address)} style={peer === p.address ? { boxShadow: "inset 0 0 0 2px var(--accent)" } : undefined}>
                <span style={{ color: p.online ? undefined : "var(--muted)" }}>
                  <span className="gi logo g-teal"><Icon name="globeOn" /></span>
                  {p.name}
                </span>
                <span className="value"><span className="dot" style={{ background: !p.online ? "var(--muted)" : p.direct ? "var(--live)" : "var(--warn)" }} />{peerPath(p)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <footer className="flex justify-end gap-2">
        <button type="button" className="button button--secondary" onClick={() => onOpenChange(false)}>Cancel</button>
        <button type="button" className="button button--primary" disabled={!ready || busy} onClick={submit}>
          {busy ? <span className="spinner" style={{ borderColor: "rgba(255,255,255,.3)", borderTopColor: "#fff" }} /> : action}
        </button>
      </footer>
    </AppDialog>
  );
}
