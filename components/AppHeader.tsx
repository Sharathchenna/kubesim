"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const NAV = [
  { href: "/learn", label: "Lessons" },
  { href: "/challenges", label: "Challenges" },
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
        <path d="M14 2.5l10 5.75v11.5L14 25.5 4 19.75V8.25L14 2.5z" fill="#172340" />
        <path d="M14 8l5.2 3v6L14 20l-5.2-3v-6L14 8z" fill="none" stroke="#fff" strokeWidth={1.5} strokeLinejoin="round" />
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
    <header ref={ref} className={`font-sheet flex h-14 shrink-0 items-center gap-3 border-b-[1.5px] border-ink bg-paper px-3 sm:px-4 ${sheet ? "sticky top-0 z-40" : "relative z-40"}`}>
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
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-ink focus:px-3 focus:py-1.5 focus:text-[12px] focus:text-white"
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
                <span aria-hidden className="px-2 text-ink/30">/</span>
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
        <nav className="ml-2 hidden items-center gap-4 text-[14.5px] lg:flex" aria-label="Main">
          {NAV.map((n) => {
            const on = path.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} aria-current={on ? "page" : undefined} className={`px-1 py-1 underline-offset-[6px] decoration-[1.5px] ${on ? "text-ink underline" : "text-ink-soft hover:text-ink hover:underline"}`}>
                {n.label}
              </Link>
            );
          })}
        </nav>
      )}
      <div className="mx-auto flex min-w-0 items-center gap-2 sm:gap-3">{center}</div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">{right}</div>
      {menu && (
        <nav className={`absolute top-14 z-50 flex flex-col border-b-[1.5px] border-ink bg-paper p-2 ${trail ? "left-0 w-full border-r-[1.5px] sm:w-64" : "inset-x-0 lg:hidden"}`} aria-label="Main">
          <Link href="/" onClick={() => setMenu(false)} className={`px-3 py-2.5 text-[15px] ${path === "/" ? "text-ink underline underline-offset-4" : "text-ink-soft hover:text-ink"}`}>
            Home
          </Link>
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} onClick={() => setMenu(false)} className={`px-3 py-2.5 text-[15px] ${path.startsWith(n.href) ? "text-ink underline underline-offset-4" : "text-ink-soft hover:text-ink"}`}>
              {n.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
