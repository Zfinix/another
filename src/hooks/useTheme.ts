import { useState, useEffect } from "react";
import type { ThemePreference } from "../types";

function getInitialThemePreference(): ThemePreference {
  const stored = localStorage.getItem("theme");
  if (stored === "light" || stored === "dark" || stored === "auto") return stored;
  return "auto";
}

export function useTheme() {
  const [themePref, setThemePref] = useState<ThemePreference>(getInitialThemePreference);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);

  const theme = themePref === "auto" ? (systemDark ? "dark" : "light") : themePref;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("theme", themePref);
  }, [themePref]);

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
