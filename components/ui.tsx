"use client";

import { heptagon } from "@/lib/heptagon";

export const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export type Tone = "default" | "primary" | "danger" | "ghost";

export function Btn({ children, onClick, tone = "default", disabled, title, className = "" }: { children: React.ReactNode; onClick: () => void; tone?: Tone; disabled?: boolean; title?: string; className?: string }) {
  const tones: Record<Tone, string> = {
    default: "border-ink/15 bg-paper text-ink hover:border-ink/30 hover:bg-ink/[0.03]",
    primary: "btn-primary border-transparent text-white",
    danger: "border-ink/15 bg-paper text-red-700 hover:border-red-300 hover:bg-red-50",
    ghost: "border-transparent bg-transparent text-ink-soft hover:bg-ink/[0.05] hover:text-ink",
  };
  return (
    <button type="button" title={title} disabled={disabled} onClick={onClick} className={`inline-flex h-8 items-center justify-center gap-1 rounded-lg border px-3 text-[13px] font-medium transition-colors disabled:opacity-40 ${tones[tone]} ${className}`}>
      {children}
    </button>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-ink/10 bg-paper ${className}`}>{children}</div>;
}

export function Heading({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between">
      <h3 className="text-[13px] font-medium text-ink-soft">{children}</h3>
      {right}
    </div>
  );
}

export function Dot({ color }: { color: string }) {
  return <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />;
}

export const CAT_COLOR = { ok: "#16a34a", bad: "#dc2626", starting: "#d97706", gone: "#9ca3af", done: "#6b7280", stale: "#9ca3af" } as const;

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: React.ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex h-full items-stretch gap-3">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)} className={`whitespace-nowrap border-b-2 px-0.5 text-[13.5px] transition-colors ${value === o.value ? "border-signal font-medium text-ink" : "border-transparent text-ink-soft hover:text-ink"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}


export const inputCls = "h-8 rounded-lg border border-ink/15 bg-paper px-2.5 text-[12.5px] text-ink outline-none transition focus:border-signal";

/** A step's number in a small heptagon: filled with a tick when done, outlined in blue when it is the current one. */
export function StepMark({ n, state, size = 24 }: { n: number; state: "done" | "current" | "todo"; size?: number }) {
  const c = size / 2;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="shrink-0" aria-hidden>
      <polygon
        points={heptagon(c, c, c - 2)}
        fill={state === "done" ? "var(--color-signal)" : state === "current" ? "var(--color-signal-soft)" : "var(--color-paper)"}
        stroke={state === "todo" ? "var(--ill-line)" : "var(--color-signal)"}
        strokeWidth={state === "done" ? 2.5 : 1.4}
        strokeLinejoin="round"
      />
      {state === "done" ? (
        <path d={`M${c - 4.2},${c + 0.2} l2.8,2.8 l5.4,-5.6`} fill="none" stroke="#fff" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <text x={c} y={c + 3.8} textAnchor="middle" fontSize={size * 0.44} fontWeight={600} fill={state === "current" ? "var(--color-signal)" : "var(--color-ink-soft)"} fontFamily="var(--font-geist-mono), monospace">
          {n}
        </text>
      )}
    </svg>
  );
}
