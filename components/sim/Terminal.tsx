"use client";

import { useEffect, useRef, useState } from "react";
import { complete } from "@/lib/kubectl/kubectl";
import type { SimStore } from "@/lib/sim/useSimulation";

/** A kubectl terminal: history (↑/↓), Tab completion, Ctrl+L to clear. */
export function Terminal({ sim, autoFocus }: { sim: SimStore; autoFocus?: boolean }) {
  const [line, setLine] = useState("");
  const [hi, setHi] = useState(-1);
  const [hint, setHint] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const n = sim.term.length;

  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [n, sim.version]);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

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
      const opts = complete({ cluster: sim.cluster!, namespace: sim.namespace }, line);
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
    } else if (e.key === "c" && e.ctrlKey) {
      e.preventDefault();
      if (!sim.stopWatch()) {
        setLine("");
        setHint([]);
      }
    }
  };

  return (
    <div className="flex h-full flex-col font-mono text-[12px] leading-relaxed" onClick={() => window.getSelection()?.isCollapsed && input.current?.focus()}>
      <div ref={scroll} className="min-h-0 flex-1 overflow-auto px-4 py-2">
        {sim.term.length === 0 && (
          <div className="text-slate-400">
            Type a command and press Enter. Try <span className="text-slate-700">kubectl get pods</span> or <span className="text-slate-700">help</span>. Tab completes, ↑ recalls history.
          </div>
        )}
        {sim.term.map((t) => (
          <div key={t.id} className="mb-1.5">
            {t.cmd !== undefined && (
              <div>
                <span className="text-blue-600">{sim.namespace === "default" ? "" : `(${sim.namespace}) `}$</span> <span className="text-slate-900">{t.cmd}</span>
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
        {hint.length > 0 && <div className="text-slate-400">{hint.join("   ")}</div>}
      </div>
      <div className="flex items-center gap-2 border-t border-slate-100 px-4 py-2">
        <span className="text-blue-600">$</span>
        <input
          ref={input}
          value={line}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-slate-900 outline-none placeholder:text-slate-300"
          placeholder="kubectl get pods"
          aria-label="Terminal input"
        />
      </div>
    </div>
  );
}
