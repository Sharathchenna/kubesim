"use client";

export const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export type Tone = "default" | "primary" | "danger" | "ghost";

export function Btn({ children, onClick, tone = "default", disabled, title, className = "" }: { children: React.ReactNode; onClick: () => void; tone?: Tone; disabled?: boolean; title?: string; className?: string }) {
  const tones: Record<Tone, string> = {
    default: "border-slate-200 bg-white text-slate-700 shadow-[0_1px_1px_rgba(15,23,42,.04)] hover:border-slate-300 hover:bg-slate-50",
    primary: "border-slate-900 bg-slate-900 text-white shadow-[0_1px_2px_rgba(15,23,42,.2)] hover:bg-slate-800",
    danger: "border-slate-200 bg-white text-red-600 shadow-[0_1px_1px_rgba(15,23,42,.04)] hover:border-red-200 hover:bg-red-50",
    ghost: "border-transparent bg-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800",
  };
  return (
    <button type="button" title={title} disabled={disabled} onClick={onClick} className={`inline-flex h-7 items-center justify-center gap-1 rounded-lg border px-2.5 text-[12px] font-medium transition-colors disabled:opacity-40 ${tones[tone]} ${className}`}>
      {children}
    </button>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,.04)] ${className}`}>{children}</div>;
}

export function Heading({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">{children}</h3>
      {right}
    </div>
  );
}

export function Dot({ color }: { color: string }) {
  return <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />;
}

export const CAT_COLOR = { ok: "#16a34a", bad: "#dc2626", starting: "#f59e0b", gone: "#94a3b8", done: "#64748b", stale: "#94a3b8" } as const;

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: React.ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-lg bg-slate-100 p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)} className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition ${value === o.value ? "bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,.1)]" : "text-slate-500 hover:text-slate-800"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}


export const inputCls = "h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-800 shadow-[0_1px_1px_rgba(15,23,42,.03)] outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5";
