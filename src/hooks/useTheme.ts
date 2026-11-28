import { useState, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ThemePreference } from "../types";
import { onStored, store } from "@/lib/sync";

const THEME_FADE_MS = 360;

function getInitialThemePreference(): ThemePreference {
  const stored = localStorage.getItem("theme");
  if (stored === "light" || stored === "dark" || stored === "auto") return stored;
  return "auto";
}

export function useTheme() {
  const [themePref, setThemePref] = useState<ThemePreference>(getInitialThemePreference);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);

  const theme = themePref === "auto" ? (systemDark ? "dark" : "light") : themePref;

  const firstPaint = useRef(true);

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      root.setAttribute("data-theme", theme);
      root.classList.toggle("dark", theme === "dark");
      root.classList.toggle("t-dark", theme === "dark");
      root.classList.toggle("t-light", theme === "light");
    };
    const animate = !firstPaint.current && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    firstPaint.current = false;
    if (!animate) {
      apply();
      return;
    }
    if (document.startViewTransition) {
      document.startViewTransition(apply);
      return;
    }
    root.classList.add("theme-fade");
    apply();
    const timer = setTimeout(() => root.classList.remove("theme-fade"), THEME_FADE_MS);
    return () => clearTimeout(timer);
  }, [theme]);

  useEffect(() => {
    getCurrentWindow().setTheme(themePref === "auto" ? null : themePref).catch(() => { });
  }, [themePref]);

  useEffect(() => {
    if (localStorage.getItem("theme") !== themePref) store("theme", themePref);
  }, [themePref]);

  useEffect(() => onStored("theme", (value) => {
    if (value === "light" || value === "dark" || value === "auto") setThemePref(value);
  }), []);

  useEffect(() => {
    if (themePref !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => setSystemDark(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [themePref]);

  const cycleTheme = () => {
    setThemePref((p) => p === "light" ? "dark" : p === "dark" ? "auto" : "light");
  };

  return { theme, themePref, setThemePref, cycleTheme };
}
