import type { HeroPattern } from "@/lib/news";

const W = 300;
const H = 172;

function seeded(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function Silk({ rand }: { rand: () => number }) {
  const lines = Array.from({ length: 14 }, (_, i) => {
    const base = 18 + i * 10;
    const amp = 10 + rand() * 18;
    const phase = rand() * Math.PI * 2;
    const freq = 0.012 + rand() * 0.008;
    let d = "";
    for (let x = -10; x <= W + 10; x += 6) {
      const y = base + Math.sin(x * freq + phase) * amp + Math.sin(x * freq * 2.3 + phase) * amp * 0.25;
      d += `${x === -10 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    return <path key={i} d={d} style={{ opacity: 0.25 + (i / 14) * 0.5 }} />;
  });
  return <g fill="none" stroke="var(--hero-ink)" strokeWidth={0.8}>{lines}</g>;
}

function Topo({ rand }: { rand: () => number }) {
  const cx = W * (0.55 + rand() * 0.2);
  const cy = H * (0.45 + rand() * 0.2);
  const bumps = Array.from({ length: 5 }, () => ({ k: 2 + Math.floor(rand() * 4), p: rand() * Math.PI * 2, a: 0.06 + rand() * 0.08 }));
  const rings = Array.from({ length: 11 }, (_, i) => {
    const r = 14 + i * 15;
    let d = "";
    for (let s = 0; s <= 72; s++) {
      const t = (s / 72) * Math.PI * 2;
      const wobble = bumps.reduce((sum, b) => sum + Math.sin(t * b.k + b.p + i * 0.35) * b.a, 0);
      const rr = r * (1 + wobble);
      d += `${s === 0 ? "M" : "L"}${(cx + Math.cos(t) * rr * 1.25).toFixed(1)} ${(cy + Math.sin(t) * rr).toFixed(1)}`;
    }
    return <path key={i} d={`${d}Z`} style={{ opacity: 0.85 - i * 0.06 }} />;
  });
  return <g fill="none" stroke="var(--hero-ink)" strokeWidth={0.8}>{rings}</g>;
}

function Prism({ rand }: { rand: () => number }) {
  const shards = Array.from({ length: 6 }, (_, i) => {
    const x = -40 + i * 62 + rand() * 20;
    const skew = 50 + rand() * 60;
    const w = 40 + rand() * 50;
    return { points: `${x},${H + 10} ${x + skew},-10 ${x + skew + w},-10 ${x + w},${H + 10}`, c: (i % 3) + 1, o: 0.08 + rand() * 0.12 };
  });
  return (
    <g>
      {shards.map((s, i) => (
        <g key={i}>
          <polygon points={s.points} fill={`var(--hero-c${s.c})`} style={{ opacity: s.o }} />
          <polyline points={s.points.split(" ").slice(0, 2).join(" ")} fill="none" stroke="var(--hero-ink)" strokeWidth={0.8} style={{ opacity: 0.6 }} />
        </g>
      ))}
    </g>
  );
}

export function HeroBackdrop({ id, pattern }: { id: string; pattern: HeroPattern }) {
  const rand = seeded(id);
  return (
    <svg className="hero-backdrop" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {pattern === "silk" && <Silk rand={rand} />}
      {pattern === "topo" && <Topo rand={rand} />}
      {pattern === "prism" && <Prism rand={rand} />}
    </svg>
  );
}
