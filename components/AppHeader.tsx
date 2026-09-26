"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const NAV = [
  { href: "/learn", label: "Lessons" },
  { href: "/explainers", label: "Explainers" },
  { href: "/concepts", label: "Concepts" },
  { href: "/sandbox", label: "Sandbox" },
];

export function Logo() {
  return (
    <Link href="/" className="flex shrink-0 items-center gap-2.5">
      <svg viewBox="0 0 28 28" className="h-7 w-7" aria-hidden>
        <path d="M14 2.5l10 5.75v11.5L14 25.5 4 19.75V8.25L14 2.5z" fill="#0f172a" />
        <path d="M14 8l5.2 3v6L14 20l-5.2-3v-6L14 8z" fill="none" stroke="#fff" strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight text-slate-900">kubesim</span>
    </Link>
  );
}

export function AppHeader({ center, right }: { center?: React.ReactNode; right?: React.ReactNode }) {
  const path = usePathname();
  const [menu, setMenu] = useState(false);
  return (
    <header className="relative flex h-14 shrink-0 items-center gap-3 border-b border-slate-200/80 bg-white px-3 sm:px-4">
      <a href="#dock-panel" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-slate-900 focus:px-3 focus:py-1.5 focus:text-[12px] focus:text-white">
        Skip to terminal
      </a>
      <button onClick={() => setMenu(!menu)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-600 hover:bg-slate-100 lg:hidden" aria-label="Menu" aria-expanded={menu}>
        <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
          <path d={menu ? "M5 5l10 10M15 5L5 15" : "M3 6h14M3 10h14M3 14h14"} />
        </svg>
      </button>
      <Logo />
      <nav className="ml-2 hidden items-center gap-1 text-[13px] lg:flex" aria-label="Main">
        {NAV.map((n) => {
          const on = path.startsWith(n.href);
          return (
            <Link key={n.href} href={n.href} aria-current={on ? "page" : undefined} className={`rounded-md px-2.5 py-1 font-medium transition ${on ? "bg-slate-100 text-slate-900" : "text-slate-500 hover:text-slate-900"}`}>
              {n.label}
            </Link>
          );
        })}
      </nav>
      <div className="mx-auto flex min-w-0 items-center gap-2 sm:gap-3">{center}</div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">{right}</div>
      {menu && (
        <nav className="absolute inset-x-0 top-14 z-50 flex flex-col border-b border-slate-200 bg-white p-2 shadow-lg lg:hidden" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} onClick={() => setMenu(false)} className={`rounded-lg px-3 py-2.5 text-[14px] font-medium ${path.startsWith(n.href) ? "bg-slate-100 text-slate-900" : "text-slate-600"}`}>
              {n.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
