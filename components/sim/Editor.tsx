"use client";

import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { yaml } from "@codemirror/lang-yaml";
import { tags as t } from "@lezer/highlight";
import type { SimStore } from "@/lib/sim/useSimulation";
import { Btn } from "../ui";

const highlight = HighlightStyle.define([
  { tag: t.propertyName, color: "#1d4ed8" },
  { tag: [t.string, t.content], color: "#0f766e" },
  { tag: [t.number, t.bool, t.null], color: "#b45309" },
  { tag: t.comment, color: "#94a3b8", fontStyle: "italic" },
  { tag: [t.punctuation, t.separator], color: "#94a3b8" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "#fff" },
  ".cm-scroller": { fontFamily: "var(--font-geist-mono), ui-monospace, monospace", lineHeight: "1.65" },
  ".cm-gutters": { backgroundColor: "#fff", border: "none", color: "#cbd5e1" },
  ".cm-activeLine": { backgroundColor: "#f8fafc" },
  ".cm-activeLineGutter": { backgroundColor: "#f8fafc", color: "#64748b" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "#0f172a" },
});

/** A YAML editor over the Learner's virtual files, with Apply. */
export function Editor({ sim }: { sim: SimStore }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const file = sim.editorFile;
  const seq = sim.editSeq;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: sim.files[sim.editorFile] ?? "",
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          indentOnInput(),
          yaml(),
          syntaxHighlighting(highlight),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab, { key: "Mod-Enter", run: (ev) => (sim.apply(ev.state.doc.toString()), true) }]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) sim.files[sim.editorFile] = u.state.doc.toString();
          }),
          theme,
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the file whenever another one is opened (or re-opened with new contents).
  useEffect(() => {
    const v = view.current;
    const text = sim.files[file] ?? "";
    if (v && v.state.doc.toString() !== text) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, seq]);

  const last = [...sim.term].reverse().find((x) => x.cmd?.startsWith("kubectl apply -f"));
  const names = Object.keys(sim.files).sort();

  return (
    <div className="flex h-full flex-col md:flex-row">
      <div ref={host} className="min-h-0 min-w-0 flex-1 overflow-hidden border-slate-100 md:border-r" />
      <div className="flex shrink-0 flex-col gap-2 border-t border-slate-100 p-3 md:w-64 md:border-t-0">
        <select value={file} onChange={(e) => sim.openFile(e.target.value)} className="h-7 rounded-lg border border-slate-200 bg-white px-1.5 font-mono text-[11.5px] text-slate-700" aria-label="File">
          {names.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <Btn tone="primary" onClick={() => view.current && sim.apply(view.current.state.doc.toString())}>
          kubectl apply -f {file}
        </Btn>
        <div className="hidden text-[11px] text-slate-400 md:block">⌘/Ctrl + Enter also applies. Files are shared with the terminal: try ls, cat, and kubectl get … -o yaml &gt; file.yaml</div>
        {last && <pre className={`mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border p-2 font-mono text-[11px] leading-snug ${last.ok ? "border-slate-200 bg-slate-50 text-slate-600" : "border-red-100 bg-red-50 text-red-700"}`}>{last.out}</pre>}
      </div>
    </div>
  );
}
