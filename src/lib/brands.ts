import { useEffect, useState } from "react";

interface SvglEntry {
  title: string;
  route: string | { light: string; dark: string };
}

export interface BrandLogo {
  light: string;
  dark: string;
}

const CACHE_PREFIX = "brand_logo_v2_";
const SVGL_API = "https://api.svgl.app";
const SIMPLE_ICONS_CDN = "https://cdn.simpleicons.org";
const SVGL_TITLES: Record<string, string> = { android: "Android", google: "Google" };
const pending = new Map<string, Promise<BrandLogo | null>>();

function slug(maker: string) {
  return maker.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function readCache(key: string): BrandLogo | null | undefined {
  try {
    const stored = localStorage.getItem(CACHE_PREFIX + key);
    if (stored === null) return undefined;
    return stored === "none" ? null : JSON.parse(stored);
  } catch {
    return undefined;
  }
}

function writeCache(key: string, logo: BrandLogo | null) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, logo ? JSON.stringify(logo) : "none");
  } catch { }
}

let catalogue: Promise<SvglEntry[]> | null = null;

function svglCatalogue(): Promise<SvglEntry[]> {
  if (!catalogue) {
    catalogue = fetch(SVGL_API)
      .then((res) => (res.ok ? res.json() : []))
      .then((entries) => (Array.isArray(entries) ? entries : []))
      .catch(() => {
        catalogue = null;
        return [];
      });
  }
  return catalogue;
}

async function fromSvgl(maker: string): Promise<BrandLogo | null> {
  const wanted = (SVGL_TITLES[slug(maker)] ?? maker).toLowerCase();
  const entries = await svglCatalogue();
  if (entries.length === 0) throw new Error("svgl is unreachable");
  const entry = entries.find((e) => e.title.toLowerCase() === wanted);
  if (!entry) return null;
  return typeof entry.route === "string" ? { light: entry.route, dark: entry.route } : { light: entry.route.light, dark: entry.route.dark };
}

async function fromSimpleIcons(maker: string): Promise<BrandLogo | null> {
  const url = `${SIMPLE_ICONS_CDN}/${slug(maker)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return { light: url, dark: `${url}/_/white` };
}

/** Finds a logo on svgl, then (for phone makers) Simple Icons, and remembers the answer. */
export function resolveBrandLogo(maker: string, svglOnly = false): Promise<BrandLogo | null> {
  const key = (svglOnly ? "svgl_" : "") + slug(maker);
  const cached = readCache(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const lookup = (async () => {
    try {
      const logo = (await fromSvgl(maker)) ?? (svglOnly ? null : await fromSimpleIcons(maker));
      writeCache(key, logo);
      return logo;
    } catch {
      return null;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, lookup);
  return lookup;
}

export function useBrandLogo(maker: string, svglOnly = false): BrandLogo | null {
  const [logo, setLogo] = useState<BrandLogo | null>(() => readCache((svglOnly ? "svgl_" : "") + slug(maker)) ?? null);
  useEffect(() => {
    let live = true;
    resolveBrandLogo(maker, svglOnly).then((found) => live && setLogo(found));
    return () => { live = false; };
  }, [maker, svglOnly]);
  return logo;
}
