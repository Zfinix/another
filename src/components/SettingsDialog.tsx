import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AppDialog, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/Icon";
import { Switch } from "@/components/ui/switch";
import { CellSelect } from "@/components/ui/select";
import { SliderRow } from "@/components/ui/slider";
import { PortRow } from "@/components/ui/port";
import type { IconName } from "@/lib/icons";
import type { Settings, DevSettings, EncoderTuning, ThemePreference } from "../types";
import type { LatencyResult } from "../hooks/useLatencyProbe";
import { RESOLUTION_OPTIONS, CODEC_OPTIONS, ENCODER_TUNING_OPTIONS } from "../types";

const ISSUES_URL = "https://github.com/Zfinix/another/issues/new";

const FPS_OPTIONS = [30, 60, 90, 120].map((v) => ({ value: v, label: `${v} fps` }));
const MBPS = 1_000_000;

export type SettingsPane = "general" | "stream" | "network" | "audio" | "shortcuts" | "profiles" | "developer" | "help";

const PANES: { id: SettingsPane; name: string; icon: IconName; tone: string }[] = [
  { id: "general", name: "General", icon: "settingsOn", tone: "g-grey" },
  { id: "stream", name: "Stream", icon: "paneStreamOn", tone: "g-violet" },
  { id: "network", name: "Network", icon: "paneNetworkOn", tone: "g-blue" },
  { id: "audio", name: "Audio", icon: "paneAudioOn", tone: "g-pink" },
  { id: "shortcuts", name: "Shortcuts", icon: "paneShortcutsOn", tone: "g-grey" },
  { id: "profiles", name: "Profiles", icon: "paneProfilesOn", tone: "g-orange" },
  { id: "developer", name: "Developer", icon: "paneDeveloperOn", tone: "g-ink" },
  { id: "help", name: "Help", icon: "paneHelpOn", tone: "g-teal" },
];

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "auto", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export interface ShortcutInfo {
  name: string;
  keys: string;
}

export interface NetworkPrefs {
  autoReconnect: boolean;
  showTailnet: boolean;
}

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pane: SettingsPane;
  onPaneChange: (pane: SettingsPane) => void;
  settings: Settings;
  onUpdateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  devSettings: DevSettings;
  onUpdateDevSetting: <K extends keyof DevSettings>(key: K, value: DevSettings[K]) => void;
  themePref: ThemePreference;
  onThemePref: (pref: ThemePreference) => void;
  glass: { opacity: number; blur: number };
  onGlass: (glass: { opacity: number; blur: number }) => void;
  savePath: string;
  onSavePath: (path: string) => void;
  macrosDir: string;
  onMacrosDir: (dir: string) => void;
  networkPrefs: NetworkPrefs;
  wifiPort: number;
  onWifiPort: (port: number) => void;
  onNetworkPrefs: (prefs: NetworkPrefs) => void;
  tailscaleRunning: boolean;
  shortcuts: ShortcutInfo[];
  profileSummary: string;
  latencyProbe: { running: boolean; result: LatencyResult | null; error: string | null; run: () => void } | null;
  onExportProfile: () => void;
  onImportProfile: () => void;
  onCopyProfileLink: () => void;
  version: string | null;
  onCheckForUpdates: () => void;
  onWhatsNew: () => void;
  onConnectPhone: () => void;
  onOpenAgents: () => void;
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="label">{label}</div>
      <div className="list">{children}</div>
    </section>
  );
}

function SwitchRow({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <div className="row">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} label={label} />
    </div>
  );
}

function ValueRow({ label, value, onClick, accent }: { label: string; value: React.ReactNode; onClick?: () => void; accent?: boolean }) {
  const content = (
    <>
      <span>{label}</span>
      <span className="value" style={accent ? { color: "var(--accent)" } : undefined}>{value}</span>
    </>
  );
  return onClick ? <button type="button" className="row" onClick={onClick}>{content}</button> : <div className="row">{content}</div>;
}

