import { useState } from "react";
import { Icon } from "@/components/Icon";
import { NEWS, type News, type NewsArt } from "@/lib/news";
import { HeroBackdrop } from "@/components/HeroBackdrop";

function Art({ art, dark }: { art: NewsArt; dark: boolean }) {
  if (art.kind === "logos") {
    return (
      <>
        {art.logos.map((logo) => (
          <span key={logo.light} className="gi logo news-tile">
            <img src={dark ? logo.dark : logo.light} alt="" draggable={false} style={{ width: 30, height: 30, objectFit: "contain" }} />
          </span>
        ))}
      </>
    );
  }
  return (
    <>
      {art.tiles.map((tile) => (
        <span key={tile.icon} className={`gi ${dark ? "" : "logo "}news-tile ${tile.tone}`}><Icon name={tile.icon} /></span>
      ))}
    </>
  );
}

interface WhatsNewProps {
  start: News;
  onClose: () => void;
  onAction: (item: News) => void;
}

/** Announcement cards that float over the sidebar, newest first, until closed or acted on. */
export function WhatsNew({ start, onClose, onAction }: WhatsNewProps) {
  const [at, setAt] = useState(() => Math.max(0, NEWS.findIndex((item) => item.id === start.id)));
  const item = NEWS[at] ?? start;
  const dark = document.documentElement.classList.contains("t-dark");
  const colors = (dark && item.hero.dark) || item.hero.colors;
  const last = at >= NEWS.length - 1;
  const label = item.action.kind === "none" ? (last ? "Done" : "Next") : item.action.label;

  const act = () => {
    if (item.action.kind === "none") {
      if (last) onClose();
      else setAt(at + 1);
      return;
    }
    onAction(item);
  };

  return (
    <div className="news-card rise" role="dialog" aria-label={item.title}>
      <div
        className="news-hero"
        style={{ "--hero-c1": colors[0], "--hero-c2": colors[1], "--hero-c3": colors[2] } as React.CSSProperties}
      >
        <HeroBackdrop key={item.id} id={item.id} pattern={item.hero.pattern} />
        <div className="news-art"><Art art={item.art} dark={dark} /></div>
        <button type="button" className="news-close" aria-label="Close" onClick={onClose}><Icon name="dismiss" size="sm" /></button>
      </div>
      <div className="news-body">
        <div className="meta">What's new · {at + 1} of {NEWS.length}</div>
        <div className="news-title">{item.title}</div>
        <div className="news-text">{item.body}</div>
        <button type="button" className="button button--primary news-action" onClick={act}>{label}</button>
        <div className="news-pager">
          <button type="button" className="icon-button" style={{ width: 26, height: 26 }} aria-label="Previous" disabled={at === 0} onClick={() => setAt(at - 1)}>
            <Icon name="chevron" size="sm" style={{ transform: "scaleX(-1)" }} />
          </button>
          <div className="flex items-center gap-1.5">
            {NEWS.map((n, index) => (
              <button key={n.id} type="button" className={index === at ? "news-dot on" : "news-dot"} aria-label={`Card ${index + 1} of ${NEWS.length}`} aria-current={index === at} onClick={() => setAt(index)} />
            ))}
          </div>
          <button type="button" className="icon-button" style={{ width: 26, height: 26 }} aria-label="Next" disabled={last} onClick={() => setAt(at + 1)}>
            <Icon name="chevron" size="sm" />
          </button>
        </div>
      </div>
    </div>
  );
}
