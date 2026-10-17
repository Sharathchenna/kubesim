// The terminal's little shell: `&&`, `||` and `;` lists, `|` pipelines, `>`,
// `>>`, `2>`, `2>&1`, `&>` and `<` redirections, quoting the way POSIX sh does
// it, and the text tools people pipe kubectl into (grep, head, wc, awk…).
// Commands it doesn't own (kubectl, curl…) go through ShellEnv.exec.

/** One piece of output, on stdout (1) or stderr (2). `nl: false` is echo -n. */
export interface Chunk {
  fd: 1 | 2;
  text: string;
  nl?: boolean;
}

export interface Res {
  chunks: Chunk[];
  ok: boolean;
  /** A streaming command: the UI re-runs this line to refresh it. */
  watch?: string;
  /** Ask the UI to open this file in the Editor. */
  openFile?: string;
}

export interface ShellEnv {
  files: Record<string, string>;
  /** Runs a command the shell doesn't own. `text` is its source, for streaming re-runs. */
  exec(words: string[], stdin: string | undefined, text: string): Res | undefined;
}

export const out = (text: string, ok = true): Res => ({ chunks: text ? [{ fd: 1, text }] : [], ok });
export const err = (text: string): Res => ({ chunks: text ? [{ fd: 2, text }] : [], ok: false });

import { grepRegex } from "@/lib/engine";

class ShellSyntax extends Error {}

// ---------------------------------------------------------------- tokenizer

type Tok = { t: "word"; v: string; start: number; end: number } | { t: "op"; v: string; start: number; end: number };

const OPS = ["2>&1", "1>&2", "&>>", "2>>", "&&", "||", ">>", "&>", "2>", ">&2", "|", ";", ">", "<<", "<", "&"];

/** POSIX-ish word splitting with operators recognised outside quotes. */
export function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  let cur = "";
  let any = false;
  let start = -1;
  const flush = (end: number) => {
    if (cur || any) toks.push({ t: "word", v: cur, start, end });
    cur = "";
    any = false;
    start = -1;
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'" || ch === '"') {
      if (start < 0) start = i;
      any = true;
      const q = ch;
      i++;
      while (i < s.length && s[i] !== q) {
        if (q === '"' && s[i] === "$" && s[i + 1] === "(") throw new ShellSyntax("subst");
        if (q === '"' && s[i] === "`") throw new ShellSyntax("subst");
        // Inside double quotes a backslash only escapes $, `, ", \ and newline (POSIX sh); elsewhere it stays.
        if (q === '"' && s[i] === "\\" && i + 1 < s.length && '$`"\\\n'.includes(s[i + 1])) {
          cur += s[i + 1];
          i += 2;
          continue;
        }
        cur += s[i++];
      }
      if (i >= s.length) throw new ShellSyntax(`unexpected EOF while looking for matching \`${q}'`);
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      flush(i);
      i++;
      continue;
    }
    if (ch === "\\") {
      if (start < 0) start = i;
      if (i + 1 < s.length) cur += s[i + 1];
      i += 2;
      continue;
    }
    if ((ch === "$" && s[i + 1] === "(") || ch === "`") throw new ShellSyntax("subst");
    if (ch === "#" && !cur && !any) break;
    // "2>" is only an operator at the start of a word.
    const op = OPS.find((o) => s.startsWith(o, i) && (!/^[12]/.test(o) || (!cur && !any)));
    if (op) {
      flush(i);
      toks.push({ t: "op", v: op, start: i, end: i + op.length });
      i += op.length;
      continue;
    }
    if (start < 0) start = i;
    cur += ch;
    i++;
  }
  flush(s.length);
  return toks;
}

// ---------------------------------------------------------------- parser

interface Redirect {
  op: string;
  target?: string;
}
interface SimpleCmd {
  words: string[];
  redirects: Redirect[];
  text: string;
}
interface Pipeline {
  cmds: SimpleCmd[];
  text: string;
}
interface Statement {
  join: ";" | "&&" | "||";
  pipe: Pipeline;
}

