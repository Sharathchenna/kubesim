import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[#f7f8fa]">
      <AppHeader />
      <main className="mx-auto max-w-xl px-6 pt-24 text-center">
        <div className="font-mono text-[13px] text-slate-400">Error from server (NotFound)</div>
        <h1 className="mt-3 text-[30px] font-semibold tracking-tight text-slate-900">This page doesn&apos;t exist</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-slate-500">Like a Pod that was never scheduled. Try one of these instead:</p>
        <div className="mt-8 flex justify-center gap-3">
          <Link href="/learn" className="inline-flex h-10 items-center rounded-xl bg-slate-900 px-4 text-[13.5px] font-medium text-white hover:bg-slate-800">
            Lessons
          </Link>
          <Link href="/sandbox" className="inline-flex h-10 items-center rounded-xl border border-slate-200 bg-white px-4 text-[13.5px] font-medium text-slate-700 hover:bg-slate-50">
            Sandbox
          </Link>
          <Link href="/" className="inline-flex h-10 items-center rounded-xl border border-slate-200 bg-white px-4 text-[13.5px] font-medium text-slate-700 hover:bg-slate-50">
            Home
          </Link>
        </div>
      </main>
    </div>
  );
}
