"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

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
        <path d="M14 2.5l10 5.75v11.5L14 25.5 4 19.75V8.25L14 2.5z" fill="#0f172a" />
        <path d="M14 8l5.2 3v6L14 20l-5.2-3v-6L14 8z" fill="none" stroke="#fff" strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight text-slate-900">kubesim</span>
    </Link>
  );
}

export function AppHeader({ center, right, glass }: { center?: React.ReactNode; right?: React.ReactNode; /** See-through and sticky, for marketing pages. */ glass?: boolean }) {
  const path = usePathname();
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menu]);
  return (
    <header className={`flex h-14 shrink-0 items-center gap-3 border-b px-3 sm:px-4 ${glass ? "sticky top-0 z-40 border-slate-200/60 bg-[#f7f8fa]/70 backdrop-blur-xl backdrop-saturate-150" : "relative border-slate-200/80 bg-white"}`}>
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
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-slate-900 focus:px-3 focus:py-1.5 focus:text-[12px] focus:text-white"
      >
        Skip to content
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
