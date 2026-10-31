"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { heptagon } from "@/lib/heptagon";
import { ThemeToggle } from "./ThemeToggle";

const NAV = [
  { href: "/learn", label: "Lessons" },
  { href: "/challenges", label: "Challenges" },
  { href: "/incidents", label: "Incidents" },
  { href: "/exams", label: "Exams" },
  { href: "/explainers", label: "Explainers" },
  { href: "/concepts", label: "Concepts" },
  { href: "/sandbox", label: "Sandbox" },
  { href: "/progress", label: "Progress" },
];

export function Logo() {
  return (
    <Link href="/" className="flex shrink-0 items-center gap-2.5">
      <svg viewBox="0 0 28 28" className="h-7 w-7" aria-hidden>
        <polygon points={heptagon(14, 14, 12)} fill="#326ce5" stroke="#326ce5" strokeWidth={2.5} strokeLinejoin="round" />
        <path d="M9.2 11.2l4.8-2.6 4.8 2.6v5.6L14 19.4l-4.8-2.6zM9.2 11.2l4.8 2.6 4.8-2.6M14 13.8v5.6" fill="none" stroke="#fff" strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight text-ink">kubesim</span>
    </Link>
  );
}

/** One step of the breadcrumb trail shown in place of the main nav on app screens. */
export interface Crumb {
  href?: string;
  label: string;
}

export function AppHeader({ center, right, sheet, trail }: {
  center?: React.ReactNode;
  right?: React.ReactNode;
  /** Sticky, for the home and index pages. */
  sheet?: boolean;
  /** App screens (lessons, sandbox…): show where you are instead of the full nav, which moves behind Menu. */
  trail?: Crumb[];
}) {
  const path = usePathname();
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("keydown", close);
    window.addEventListener("pointerdown", close);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("pointerdown", close);
    };
  }, [menu]);
  return (
    <header ref={ref} className={`font-sheet flex h-14 shrink-0 items-center gap-3 border-b border-ink/10 bg-paper px-3 sm:px-4 ${sheet ? "sticky top-0 z-40" : "relative z-40"}`}>
      <a
        href="#main"
        onClick={(e) => {
          // Focus the page's <main> (or its heading) rather than relying on an id per page.
          const main = document.querySelector<HTMLElement>("main") ?? document.querySelector<HTMLElement>("h1");
          if (!main) return;
          e.preventDefault();
          if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
          main.focus();
        }}
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-signal focus:px-3 focus:py-1.5 focus:text-[12px] focus:text-white"
      >
        Skip to content
      </a>
      <button onClick={() => setMenu(!menu)} className={`grid h-8 w-8 place-items-center text-ink hover:bg-ink/[0.05] ${trail ? "" : "lg:hidden"}`} aria-label="Menu" aria-expanded={menu}>
        <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="square">
          <path d={menu ? "M5 5l10 10M15 5L5 15" : "M3 6h14M3 10h14M3 14h14"} />
        </svg>
      </button>
      <Logo />
      {trail ? (
        <nav aria-label="Breadcrumb" className="ml-1 hidden min-w-0 items-center text-[14.5px] md:flex">
          <ol className="flex min-w-0 items-center">
            {trail.map((c, i) => (
              <li key={i} className="flex min-w-0 items-center">
                <span aria-hidden className="px-2 text-ink/25">/</span>
                {c.href ? (
                  <Link href={c.href} className="whitespace-nowrap text-ink-soft underline-offset-[5px] hover:text-ink hover:underline">
                    {c.label}
                  </Link>
                ) : (
                  <span aria-current="page" className="truncate text-ink">
                    {c.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : (
        <nav className="ml-3 hidden items-center gap-1 text-[14px] lg:flex" aria-label="Main">
          {NAV.map((n) => {
            const on = path.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} aria-current={on ? "page" : undefined} className={`rounded-lg px-2.5 py-1.5 transition-colors ${on ? "bg-signal-soft font-medium text-signal" : "text-ink-soft hover:bg-ink/[0.04] hover:text-ink"}`}>
                {n.label}
              </Link>
            );
          })}
        </nav>
      )}
      <div className="mx-auto flex min-w-0 items-center gap-2 sm:gap-3">{center}</div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <ThemeToggle className="hidden h-8 w-8 place-items-center rounded-md md:grid" />
        {right}
      </div>
      {menu && (
        <nav className={`float-card absolute top-[60px] z-50 flex flex-col p-2 ${trail ? "left-2 w-[calc(100%-1rem)] sm:w-64" : "inset-x-2 lg:hidden"}`} aria-label="Main">
          <Link href="/" onClick={() => setMenu(false)} className={`rounded-lg px-3 py-2.5 text-[15px] ${path === "/" ? "bg-signal-soft text-signal" : "text-ink-soft hover:bg-ink/[0.04] hover:text-ink"}`}>
            Home
          </Link>
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} onClick={() => setMenu(false)} className={`rounded-lg px-3 py-2.5 text-[15px] ${path.startsWith(n.href) ? "bg-signal-soft text-signal" : "text-ink-soft hover:bg-ink/[0.04] hover:text-ink"}`}>
              {n.label}
            </Link>
          ))}
          <ThemeToggle withLabel className="flex rounded-lg px-3 py-2.5 md:hidden" />
        </nav>
      )}
    </header>
  );
}