export function SettingsDialog(props: SettingsDialogProps) {
  const { open, onOpenChange, pane, onPaneChange, settings, onUpdateSetting, devSettings, onUpdateDevSetting } = props;
  const [query, setQuery] = useState("");
  const shownPanes = PANES.filter((p) => !query.trim() || p.name.toLowerCase().includes(query.trim().toLowerCase()));
  const current = PANES.find((p) => p.id === pane) ?? PANES[0];
  const quality = settings.adaptive;
  const isMac = navigator.userAgent.includes("Mac");

  return (
    <AppDialog open={open} onOpenChange={onOpenChange} label="Settings" top={48} className="flex gap-2" style={{ width: "100%", maxWidth: 960, height: "min(720px, calc(100vh - 96px))", padding: 8 }}>
      <aside className="settings-aside flex-[0_0_216px] min-w-0 px-3 pb-3 pt-1.5 box-border flex flex-col gap-4" style={{ borderRadius: 24, background: "var(--side-panel)", boxShadow: "inset 0 0 0 1px var(--glass-edge)" }}>
        <div style={{ height: 6 }} />
        <div className="brand">
          <span>Settings</span>
        </div>
        <label className="field">
          <Icon name="search" />
          <input placeholder="Search settings" aria-label="Search settings" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
        </label>
        <nav className="flex flex-col gap-0.5">
          {shownPanes.map((p) => (
            <button key={p.id} type="button" className={p.id === pane ? "item on" : "item"} onClick={() => onPaneChange(p.id)}>
              <span className={`gi ${p.tone}`}><Icon name={p.icon} /></span>
              <span className="flex-1 text-left">{p.name}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="card scroll flex-1 min-w-0 p-8 flex flex-col gap-8">
        <DialogTitle className="title">{current.name}</DialogTitle>

        {pane === "general" && (
          <>
            <Section label="Appearance">
              <CellSelect label="Theme" value={props.themePref} options={THEME_OPTIONS} onChange={props.onThemePref} />
              <SliderRow label="Glass opacity" value={props.glass.opacity} min={20} max={100} step={1} format={(v) => `${v}%`} onChange={(v) => props.onGlass({ ...props.glass, opacity: v })} />
              <SliderRow label="Glass blur" value={props.glass.blur} min={0} max={100} step={1} format={(v) => `${v}%`} onChange={(v) => props.onGlass({ ...props.glass, blur: v })} />
            </Section>
            <Section label="Files">
              <ValueRow
                label="Save screenshots and recordings in"
                value={<span className="truncate max-w-[220px]" title={props.savePath}>{props.savePath.split("/").filter(Boolean).pop() ?? "Downloads"}</span>}
                onClick={async () => {
                  const dir = await openDialog({ directory: true, multiple: false });
                  if (typeof dir === "string") props.onSavePath(dir);
                }}
              />
              <ValueRow
                label="Keep macros in"
                value={<span className="truncate max-w-[220px]" title={props.macrosDir}>{props.macrosDir.split("/").filter(Boolean).pop() ?? "macros"}</span>}
                onClick={async () => {
                  const dir = await openDialog({ directory: true, multiple: false });
                  if (typeof dir === "string") props.onMacrosDir(dir);
                }}
              />
            </Section>
            <Section label="About">
              <ValueRow label={`Another ${props.version ? `v${props.version}` : ""}`} value="Check for updates" accent onClick={props.onCheckForUpdates} />
            </Section>
          </>
        )}

        {pane === "stream" && (
          <>
            <Section label="Quality">
              <CellSelect label="Resolution" value={settings.max_size} options={RESOLUTION_OPTIONS} onChange={(v) => onUpdateSetting("max_size", v)} disabled={quality} />
              <CellSelect label="Frame rate" value={settings.max_fps} options={FPS_OPTIONS.some((o) => o.value === settings.max_fps) ? FPS_OPTIONS : [...FPS_OPTIONS, { value: settings.max_fps, label: `${settings.max_fps} fps` }]} onChange={(v) => onUpdateSetting("max_fps", v)} disabled={quality} />
              <SliderRow label="Bitrate" value={Math.round(settings.video_bit_rate / MBPS)} min={1} max={32} step={1} format={(v) => `${v} Mbps`} onChange={(v) => onUpdateSetting("video_bit_rate", v * MBPS)} disabled={quality} />
              {CODEC_OPTIONS.length > 1 ? (
                <CellSelect label="Codec" value={settings.video_codec} options={CODEC_OPTIONS} onChange={(v) => onUpdateSetting("video_codec", v)} />
              ) : (
                <ValueRow label="Codec" value={CODEC_OPTIONS[0].label} />
              )}
            </Section>
            <Section label="Adaptive">
              <SwitchRow label="Adaptive quality" checked={settings.adaptive} onChange={(on) => onUpdateSetting("adaptive", on)} />
              <SwitchRow label="Always adapt on Wi-Fi and tailnet" checked={settings.adaptive || settings.adaptive_network !== false} disabled={settings.adaptive} onChange={(on) => onUpdateSetting("adaptive_network", on)} />
            </Section>
          </>
        )}

        {pane === "network" && (
          <>
            <Section label="Wi-Fi">
              <SwitchRow label="Direct network stream" checked={devSettings.networkStream} disabled={!devSettings.anotherServer} onChange={(on) => onUpdateDevSetting("networkStream", on)} />
              <SwitchRow label="Reconnect when a phone comes back" checked={props.networkPrefs.autoReconnect} onChange={(on) => props.onNetworkPrefs({ ...props.networkPrefs, autoReconnect: on })} />
              <PortRow label="Wireless debugging port" value={props.wifiPort} onCommit={props.onWifiPort} />
            </Section>
            <Section label="Tailnet">
              <ValueRow label="Tailscale" value={<><span className="dot" style={{ background: props.tailscaleRunning ? "var(--live)" : "var(--muted)" }} />{props.tailscaleRunning ? "Running" : "Off on this Mac"}</>} />
              <SwitchRow label="Show tailnet phones in the sidebar" checked={props.networkPrefs.showTailnet} onChange={(on) => props.onNetworkPrefs({ ...props.networkPrefs, showTailnet: on })} />
            </Section>
          </>
        )}

        {pane === "audio" && (
          <Section label="Audio">
            <SwitchRow label="Play phone audio on this Mac" checked={settings.audio} onChange={(on) => onUpdateSetting("audio", on)} />
            <ValueRow label="Codec" value="Raw" />
          </Section>
        )}

        {pane === "shortcuts" && (
          <Section label="Shortcuts">
            {props.shortcuts.map((s) => (
              <div key={s.name} className="row"><span>{s.name}</span><span className="kbd">{s.keys}</span></div>
            ))}
          </Section>
        )}

        {pane === "profiles" && (
          <>
            <Section label="Current profile">
              <ValueRow label="Your settings" value={props.profileSummary} />
            </Section>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="button button--secondary" onClick={props.onImportProfile}>Import</button>
              <button type="button" className="button button--secondary" onClick={props.onExportProfile}>Export</button>
              <button type="button" className="button button--primary" onClick={props.onCopyProfileLink}>Copy link</button>
            </div>
          </>
        )}

        {pane === "developer" && (
          <>
            <Section label="Pipeline">
              <SwitchRow label="Another server" checked={devSettings.anotherServer} onChange={(on) => onUpdateDevSetting("anotherServer", on)} />
              {isMac && <SwitchRow label="Native video" checked={devSettings.nativeVideo} onChange={(on) => onUpdateDevSetting("nativeVideo", on)} />}
              <SwitchRow label="Direct ADB transport" checked={devSettings.directAdb} onChange={(on) => onUpdateDevSetting("directAdb", on)} />
              <SwitchRow label="Low-latency pipeline" checked={devSettings.lowLatency} onChange={(on) => onUpdateDevSetting("lowLatency", on)} />
              <CellSelect label="Encoder tuning" value={devSettings.encoderTuning} options={ENCODER_TUNING_OPTIONS} onChange={(v) => onUpdateDevSetting("encoderTuning", v as EncoderTuning)} disabled={!devSettings.lowLatency} />
            </Section>
            <Section label="Measure">
              <SwitchRow label="Stream stats overlay" checked={devSettings.perfOverlay} onChange={(on) => onUpdateDevSetting("perfOverlay", on)} />
              {props.latencyProbe ? (
                <ValueRow
                  label="Touch to screen latency"
                  value={props.latencyProbe.running ? "Measuring" : props.latencyProbe.result ? `${props.latencyProbe.result.medianMs.toFixed(0)} ms · Measure again` : props.latencyProbe.error ? "Failed · Try again" : "Measure"}
                  accent
                  onClick={props.latencyProbe.running ? undefined : props.latencyProbe.run}
                />
              ) : (
                <ValueRow label="Touch to screen latency" value="Mirror a phone first" />
              )}
            </Section>
          </>
        )}
        {pane === "help" && (
          <>
            <Section label="Get started">
              <ValueRow label="Pair over Wi-Fi with a QR code" value="Pair a phone" accent onClick={props.onConnectPhone} />
              <ValueRow label="Connect over USB" value="Turn on USB debugging" />
              <ValueRow label="Let an AI agent use the phone" value="Connect an agent" accent onClick={props.onOpenAgents} />
            </Section>
            <Section label="If something goes wrong">
              <ValueRow label="The phone is not listed" value="Replug it and tap Allow" />
              <ValueRow label="Pairing does not finish" value="Use the same Wi-Fi on both" />
              <ValueRow label="The video stutters" value="Turn on adaptive quality" accent onClick={() => onPaneChange("stream")} />
            </Section>
            <Section label="More">
              <ValueRow label="What's new in this version" value="Show" accent onClick={props.onWhatsNew} />
              <ValueRow label="Report a problem" value="Open GitHub" accent onClick={() => { openUrl(ISSUES_URL).catch(() => { }); }} />
            </Section>
          </>
        )}
      </main>
    </AppDialog>
  );
}
