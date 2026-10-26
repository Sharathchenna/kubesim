"use client";

export const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export type Tone = "default" | "primary" | "danger" | "ghost";

export function Btn({ children, onClick, tone = "default", disabled, title, className = "" }: { children: React.ReactNode; onClick: () => void; tone?: Tone; disabled?: boolean; title?: string; className?: string }) {
  const tones: Record<Tone, string> = {
    default: "border-ink/30 bg-paper text-ink hover:border-ink",
    primary: "border-ink bg-ink text-paper hover:bg-ink/90",
    danger: "border-ink/30 bg-paper text-red-700 hover:border-red-700",
    ghost: "border-transparent bg-transparent text-ink-soft hover:bg-ink/[0.05] hover:text-ink",
  };
  return (
    <button type="button" title={title} disabled={disabled} onClick={onClick} className={`inline-flex h-7 items-center justify-center gap-1 border px-2.5 text-[12.5px] transition-colors disabled:opacity-40 ${tones[tone]} ${className}`}>
      {children}
    </button>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`border border-ink/20 bg-paper ${className}`}>{children}</div>;
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

export const CAT_COLOR = { ok: "#15803d", bad: "#b91c1c", starting: "#b45309", gone: "#8a93a6", done: "#5a6680", stale: "#8a93a6" } as const;

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: React.ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex h-full items-stretch gap-4">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)} className={`whitespace-nowrap border-b-2 px-0.5 text-[13.5px] transition-colors ${value === o.value ? "border-ink text-ink" : "border-transparent text-ink-soft hover:text-ink"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}


export const inputCls = "h-8 border border-ink/30 bg-paper px-2.5 text-[12.5px] text-ink outline-none transition focus:border-ink";
