import { Icon } from "@/components/Icon";
import { DeviceTile } from "@/components/DeviceTile";
import { PhonePreview } from "@/components/PhonePreview";
import { CellSelect, type SelectOption } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { IconName } from "@/lib/icons";

export interface DeviceViewProps {
  title: string;
  brand: string;
  online: boolean;
  status: string;
  detail: string;
  preview: string | null;
  connection: { icon: IconName; value: string; healthy: boolean };
  latency: string;
  stream: string;
  profile: { value: string; options: SelectOption<string>[]; onChange: (value: string) => void };
  audio: { checked: boolean; onChange: (on: boolean) => void };
  awake: { checked: boolean; onChange: (on: boolean) => void };
  secondary: { label: string; run: () => void; busy?: boolean } | null;
  onMirror: () => void;
  mirrorBusy: boolean;
}

function IconCell({ icon, tone, label, children }: { icon: IconName; tone: string; label: string; children: React.ReactNode }) {
  return (
    <div className="row row--icon">
      <span>
        <span className={`gi logo ${tone}`}><Icon name={icon} /></span>
        {label}
      </span>
      {children}
    </div>
  );
}

export function DeviceView(props: DeviceViewProps) {
  const { title, brand, online, status, detail, preview, connection, latency, stream, profile, audio, awake, secondary, onMirror, mirrorBusy } = props;
  const statusColor = online ? "var(--live)" : "var(--muted)";

  return (
    <div className="rise flex flex-col gap-8">
      <header className="flex flex-wrap items-center gap-4">
        <DeviceTile maker={brand} size="lg" off={!online} />
        <div className="flex-[1_1_240px] min-w-0 flex flex-col gap-1">
          <h1 className="title truncate">{title}</h1>
          <div className="meta flex items-center gap-2 min-w-0">
            <span className="dot" style={{ background: statusColor }} />
            <span style={{ color: statusColor }}>{status}</span>
            <span className="mono truncate">{detail}</span>
          </div>
        </div>
      </header>

      <div className="flex flex-wrap gap-8 items-start">
        <PhonePreview image={preview} dimmed={!online} secondary={secondary} onMirror={onMirror} mirrorDisabled={!online} mirrorBusy={mirrorBusy} />

        <div className="flex-[1_1_280px] max-w-[360px] min-w-0 flex flex-col gap-6">
          <section className="flex flex-col gap-2">
            <div className="label">Connection</div>
            <div className="list">
              <IconCell icon={connection.icon} tone="g-blue" label="Type">
                <span className="value"><span className="dot" style={{ background: connection.healthy ? "var(--live)" : "var(--warn)" }} />{connection.value}</span>
              </IconCell>
              <IconCell icon="timer" tone="g-green" label="Capture to screen">
                <span className="value" style={{ fontVariantNumeric: "tabular-nums" }}>{latency}</span>
              </IconCell>
              <IconCell icon="video" tone="g-violet" label="Stream">
                <span className="value">{stream}</span>
              </IconCell>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <div className="label">Start with</div>
            <div className="list">
              <CellSelect label="Profile" value={profile.value} options={profile.options} onChange={profile.onChange} icon={{ name: "person", tone: "g-teal" }} />
              <IconCell icon="speaker" tone="g-pink" label="Play phone audio on this Mac">
                <Switch checked={audio.checked} onCheckedChange={audio.onChange} label="Play phone audio on this Mac" />
              </IconCell>
              <IconCell icon="sun" tone="g-orange" label="Keep the phone awake">
                <Switch checked={awake.checked} onCheckedChange={awake.onChange} label="Keep the phone awake" />
              </IconCell>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