function parse(line: string, toks: Tok[]): Statement[] {
  const stmts: Statement[] = [];
  let i = 0;
  let join: Statement["join"] = ";";
  const near = (t?: Tok) => `bash: syntax error near unexpected token \`${t ? t.v : "newline"}'`;
  while (i < toks.length) {
    const cmds: SimpleCmd[] = [];
    let pStart = toks[i].start;
    let pEnd = pStart;
    for (;;) {
      const words: string[] = [];
      const redirects: Redirect[] = [];
      const cStart = toks[i]?.start ?? line.length;
      let cEnd = cStart;
      while (i < toks.length) {
        const t = toks[i];
        if (t.t === "word") {
          words.push(t.v);
          cEnd = t.end;
          i++;
          continue;
        }
        if (["|", ";", "&&", "||"].includes(t.v)) break;
        if (t.v === "&") throw new ShellSyntax("The simulator's shell doesn't run background jobs (&). Run the command on its own.");
        if (t.v === "<<") throw new ShellSyntax("The simulator's shell doesn't support here-documents (<<). Write the YAML in the editor, or save it to a file and use -f FILE.");
        if (t.v === "2>&1" || t.v === "1>&2" || t.v === ">&2") {
          redirects.push({ op: t.v });
          cEnd = t.end;
          i++;
          continue;
        }
        const target = toks[i + 1];
        if (!target || target.t !== "word") throw new ShellSyntax(near(target));
        redirects.push({ op: t.v, target: target.v });
        cEnd = target.end;
        i += 2;
      }
      if (!words.length && !redirects.length) throw new ShellSyntax(near(toks[i]));
      cmds.push({ words, redirects, text: line.slice(cStart, cEnd).trim() });
      pEnd = cEnd;
      if (toks[i]?.v === "|") {
        i++;
        if (i >= toks.length) throw new ShellSyntax(near(undefined));
        continue;
      }
      break;
    }
    stmts.push({ join, pipe: { cmds, text: line.slice(pStart, pEnd).trim() } });
    const sep = toks[i];
    if (!sep) break;
    join = sep.v as Statement["join"];
    i++;
    if (i >= toks.length && sep.v !== ";") throw new ShellSyntax(near(undefined));
    pStart = toks[i]?.start ?? line.length;
  }
  return stmts;
}

// ---------------------------------------------------------------- execution

/** Text a chunk contributes to a file or pipe (programs end their output with a newline). */
const serialize = (cs: Chunk[]) => cs.map((c) => (c.nl === false || !c.text || c.text.endsWith("\n") ? c.text : c.text + "\n")).join("");

