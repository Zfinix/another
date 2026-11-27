import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppDialog, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/Icon";
import { InputOTP } from "@/components/ui/input-otp";
import { cleanError } from "@/lib/errors";
import type { ShowToast, TailnetPeer } from "../types";

type Tab = "qr" | "address" | "pair" | "tailnet";

const TABS: { id: Tab; name: string; action: string }[] = [
  { id: "qr", name: "QR code", action: "New code" },
  { id: "pair", name: "Code", action: "Pair and connect" },
  { id: "address", name: "Address", action: "Connect" },
  { id: "tailnet", name: "Tailnet", action: "Connect" },
];

const RECENTS_KEY = "recent_addresses";
const MAX_RECENTS = 5;
const CODE_LENGTH = 6;
/** What Wireless debugging shows above the pairing code: an IPv4 or bracketed IPv6 address with its port. */
const PAIR_ADDRESS = /^(\d{1,3}(\.\d{1,3}){3}|\[[\da-f:]+\]):\d{2,5}$/i;
const QR_SIZE = 192;
const QR_QUIET_ZONE = 4;

interface QrPairing {
  name: string;
  password: string;
  size: number;
  modules: boolean[];
}

interface QrPaired {
  serial: string;
  host: string;
}

function QrCode({ size, modules }: { size: number; modules: boolean[] }) {
  const path = useMemo(
    () => modules.reduce((d, dark, i) => (dark ? `${d}M${i % size} ${Math.floor(i / size)}h1v1h-1z` : d), ""),
    [size, modules],
  );
  const span = size + QR_QUIET_ZONE * 2;
  return (
    <svg viewBox={`${-QR_QUIET_ZONE} ${-QR_QUIET_ZONE} ${span} ${span}`} width={QR_SIZE} height={QR_SIZE} shapeRendering="crispEdges" role="img" aria-label="Pairing QR code">
      <path d={path} fill="#18181b" />
    </svg>
  );
}

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
  const [tab, setTab] = useState<Tab>("qr");
  const [address, setAddress] = useState("");
  const [pairAddress, setPairAddress] = useState("");
  const [code, setCode] = useState("");
  const [peer, setPeer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recents, setRecents] = useState<RecentAddress[]>([]);
  const [qr, setQr] = useState<QrPairing | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [qrAttempt, setQrAttempt] = useState(0);
  const callbacks = useRef({ onConnected, onOpenChange, showToast });
  callbacks.current = { onConnected, onOpenChange, showToast };

  useEffect(() => {
    if (!open) return;
    setRecents(readRecents());
    setBusy(false);
  }, [open]);

  useEffect(() => {
    if (!open || tab !== "qr") return;
    let live = true;
    setQr(null);
    setQrError(null);
    (async () => {
      try {
        const pairing = await invoke<QrPairing>("qr_pair_start");
        if (!live) return;
        setQr(pairing);
        const paired = await invoke<QrPaired>("qr_pair_wait", { name: pairing.name, password: pairing.password });
        if (!live) return;
        if (/^[\d.]+:\d+$/.test(paired.serial)) rememberAddress(paired.host, paired.serial);
        const { onConnected, onOpenChange, showToast } = callbacks.current;
        showToast("Paired with the phone", "success");
        onConnected(paired.serial, paired.host);
        onOpenChange(false);
      } catch (e) {
        if (live && `${e}` !== "Cancelled") setQrError(cleanError(e));
      }
    })();
    return () => {
      live = false;
      invoke("qr_pair_cancel").catch(() => { });
    };
  }, [open, tab, qrAttempt]);

  const connectTo = async (target: string, name: string) => {
    await invoke("wifi_connect", { address: target });
    rememberAddress(name, target);
    onConnected(target, name);
    onOpenChange(false);
  };

  const submit = async (pairCode = code) => {
    if (tab === "qr") {
      setQrAttempt((n) => n + 1);
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      if (tab === "address") {
        const target = withPort(address, wifiPort);
        await connectTo(target, recents.find((r) => r.address === target)?.name ?? target);
      } else if (tab === "pair") {
        await invoke("adb_pair", { address: pairAddress.trim(), code: pairCode });
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

  const pairAddressValid = PAIR_ADDRESS.test(pairAddress.trim());
  const ready =
    tab === "qr" ? !!qr || !!qrError : tab === "address" ? !!address.trim() : tab === "pair" ? pairAddressValid && code.length === CODE_LENGTH : !!peer;
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

      {tab === "qr" && (
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-center justify-center" style={{ width: QR_SIZE, height: QR_SIZE, borderRadius: 20, background: "#fff", boxShadow: "var(--field-shadow)", opacity: qrError ? 0.3 : 1, transition: "opacity .15s ease" }}>
            {qr ? <QrCode size={qr.size} modules={qr.modules} /> : !qrError && <span className="spinner" />}
          </div>
          <span className="meta" style={{ textAlign: "center", padding: "0 12px", color: qrError ? "var(--rec)" : undefined }}>
            {qrError ?? "On the phone: Developer options, Wireless debugging, Pair device with QR code"}
          </span>
        </div>
      )}

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
            <span className="meta" style={{ padding: "0 12px" }}>On the phone: Developer options, Wireless debugging, Pair device with pairing code</span>
          </div>
          {pairAddressValid && (
            <div className="rise flex flex-col gap-2">
              <label className="label" htmlFor="pair-code">Pairing code</label>
              <InputOTP
                id="pair-code"
                maxLength={CODE_LENGTH}
                value={code}
                onChange={setCode}
                onComplete={(value: string) => { if (!busy) submit(value); }}
                autoFocus
                autoComplete="one-time-code"
                aria-label="Pairing code"
              >
                <InputOTP.Group>
                  <InputOTP.Slot index={0} />
                  <InputOTP.Slot index={1} />
                  <InputOTP.Slot index={2} />
                </InputOTP.Group>
                <InputOTP.Separator />
                <InputOTP.Group>
                  <InputOTP.Slot index={3} />
                  <InputOTP.Slot index={4} />
                  <InputOTP.Slot index={5} />
                </InputOTP.Group>
              </InputOTP>
            </div>
          )}
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
        <button type="button" className="button button--primary" disabled={!ready || busy} onClick={() => submit()}>
          {busy ? <span className="spinner" style={{ borderColor: "rgba(255,255,255,.3)", borderTopColor: "#fff" }} /> : action}
        </button>
      </footer>
    </AppDialog>
  );
}
