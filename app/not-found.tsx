import Link from "next/link";
import type { Metadata } from "next";
import { AppHeader } from "@/components/AppHeader";

export const metadata: Metadata = { title: "Page not found · kubesim", robots: { index: false, follow: true } };

export default function NotFound() {
  return (
    <div className="font-sheet min-h-screen bg-paper text-ink">
      <AppHeader sheet />
      <main className="mx-auto max-w-xl px-6 pt-24 text-center">
        <div className="font-mono text-[13px] text-ink-soft">Error from server (NotFound)</div>
        <h1 className="font-display mt-3 text-[36px] leading-tight">This page doesn&apos;t exist</h1>
        <p className="mt-3 text-[16px] leading-relaxed text-ink-soft">Like a Pod that was never scheduled. Try one of these instead:</p>
        <div className="mt-8 flex justify-center gap-3">
          <Link href="/learn" className="inline-flex h-10 items-center border-[1.5px] border-ink bg-ink px-4 text-[15px] text-paper hover:border-signal hover:bg-signal">
            Lessons
          </Link>
          <Link href="/sandbox" className="inline-flex h-10 items-center border-[1.5px] border-ink px-4 text-[15px] hover:bg-ink/5">
            Sandbox
          </Link>
          <Link href="/" className="inline-flex h-10 items-center border-[1.5px] border-ink px-4 text-[15px] hover:bg-ink/5">
            Home
          </Link>
        </div>
      </main>
    </div>
  );
}