const fileName = (f: string) => f.replace(/^\.\//, "");

export function runLine(env: ShellEnv, line: string): Res {
  let stmts: Statement[];
  try {
    const toks = tokenize(line);
    if (!toks.length) return out("");
    stmts = parse(line, toks);
  } catch (e) {
    if (e instanceof ShellSyntax) {
      if (e.message === "subst") return err("The simulator's shell doesn't support command substitution ($(...) or backticks). Run the inner command first, then paste its output.");
      return err(e.message.startsWith("bash:") || e.message.startsWith("The ") ? e.message : `bash: ${e.message}`);
    }
    throw e;
  }
  const chunks: Chunk[] = [];
  let last: Res = { chunks: [], ok: true };
  for (let si = 0; si < stmts.length; si++) {
    const st = stmts[si];
    if ((st.join === "&&" && !last.ok) || (st.join === "||" && last.ok)) continue;
    last = runPipeline(env, st.pipe, si === stmts.length - 1);
    chunks.push(...last.chunks);
  }
  return { chunks, ok: last.ok, ...(last.watch ? { watch: last.watch } : {}), ...(last.openFile ? { openFile: last.openFile } : {}) };
}

function runPipeline(env: ShellEnv, p: Pipeline, lastStatement: boolean): Res {
  const term: Chunk[] = [];
  let stdin: string | undefined;
  let r: Res = { chunks: [], ok: true };
  let streamed = false;
  let redirected = false;
  for (let ci = 0; ci < p.cmds.length; ci++) {
    const c = p.cmds[ci];
    const isLast = ci === p.cmds.length - 1;
    let input = stdin;
    const inRedir = c.redirects.find((x) => x.op === "<");
    if (inRedir) {
      const f = fileName(inRedir.target!);
      if (env.files[f] === undefined) {
        term.push({ fd: 2, text: `bash: ${inRedir.target}: No such file or directory` });
        r = { chunks: [], ok: false };
        stdin = "";
        continue;
      }
      input = env.files[f];
    }
    r = runSimple(env, c.words, input, c.text);
    if (r.watch) streamed = true;
    // Route stdout/stderr through the redirections, left to right like sh.
    type Target = { kind: "term" | "pipe" | "null" } | { kind: "file"; name: string };
    let t1: Target = isLast ? { kind: "term" } : { kind: "pipe" };
    let t2: Target = { kind: "term" };
    const written = new Map<string, string>();
    for (const rd of c.redirects) {
      if (rd.op === "<") continue;
      if (rd.op === "2>&1") {
        t2 = t1;
        continue;
      }
      if (rd.op === "1>&2" || rd.op === ">&2") {
        t1 = t2;
        continue;
      }
      redirected = true;
      const name = fileName(rd.target!);
      const target: Target = name === "/dev/null" ? { kind: "null" } : name === "/dev/stdout" ? { kind: "term" } : name === "/dev/stderr" ? { kind: "term" } : { kind: "file", name };
      if (target.kind === "file") {
        const append = rd.op.endsWith(">>");
        // ">" truncates the file before the command runs, even if it writes nothing.
        written.set(name, append ? (env.files[name] ?? "") : "");
      }
      if (rd.op.startsWith("&")) t1 = t2 = target;
      else if (rd.op.startsWith("2")) t2 = target;
      else t1 = target;
    }
    let piped = "";
    for (const ch of r.chunks) {
      const t = ch.fd === 1 ? t1 : t2;
      if (t.kind === "term") term.push(ch);
      else if (t.kind === "pipe") piped += serialize([ch]);
      else if (t.kind === "file") written.set(t.name, written.get(t.name)! + serialize([ch]));
    }
    for (const [name, text] of written) env.files[name] = text;
    stdin = piped;
  }
  const watch = streamed && !redirected && lastStatement ? (p.cmds.length === 1 ? r.watch : p.text) : undefined;
  return { chunks: term, ok: r.ok, ...(watch ? { watch } : {}), ...(r.openFile ? { openFile: r.openFile } : {}) };
}

function runSimple(env: ShellEnv, words: string[], stdin: string | undefined, text: string): Res {
  if (!words.length) return out("");
  const builtin = BUILTINS[words[0]];
  if (builtin) return builtin(words.slice(1), stdin ?? "", env, text);
  const r = env.exec(words, stdin, text);
  if (r) return r;
  const hint = words[0].startsWith("kube") ? `\nDid you mean "kubectl"?` : "";
  return err(`bash: ${words[0]}: command not found${hint}\nTry "help" for what this terminal can do.`);
}

// ---------------------------------------------------------------- builtins and text tools

type Builtin = (args: string[], stdin: string, env: ShellEnv, text: string) => Res;

/** Text that came in on stdin going back out: its final newline is the line end, not content. */
const passthrough = (text: string): Res => ({ chunks: text ? [text.endsWith("\n") ? { fd: 1, text: text.slice(0, -1) } : { fd: 1, text, nl: false }] : [], ok: true });

const linesOf = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));
const joinLines = (ls: string[]) => ls.join("\n");

/** Short options as a set of letters, plus option values for the ones that take one. */
function opts(args: string[], valued: string): { set: Set<string>; vals: Record<string, string>; rest: string[]; missing?: string } {
  const set = new Set<string>();
  const vals: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (/^-\d+$/.test(a) && valued.includes("n")) {
      vals.n = a.slice(1);
      continue;
    }
    if (a.startsWith("-") && a.length > 1 && !a.startsWith("--")) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (valued.includes(ch)) {
          const v = a.slice(j + 1) || args[++i];
          if (v === undefined) return { set, vals, rest, missing: ch };
          vals[ch] = v;
          break;
        }
        set.add(ch);
      }
      continue;
    }
    rest.push(a);
  }
  return { set, vals, rest };
}

/** Input from file arguments, or stdin. */
function inputOf(tool: string, files: string[], stdin: string, env: ShellEnv): { text: string; error?: string } {
  if (!files.length) return { text: stdin };
  let text = "";
  for (const f of files) {
    const v = env.files[fileName(f)];
    if (v === undefined) return { text, error: `${tool}: ${f}: No such file or directory` };
    text += v.endsWith("\n") || !v ? v : v + "\n";
  }
  return { text };
}

