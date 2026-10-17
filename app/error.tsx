"use client";

// Any page that throws while rendering lands here instead of on a blank screen.
// Simulator pages restore autosaved clusters on load, so a saved cluster that
// keeps crashing can be cleared from here.

import Link from "next/link";
import { useEffect } from "react";

/** Saved clusters (Sandbox, exam attempts); progress is kept. */
function clearSavedClusters() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith("kubesim.sandbox.") || /^kubesim\.exam\..*\.cluster\./.test(k)) localStorage.removeItem(k);
  } catch {
    // Storage unavailable.
  }
}

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error("kubesim: the page crashed", error);
  }, [error]);
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 text-center">
      <div className="font-mono text-[13px] text-slate-500">Error from kubesim (InternalError)</div>
      <h1 className="mt-3 text-[28px] font-semibold tracking-tight text-slate-900">The simulator hit a bug and stopped</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-slate-600">Nothing you typed caused this. Try again; if it keeps happening, start with a fresh cluster (your Lesson and exam progress is kept).</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <button onClick={() => retry()} className="inline-flex h-10 items-center rounded-xl bg-slate-900 px-4 text-[13.5px] font-medium text-white hover:bg-slate-800">
          Try again
        </button>
        <button
          onClick={() => {
            clearSavedClusters();
            window.location.reload();
          }}
          className="inline-flex h-10 items-center rounded-xl border border-slate-200 bg-white px-4 text-[13.5px] font-medium text-slate-700 hover:bg-slate-50"
        >
          Start with a fresh cluster
        </button>
        <Link href="/" className="inline-flex h-10 items-center rounded-xl border border-slate-200 bg-white px-4 text-[13.5px] font-medium text-slate-700 hover:bg-slate-50">
          Home
        </Link>
      </div>
    </main>
  );
}
