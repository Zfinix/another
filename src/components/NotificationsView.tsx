import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Switch } from "@/components/ui/switch";
import { appName, oneTimeCode, timeAgo, type PhoneNotification } from "../hooks/useNotifications";

const TONES = ["g-red", "g-green", "g-ink", "g-teal", "g-blue", "g-violet", "g-orange", "g-pink"];
const MESSAGING = /messaging|whatsapp|telegram|signal|slack|messenger|discord|instagram|twitter|teams/i;
const TABS = ["All", "Codes", "Messages"] as const;
type Tab = (typeof TABS)[number];

const APP_TONES: Record<string, string> = {
  "com.google.android.gm": "g-red",
  "com.google.android.apps.messaging": "g-green",
  "com.whatsapp": "g-teal",
  "com.ubercab": "g-ink",
  "org.telegram.messenger": "g-blue",
  "com.google.android.youtube": "g-red",
  "com.spotify.music": "g-green",
  "com.instagram.android": "g-pink",
};

function tone(pkg: string) {
  if (APP_TONES[pkg]) return APP_TONES[pkg];
  let hash = 0;
  for (const ch of pkg) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return TONES[Math.abs(hash) % TONES.length];
}

interface NotificationsViewProps {
  deviceName: string;
  items: PhoneNotification[];
  icons: Record<string, string>;
  systemCenter: boolean;
  onSystemCenter: (on: boolean) => void;
  offerCodes: boolean;
  onOfferCodes: (on: boolean) => void;
  onCopyCode: (code: string) => void;
}

export function NotificationsView({ deviceName, items, icons, systemCenter, onSystemCenter, offerCodes, onOfferCodes, onCopyCode }: NotificationsViewProps) {
  const [tab, setTab] = useState<Tab>("All");
  const shown = items.filter((n) => tab === "All" || (tab === "Codes" ? !!oneTimeCode(n) : MESSAGING.test(n.package)));

  return (
    <div className="rise flex flex-col gap-8 max-w-[640px]">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="title">Notifications</h1>
          <span className="meta">{deviceName}</span>
        </div>
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "tab on" : "tab"} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
      </header>

      <section className="flex flex-col gap-2">
        <div className="label">On the phone now</div>
        <div className="list">
          {shown.length === 0 && <div className="row" style={{ color: "var(--muted)", fontWeight: 400 }}><span>{tab === "All" ? "Nothing new on the phone" : `No ${tab.toLowerCase()} right now`}</span></div>}
          {shown.map((n) => {
            const code = offerCodes ? oneTimeCode(n) : null;
            const name = appName(n.package);
            return (
              <div key={n.key} className="tile">
                {icons[n.package] ? (
                  <span className="gi gi--md app-icon"><img src={icons[n.package]} alt="" draggable={false} /></span>
                ) : (
                  <span className={`gi gi--md ${tone(n.package)}`}>{name.charAt(0)}</span>
                )}
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <div className="meta flex gap-2"><span>{name}</span><span className="ml-auto">{n.posted_ms ? timeAgo(n.posted_ms) : ""}</span></div>
                  <div className="font-medium truncate">{n.title}</div>
                  {n.text && <div style={{ color: "var(--muted)" }}>{n.text}</div>}
                  {code && (
                    <div className="mt-2 flex gap-2 items-center">
                      <span className="mono" style={{ height: 36, padding: "0 16px", borderRadius: 999, background: "var(--default)", fontSize: 14, letterSpacing: ".16em", display: "inline-flex", alignItems: "center", boxSizing: "border-box" }}>{code}</span>
                      <button type="button" className="button button--primary" onClick={() => onCopyCode(code)}><Icon name="copy" />Copy code</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="label">On this Mac</div>
        <div className="list">
          <div className="row"><span>Show in Notification Center</span><Switch checked={systemCenter} onCheckedChange={onSystemCenter} label="Show in Notification Center" /></div>
          <div className="row"><span>Offer Copy code for one-time codes</span><Switch checked={offerCodes} onCheckedChange={onOfferCodes} label="Offer Copy code for one-time codes" /></div>
        </div>
      </section>
    </div>
  );
}
