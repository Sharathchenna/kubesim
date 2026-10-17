"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { complete } from "@/lib/kubectl/kubectl";
import type { SimStore } from "@/lib/sim/useSimulation";

/** How close to the bottom (px) still counts as "following" the output. */
const STICK_PX = 24;

/** A kubectl terminal: history (↑/↓), Tab completion, Ctrl+L to clear, Ctrl+C to stop streaming. */
export function Terminal({ sim, autoFocus }: { sim: SimStore; autoFocus?: boolean }) {
  const [line, setLine] = useState("");
  const [hi, setHi] = useState(-1);
  const [hint, setHint] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  /** Whether the Learner is at the bottom; if they scrolled up to read, new output doesn't yank them down. */
  const follow = useRef(true);
  const last = sim.term[sim.term.length - 1];
  const tail = `${sim.term.length}:${last?.id ?? 0}:${last?.out.length ?? 0}:${hint.length}`;

  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [tail]);
  // A command the Learner just ran always brings the prompt back into view.
  const lastCmdId = [...sim.term].reverse().find((t) => t.cmd !== undefined)?.id;
  useLayoutEffect(() => {
    follow.current = true;
    const el = scroll.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastCmdId]);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  // Screen readers hear each finished command's output once, not every streaming refresh.
  const announce = last && !last.live ? `${last.cmd ? `${last.cmd}: ` : ""}${last.out.slice(0, 400)}` : "";

  const history = sim.history;
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      sim.exec(line);
      setLine("");
      setHi(-1);
      setHint([]);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const i = hi < 0 ? history.length - 1 : Math.max(0, hi - 1);
      if (history[i] !== undefined) {
        setHi(i);
        setLine(history[i]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (hi < 0) return;
      const i = hi + 1;
      if (i >= history.length) {
        setHi(-1);
        setLine("");
      } else {
        setHi(i);
        setLine(history[i]);
      }
    } else if (e.key === "Tab") {
      e.preventDefault();
      const ctx = { cluster: sim.cluster!, namespace: sim.namespace, files: sim.files };
      const opts = complete(ctx, line);
      if (opts.length === 1) {
        setLine(line.replace(/\S*$/, opts[0]) + " ");
        setHint([]);
      } else if (opts.length > 1) {
        const pre = opts.reduce((a, b) => {
          let i = 0;
          while (i < a.length && a[i] === b[i]) i++;
          return a.slice(0, i);
        });
        setLine(line.replace(/\S*$/, pre));
        setHint(opts.slice(0, 12));
      }
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      sim.exec("clear");
    } else if (e.key === "c" && e.ctrlKey && !e.metaKey) {
      // With text selected, Ctrl+C copies as usual.
      const el = e.currentTarget;
      if (el.selectionStart !== el.selectionEnd || !window.getSelection()?.isCollapsed) return;
      e.preventDefault();
      if (!sim.stopWatch()) {
        setLine("");
        setHint([]);
      }
    }
  };

  return (
    <div className="flex h-full flex-col font-mono text-[12px] leading-relaxed" onClick={() => window.getSelection()?.isCollapsed && input.current?.focus()}>
      <div
        ref={scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
        }}
        className="min-h-0 flex-1 overflow-auto px-4 py-2"
        role="log"
        aria-label="Terminal output"
        aria-live="off"
        tabIndex={0}
      >
        {sim.term.length === 0 && (
          <div className="text-slate-500">
            Type a command and press Enter. Try <span className="text-slate-700">kubectl get pods</span> or <span className="text-slate-700">help</span>. Tab completes, ↑ recalls history.
          </div>
        )}
        {sim.term.map((t) => (
          <div key={t.id} className="mb-1.5">
            {t.cmd !== undefined && (
              <div>
                <span className="text-blue-600">{!t.ns || t.ns === "default" ? "" : `(${t.ns}) `}$</span> <span className="text-slate-900">{t.cmd}</span>
              </div>
            )}
            {t.out && <pre className={`whitespace-pre-wrap break-words ${t.ok ? "text-slate-600" : "text-red-600"}`}>{t.out}</pre>}
            {t.live && (
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-blue-600">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
                streaming… press Ctrl+C or
                <button onClick={() => sim.stopWatch()} className="rounded border border-slate-200 bg-white px-1.5 text-slate-600 hover:bg-slate-50">
                  stop
                </button>
              </div>
            )}
          </div>
        ))}
        {hint.length > 0 && <div className="text-slate-500">{hint.join("   ")}</div>}
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announce}
      </div>
      {/* The prompt row never shrinks: the output above scrolls instead, so the input stays fully on screen. */}
      <div className="flex shrink-0 items-center gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5 focus-within:bg-white focus-within:shadow-[inset_0_0_0_2px_rgba(37,99,235,.35)]">
        <span className="text-blue-600" aria-hidden="true">
          {sim.namespace === "default" ? "" : `(${sim.namespace}) `}$
        </span>
        <input
          ref={input}
          value={line}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-slate-900 outline-none placeholder:text-slate-500"
          placeholder="kubectl get pods"
          aria-label="Terminal input"
        />
      </div>
    </div>
  );
}
