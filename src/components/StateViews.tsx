import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { DeviceTile } from "@/components/DeviceTile";
import logo from "../assets/logo.png";

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="rise w-full max-w-[400px] flex flex-col gap-4">{children}</div>;
}

function Heading({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="h2">{title}</h2>
      <span className="meta">{meta}</span>
    </div>
  );
}

export function EmptyState({ onConnectByAddress }: { onConnectByAddress: () => void }) {
  return (
    <Panel>
      <img src={logo} alt="" draggable={false} style={{ width: 52, height: 52, margin: -2 }} />
      <Heading title="Plug in your phone" meta="No phones found yet" />
      <div className="list">
        <div className="row"><span>Connect a USB cable</span><span className="value">1</span></div>
        <div className="row"><span>Turn on USB debugging</span><span className="value">2</span></div>
        <div className="row"><span>Tap Allow on the phone</span><span className="value">3</span></div>
      </div>
      <button type="button" className="button button--primary self-start" onClick={onConnectByAddress}>Pair over Wi-Fi</button>
    </Panel>
  );
}

export function TrustState({ name, brand }: { name: string; brand: string }) {
  return (
    <Panel>
      <span className="relative shrink-0" style={{ width: 48, height: 48 }} role="img" aria-label={`${name}, waiting for verification`}>
        <DeviceTile maker={brand} size="lg" />
        <span className="absolute flex items-center justify-center" style={{ right: -6, bottom: -6, width: 24, height: 24, borderRadius: "50%", background: "var(--live)", color: "#fff", boxShadow: "0 0 0 2px var(--surface), 0 1px 3px rgba(0,0,0,.25)" }}>
          <Icon name="tick" style={{ width: 14, height: 14 }} />
        </span>
      </span>
      <Heading title="Tap Allow on your phone" meta={`${name} is asking to trust this Mac`} />
      <div className="list">
        <div className="row"><span>Always allow this Mac</span><span className="value">Tick on the phone</span></div>
        <div className="row"><span className="inline-flex items-center gap-3"><span className="spinner" />Waiting for the phone</span></div>
      </div>
    </Panel>
  );
}

export type StepState = "done" | "active" | "pending";

export interface StartStep {
  label: string;
  state: StepState;
}

const SLOW_START_MS = 6000;

export function StartingState({ name, brand, path, steps }: { name: string; brand: string; path: string; steps: StartStep[] }) {
  const active = steps.find((s) => s.state === "active")?.label ?? "";
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), SLOW_START_MS);
    return () => clearTimeout(timer);
  }, [active]);
  return (
    <Panel>
      <DeviceTile maker={brand} size="lg" />
      <Heading title={`Starting ${name}`} meta={path} />
      <div className="list">
        {steps.map((s) => (
          <div key={s.label} className="row" style={s.state === "pending" ? { color: "var(--muted)" } : undefined}>
            <span>{s.label}</span>
            {s.state === "done" && <Icon name="done" style={{ color: "var(--live)" }} label="Done" />}
            {s.state === "active" && <span className="spinner" role="img" aria-label="In progress" />}
            {s.state === "pending" && <span className="step-pending" role="img" aria-label="Not started" />}
          </div>
        ))}
      </div>
      {slow && active && <span className="meta" style={{ padding: "0 12px" }}>Taking a while. Wake the phone, or disconnect and try again.</span>}
    </Panel>
  );
}

export function DisconnectedState({ name, brand, reason, onBack, onReconnect }: { name: string; brand: string; reason: string; onBack: () => void; onReconnect: () => void }) {
  return (
    <Panel>
      <DeviceTile maker={brand} size="lg" off />
      <Heading title={`${name} disconnected`} meta={reason} />
      <div className="flex gap-2">
        <button type="button" className="button button--secondary" onClick={onBack}>Back to devices</button>
        <button type="button" className="button button--primary" onClick={onReconnect}>Reconnect</button>
      </div>
    </Panel>
  );
}