function grep(args: string[], stdin: string, env: ShellEnv): Res {
  const o = opts(args, "em");
  if (o.missing) return err(`grep: option requires an argument -- '${o.missing}'\nUsage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.`);
  const rest = [...o.rest];
  const pat = o.vals.e ?? rest.shift();
  if (pat === undefined) return err("Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.");
  const input = inputOf("grep", rest, stdin, env);
  if (input.error) return err(input.error);
  const f = o.set;
  const base = grepRegex(pat, { extended: f.has("E"), fixed: f.has("F"), icase: f.has("i") });
  if (typeof base === "string") return err(`grep: ${base}`);
  // -w / -x wrap the already-compiled pattern, so user input never reaches new RegExp directly.
  const re = f.has("w") ? new RegExp(`(?<![\\w])(?:${base.source})(?![\\w])`, base.flags) : f.has("x") ? new RegExp(`^(?:${base.source})$`, base.flags) : base;
  let hits = linesOf(input.text)
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => re.test(l) !== f.has("v"));
  if (o.vals.m) hits = hits.slice(0, parseInt(o.vals.m, 10) || 0);
  if (f.has("q")) return { chunks: [], ok: hits.length > 0 };
  if (f.has("c")) return { chunks: [{ fd: 1, text: String(hits.length) }], ok: hits.length > 0 };
  const rows = f.has("o") && !f.has("v") ? hits.flatMap(({ l, i }) => [...l.matchAll(new RegExp(re.source, re.flags + "g"))].map((m) => ({ l: m[0], i }))) : hits;
  return { chunks: rows.length ? [{ fd: 1, text: joinLines(rows.map(({ l, i }) => (f.has("n") ? `${i + 1}:${l}` : l))) }] : [], ok: hits.length > 0 };
}

function headTail(tool: "head" | "tail"): Builtin {
  return (args, stdin, env) => {
    const o = opts(args, "nc");
    if (o.missing) return err(`${tool}: option requires an argument -- '${o.missing}'\nTry '${tool} --help' for more information.`);
    const input = inputOf(tool, o.rest, stdin, env);
    if (input.error) return err(`${tool}: cannot open '${o.rest[0]}' for reading: No such file or directory`);
    if (o.vals.c !== undefined) {
      if (!/^[+-]?\d+$/.test(o.vals.c)) return err(`${tool}: invalid number of bytes: '${o.vals.c}'`);
      const n = parseInt(o.vals.c, 10);
      return { chunks: [{ fd: 1, text: tool === "head" ? input.text.slice(0, n) : input.text.slice(-n || input.text.length), nl: false }], ok: true };
    }
    const raw = o.vals.n ?? "10";
    if (!/^[+-]?\d+$/.test(raw)) return err(`${tool}: invalid number of lines: '${raw}'`);
    const ls = linesOf(input.text);
    const n = Math.abs(parseInt(raw, 10));
    const pick = tool === "head" ? (raw.startsWith("-") ? ls.slice(0, Math.max(0, ls.length - n)) : ls.slice(0, n)) : raw.startsWith("+") ? ls.slice(Math.max(0, n - 1)) : n === 0 ? [] : ls.slice(-n);
    return out(joinLines(pick));
  };
}

function sortCmd(args: string[], stdin: string, env: ShellEnv): Res {
  const o = opts(args, "kt");
  const input = inputOf("sort", o.rest, stdin, env);
  if (input.error) return err(`sort: cannot read: ${o.rest[0]}: No such file or directory`);
  const field = o.vals.k ? parseInt(o.vals.k, 10) - 1 : -1;
  const key = (l: string) => (field < 0 ? l : ((o.vals.t ? l.split(o.vals.t) : l.trim().split(/\s+/))[field] ?? ""));
  let ls = [...linesOf(input.text)].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (o.set.has("n") || o.set.has("h")) return (parseFloat(x) || 0) - (parseFloat(y) || 0) || (x < y ? -1 : x > y ? 1 : 0);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  if (o.set.has("r")) ls.reverse();
  if (o.set.has("u")) ls = ls.filter((l, i) => i === 0 || l !== ls[i - 1]);
  return out(joinLines(ls));
}

function uniq(args: string[], stdin: string): Res {
  const o = opts(args, "");
  const groups: { l: string; n: number }[] = [];
  for (const l of linesOf(stdin)) {
    const g = groups[groups.length - 1];
    if (g && g.l === l) g.n++;
    else groups.push({ l, n: 1 });
  }
  const keep = groups.filter((g) => (o.set.has("d") ? g.n > 1 : o.set.has("u") ? g.n === 1 : true));
  return out(joinLines(keep.map((g) => (o.set.has("c") ? `${String(g.n).padStart(7)} ${g.l}` : g.l))));
}

