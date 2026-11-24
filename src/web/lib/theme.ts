import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";

// index.html reads the same key before the first paint, so the page never opens in the wrong look.
const KEY = "progress:theme";
/** The browser's own bar takes the colour of the app's bar. */
const BAR: Record<Theme, string> = { light: "#fbfcfc", dark: "#141517" };
const system = matchMedia("(prefers-color-scheme: light)");
const listeners = new Set<() => void>();

const systemTheme = (): Theme => (system.matches ? "light" : "dark");

/** The look picked in this browser, or null while it follows the system. */
function picked(): Theme | null {
  const stored = localStorage.getItem(KEY);
  return stored === "light" || stored === "dark" ? stored : null;
}

const current = (): Theme => picked() ?? systemTheme();

function apply() {
  const theme = current();
  document.documentElement.dataset.theme = theme;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = BAR[theme];
  for (const listener of listeners) listener();
}

// The system changing its look, or another tab picking one, reaches this tab too.
system.addEventListener("change", apply);
window.addEventListener("storage", (event) => {
  if (event.key === KEY) apply();
});
apply();

/** Switches to the other look. Back on the system's own look, the pick is dropped, so the page follows the system again. */
function toggle() {
  const next: Theme = current() === "dark" ? "light" : "dark";
  if (next === systemTheme()) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, next);
  apply();
}

export function useTheme(): readonly [Theme, () => void] {
  const theme = useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, current);
  return [theme, toggle];
}
