import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";

interface PhonePreviewProps {
  image: string | null;
  dimmed?: boolean;
  secondary?: { label: string; run: () => void; busy?: boolean } | null;
  onMirror: () => void;
  mirrorDisabled?: boolean;
  mirrorBusy?: boolean;
}

function clock() {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: false });
}

const BUTTON_RADIUS = 12;

export function PhonePreview({ image, dimmed, secondary, onMirror, mirrorDisabled, mirrorBusy }: PhonePreviewProps) {
  const [time, setTime] = useState(clock);

  useEffect(() => {
    if (image) return;
    const timer = setInterval(() => setTime(clock()), 15000);
    return () => clearInterval(timer);
  }, [image]);

  return (
    <div className="relative flex-[0_0_280px]" style={{ opacity: dimmed ? 0.4 : 1, transition: "opacity .2s ease" }}>
      <span aria-hidden="true" className="absolute" style={{ right: -3, top: 128, width: 3, height: 64, borderRadius: "0 3px 3px 0", background: "linear-gradient(180deg, #3a3a40, #1c1c20)" }} />
      <span aria-hidden="true" className="absolute" style={{ right: -3, top: 212, width: 3, height: 40, borderRadius: "0 3px 3px 0", background: "linear-gradient(180deg, #3a3a40, #1c1c20)" }} />
      <div style={{ padding: 10, borderRadius: 44, background: "linear-gradient(145deg, #2c2c31 0%, #111114 60%, #1c1c20 100%)", boxShadow: "inset 0 0 0 1.5px #44444b, inset 0 0 0 3px #0b0b0d, 0 28px 48px -18px rgba(0,0,0,.5), 0 2px 6px rgba(0,0,0,.2)" }}>
        <div className="relative overflow-hidden" style={{ aspectRatio: "1440 / 3040", borderRadius: 34, background: "#101012" }} role="img" aria-label={image ? "Last screen saved from the phone" : "Phone screen"}>
          {image ? (
            <img src={image} alt="" draggable={false} className="absolute inset-0 size-full" style={{ objectFit: "cover", objectPosition: "center bottom" }} />
          ) : (
            <>
              <div className="absolute inset-0" style={{ background: "radial-gradient(120% 70% at 20% 10%, #2b2e35 0%, #17181b 55%, #101012 100%)" }} />
              <div className="absolute" style={{ left: 24, top: 72, color: "#ededed", fontSize: 60, lineHeight: "60px", fontWeight: 300, letterSpacing: "-0.04em", fontVariantNumeric: "tabular-nums" }}>{time}</div>
            </>
          )}
          <span aria-hidden="true" className="absolute" style={{ top: 14, left: "50%", width: 12, height: 12, marginLeft: -6, borderRadius: "50%", background: "#050506", boxShadow: "inset 0 0 0 2px #16161a" }} />
          <div className="t-dark absolute flex flex-col gap-2" style={{ left: 14, right: 14, bottom: 18 }}>
            {secondary && (
              <button type="button" className="button" style={{ width: "100%", height: 40, borderRadius: BUTTON_RADIUS, color: "#fcfcfc", background: "transparent" }} onClick={() => !secondary.busy && secondary.run()}>
                {secondary.busy ? <span className="spinner" /> : secondary.label}
              </button>
            )}
            <button type="button" className="button button--primary" title="Mirror (⌘↩)" style={{ width: "100%", height: 40, borderRadius: BUTTON_RADIUS }} onClick={() => !mirrorBusy && onMirror()} disabled={mirrorDisabled}>
              {mirrorBusy ? <span className="spinner" style={{ borderColor: "rgba(255,255,255,.3)", borderTopColor: "#fff" }} /> : <><Icon name="playOn" />Mirror</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