function wc(args: string[], stdin: string, env: ShellEnv): Res {
  const o = opts(args, "");
  const input = inputOf("wc", o.rest, stdin, env);
  if (input.error) return err(input.error);
  const t = input.text;
  const n = { l: (t.match(/\n/g) ?? []).length, w: t.split(/\s+/).filter(Boolean).length, c: new TextEncoder().encode(t).length };
  const which = ["l", "w", "c"].filter((x) => o.set.has(x) || (x === "c" && o.set.has("m")));
  const cols = which.length ? which : ["l", "w", "c"];
  if (cols.length === 1) return out(String(n[cols[0] as "l"]));
  return out(cols.map((x) => String(n[x as "l"]).padStart(7)).join(" "));
}

/** tr SET1 SET2, tr -d SET: with a-z style ranges. */
function trCmd(args: string[], stdin: string): Res {
  const o = opts(args, "");
  const expand = (s = "") => s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/(.)-(.)/g, (_, a: string, b: string) => Array.from({ length: Math.max(0, b.charCodeAt(0) - a.charCodeAt(0) + 1) }, (_, i) => String.fromCharCode(a.charCodeAt(0) + i)).join(""));
  const a = expand(o.rest[0]);
  if (!o.rest[0]) return err("tr: missing operand\nTry 'tr --help' for more information.");
  if (o.set.has("d")) return passthrough([...stdin].filter((ch) => !a.includes(ch)).join(""));
  if (o.rest[1] === undefined) return err(`tr: missing operand after '${o.rest[0]}'\nTwo strings must be given when translating.\nTry 'tr --help' for more information.`);
  const b = expand(o.rest[1]);
  let res = [...stdin].map((ch) => (a.includes(ch) ? (b[a.indexOf(ch)] ?? b[b.length - 1] ?? "") : ch)).join("");
  if (o.set.has("s")) res = res.replace(new RegExp(`([${b.replace(/[\]\\^-]/g, "\\$&")}])\\1+`, "g"), "$1");
  return passthrough(res);
}

function cut(args: string[], stdin: string, env: ShellEnv): Res {
  const o = opts(args, "dfc");
  const input = inputOf("cut", o.rest, stdin, env);
  if (input.error) return err(input.error);
  const list = o.vals.f ?? o.vals.c;
  if (!list) return err("cut: you must specify a list of bytes, characters, or fields\nTry 'cut --help' for more information.");
  const want = (i: number) =>
    list.split(",").some((r) => {
      const [a, b] = r.split("-");
      if (b === undefined) return i === parseInt(a, 10);
      return i >= (a ? parseInt(a, 10) : 1) && i <= (b ? parseInt(b, 10) : Infinity);
    });
  const d = o.vals.d ?? "\t";
  return out(joinLines(linesOf(input.text).map((l) => (o.vals.c ? [...l].filter((_, i) => want(i + 1)).join("") : !l.includes(d) ? l : l.split(d).filter((_, i) => want(i + 1)).join(d)))));
}

function awk(args: string[], stdin: string, env: ShellEnv): Res {
  const o = opts(args, "F");
  const [prog, ...files] = o.rest;
  const m = (prog ?? "").match(/^\s*(?:NR\s*>\s*(\d+)\s*)?\{\s*print\s*(.*?)\s*;?\s*\}\s*$/);
  if (!m) return err("awk: the simulator's awk runs '{print $N, …}' programs (optionally NR>1 {print …}).");
  const input = inputOf("awk", files, stdin, env);
  if (input.error) return err(`awk: cannot open "${files[0]}" (No such file or directory)`);
  const after = m[1] ? parseInt(m[1], 10) : 0;
  const parts = m[2] ? m[2].match(/\$\d+|"[^"]*"|,/g) ?? [] : ["$0"];
  const sep = o.vals.F;
  return out(
    joinLines(
      linesOf(input.text)
        .filter((_, i) => i + 1 > after)
        .map((l) => {
          const fields = sep ? l.split(sep) : l.trim().split(/\s+/);
          // print $1, $2 joins with a space (OFS); adjacent items concatenate.
          return parts.map((p) => (p === "," ? " " : p.startsWith('"') ? p.slice(1, -1) : p === "$0" ? l : (fields[parseInt(p.slice(1), 10) - 1] ?? ""))).join("");
        }),
    ),
  );
}

