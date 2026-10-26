"use client";

// Renders the tiny markdown used in Lessons: paragraphs, **bold**, `code`,
// and fenced ```bash / ```yaml blocks with Run / Open-in-editor buttons.

import { Fragment } from "react";
import { Illustration } from "../illustrations/Illustration";
import { SCENES } from "../illustrations/scenes";

function inline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**")) return <strong key={i} className="font-semibold text-ink">{p.slice(2, -2)}</strong>;
    if (p.startsWith("`")) return <code key={i} className="bg-ink/[0.05] px-1 font-mono text-[0.9em] text-ink">{p.slice(1, -1)}</code>;
    return <Fragment key={i}>{p}</Fragment>;
  });
}

export function Prose({ text, onRun, onEdit }: { text: string; onRun?: (cmd: string) => void; onEdit?: (yaml: string) => void }) {
  const blocks: { kind: "p" | "bash" | "yaml" | "illustration"; text: string }[] = [];
  const re = /```(\w+)(?: ([\w-]+))?\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    for (const para of text.slice(last, m.index).split(/\n\n+/)) if (para.trim()) blocks.push({ kind: "p", text: para.trim() });
    blocks.push(m[1] === "illustration" ? { kind: "illustration", text: m[2] } : { kind: m[1] === "yaml" ? "yaml" : "bash", text: m[3].replace(/\n$/, "") });
    last = re.lastIndex;
  }
  for (const para of text.slice(last).split(/\n\n+/)) if (para.trim()) blocks.push({ kind: "p", text: para.trim() });

  return (
    <div className="flex flex-col gap-3 text-[13.5px] leading-relaxed text-ink/85">
      {blocks.map((b, i) =>
        b.kind === "p" ? (
          <p key={i}>{inline(b.text)}</p>
        ) : b.kind === "illustration" ? (
          SCENES[b.text] ? <Illustration key={i} scene={SCENES[b.text]} /> : null
        ) : b.kind === "bash" ? (
          <div key={i} className="border border-ink/20 bg-ink/[0.03]">
            {b.text.split("\n").map((line, j) => (
              <div key={j} className="group flex items-center gap-2 border-t border-ink/15 px-3 py-1.5 first:border-0">
                <span className="select-none font-mono text-[12px] text-ink/30">$</span>
                <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-ink">{line}</code>
                {onRun && !line.includes("<") && (
                  <button onClick={() => onRun(line)} className="shrink-0 border border-ink/30 bg-paper px-2 py-0.5 text-[11.5px] text-ink transition-colors hover:border-ink">
                    Run
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div key={i} className="border border-ink/20 bg-ink/[0.03]">
            <div className="flex items-center justify-between border-b border-ink/15 px-3 py-1">
              <span className="font-mono text-[11px] text-ink-soft">yaml</span>
              {onEdit && (
                <button onClick={() => onEdit(b.text + "\n")} className="border border-ink/30 bg-paper px-2 py-0.5 text-[11.5px] text-ink transition-colors hover:border-ink">
                  Open in editor
                </button>
              )}
            </div>
            <pre className="overflow-x-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink">{b.text}</pre>
          </div>
        ),
      )}
    </div>
  );
}
