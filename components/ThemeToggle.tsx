"use client";

// Light / dark switch. The choice is saved; with none saved the site follows the system setting.
// The class on <html> is set before first paint by the script in app/layout.tsx, so there's no flash.

import { useSyncExternalStore } from "react";

export const THEME_KEY = "kubesim.theme";
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useDark(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );
}

export function setDark(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
  try {
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  listeners.forEach((fn) => fn());
}

export function ThemeToggle({ className = "", withLabel = false }: { className?: string; withLabel?: boolean }) {
  const dark = useDark();
  const label = dark ? "Light mode" : "Dark mode";
  return (
    <button type="button" onClick={() => setDark(!dark)} aria-label={label} title={label} className={`items-center gap-2.5 text-ink hover:bg-ink/[0.05] ${className}`}>
      <svg viewBox="0 0 20 20" className="h-[18px] w-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
        {dark ? (
          <>
            <circle cx="10" cy="10" r="3.6" />
            <path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M4.7 15.3L6 14M14 6l1.3-1.3" />
          </>
        ) : (
          <path d="M16.2 12.3A6.6 6.6 0 0 1 7.7 3.8a6.6 6.6 0 1 0 8.5 8.5z" />
        )}
      </svg>
      {withLabel && <span className="text-[15px] text-ink-soft">{label}</span>}
    </button>
  );
}
