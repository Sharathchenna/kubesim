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
    <main className="font-sheet mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 text-center">
      <div className="font-mono text-[13px] text-ink-soft">Error from kubesim (InternalError)</div>
      <h1 className="font-display mt-3 text-[34px] leading-tight text-ink">The simulator hit a bug and stopped</h1>
      <p className="mt-3 text-[16px] leading-relaxed text-ink-soft">Nothing you typed caused this. Try again; if it keeps happening, start with a fresh cluster (your Lesson and exam progress is kept).</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <button onClick={() => retry()} className="inline-flex h-10 items-center border-[1.5px] border-ink bg-ink px-4 text-[15px] text-paper hover:border-signal hover:bg-signal">
          Try again
        </button>
        <button
          onClick={() => {
            clearSavedClusters();
            window.location.reload();
          }}
          className="inline-flex h-10 items-center border-[1.5px] border-ink px-4 text-[15px] text-ink hover:bg-ink/5"
        >
          Start with a fresh cluster
        </button>
        <Link href="/" className="inline-flex h-10 items-center border-[1.5px] border-ink px-4 text-[15px] text-ink hover:bg-ink/5">
          Home
        </Link>
      </div>
    </main>
  );
}