function b64(args: string[], stdin: string): Res {
  const decode = args.includes("-d") || args.includes("--decode") || args.includes("-D");
  if (decode) {
    try {
      return { chunks: [{ fd: 1, text: decodeURIComponent(escape(atob(stdin.replace(/\s+/g, "")))), nl: false }], ok: true };
    } catch {
      return err("base64: invalid input");
    }
  }
  const enc = btoa(unescape(encodeURIComponent(stdin)));
  const wrap = args.some((a) => /^(-w0|--wrap=0)$/.test(a)) || (args.includes("-w") && args[args.indexOf("-w") + 1] === "0") ? enc : enc.replace(/(.{76})/g, "$1\n").replace(/\n$/, "");
  return out(wrap);
}

function echo(args: string[]): Res {
  let i = 0;
  let nl = true;
  let esc = false;
  while (i < args.length && /^-[neE]+$/.test(args[i])) {
    if (args[i].includes("n")) nl = false;
    if (args[i].includes("e")) esc = true;
    if (args[i].includes("E")) esc = false;
    i++;
  }
  let text = args.slice(i).join(" ");
  if (esc) text = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
  return { chunks: [{ fd: 1, text, nl }], ok: true };
}

const BUILTINS: Record<string, Builtin> = {
  echo: (a) => echo(a),
  ls: (_a, _s, env) => out(Object.keys(env.files).sort().join("  ")),
  cat: (args, stdin, env) => {
    const files = args.filter((a) => a !== "-" && !/^-[a-zA-Z]+$/.test(a));
    if (!files.length) return passthrough(stdin);
    const parts: Chunk[] = [];
    let ok = true;
    for (const f of files) {
      const v = env.files[fileName(f)];
      if (v === undefined) {
        parts.push({ fd: 2, text: `cat: ${f}: No such file or directory` });
        ok = false;
      } else parts.push({ fd: 1, text: v.replace(/\n$/, "") });
    }
    return { chunks: parts, ok };
  },
  rm: (args, _s, env) => {
    const force = args.some((a) => /^-[a-zA-Z]*f/.test(a));
    const files = args.filter((a) => !a.startsWith("-"));
    if (!files.length) return err("rm: missing operand\nTry 'rm --help' for more information.");
    for (const f of files) {
      if (env.files[fileName(f)] === undefined) {
        if (force) continue;
        return err(`rm: cannot remove '${f}': No such file or directory`);
      }
      delete env.files[fileName(f)];
    }
    return out("");
  },
  tee: (args, stdin, env) => {
    const append = args.includes("-a");
    for (const f of args.filter((a) => !a.startsWith("-"))) env.files[fileName(f)] = (append ? (env.files[fileName(f)] ?? "") : "") + stdin;
    return passthrough(stdin);
  },
  grep: (a, s, env) => grep(a, s, env),
  egrep: (a, s, env) => grep(["-E", ...a], s, env),
  head: headTail("head"),
  tail: headTail("tail"),
  wc: (a, s, env) => wc(a, s, env),
  sort: (a, s, env) => sortCmd(a, s, env),
  uniq: (a, s) => uniq(a, s),
  tr: (a, s) => trCmd(a, s),
  cut: (a, s, env) => cut(a, s, env),
  awk: (a, s, env) => awk(a, s, env),
  base64: (a, s) => b64(a, s),
  less: (_a, s) => passthrough(s),
  more: (_a, s) => passthrough(s),
  true: () => out(""),
  false: () => ({ chunks: [], ok: false }),
  jq: () => err("jq isn't in the simulator: use -o jsonpath='{...}' instead"),
  xargs: (args, stdin, env, text) => {
    const items = stdin.split(/\s+/).filter(Boolean);
    if (!args.length) return out(items.join(" "));
    if (!items.length) return out("");
    return runSimple(env, [...args, ...items], undefined, `${text.replace(/^xargs\s+/, "")} ${items.join(" ")}`);
  },
};

/** The commands the shell itself provides (for Tab completion and help). */
export const SHELL_BUILTINS = Object.keys(BUILTINS);
