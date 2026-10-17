// kubectl's JSONPath dialect (k8s.io/client-go/util/jsonpath): {.a.b},
// [n], [*], [a:b], .., filters [?(@.x=="y")], {range …}{end}, "literals",
// and $ for the root. Used by `-o jsonpath=` and `-o custom-columns=`.

type Value = unknown;

type Seg =
  | { t: "field"; name: string }
  | { t: "index"; i: number }
  | { t: "slice"; a?: number; b?: number }
  | { t: "all" }
  | { t: "recurse"; name: string }
  | { t: "filter"; path: Seg[]; op?: string; value?: string | number | boolean };

export class JsonPathError extends Error {}

function parsePath(src: string): Seg[] {
  let s = src.trim();
  // $ is the root and @ the current object; both are where evaluation starts anyway.
  if (s.startsWith("$") || s.startsWith("@")) s = s.slice(1);
  const segs: Seg[] = [];
  let i = 0;
  const ident = () => {
    // Keys may contain escaped dots: {.data.app\.properties}
    const m = s.slice(i).match(/^(?:[A-Za-z0-9_\-$/]|\\\.)+/);
    if (!m) return "";
    i += m[0].length;
    return m[0].replace(/\\\./g, ".");
  };
  while (i < s.length) {
    if (s.startsWith("..", i)) {
      i += 2;
      segs.push({ t: "recurse", name: s[i] === "*" ? (i++, "*") : ident() });
    } else if (s[i] === ".") {
      i++;
      if (s[i] === "*") {
        i++;
        segs.push({ t: "all" });
      } else {
        const name = ident();
        if (name) segs.push({ t: "field", name });
      }
    } else if (s[i] === "[") {
      const end = matchBracket(s, i);
      const inner = s.slice(i + 1, end).trim();
      i = end + 1;
      if (inner === "*") segs.push({ t: "all" });
      else if (/^-?\d+$/.test(inner)) segs.push({ t: "index", i: parseInt(inner, 10) });
      else if (/^-?\d*:-?\d*$/.test(inner)) {
        const [a, b] = inner.split(":");
        segs.push({ t: "slice", a: a ? parseInt(a, 10) : undefined, b: b ? parseInt(b, 10) : undefined });
      } else if (/^['"].*['"]$/.test(inner)) segs.push({ t: "field", name: inner.slice(1, -1) });
      else if (inner.startsWith("?(")) {
        const body = inner.slice(2, -1).trim();
        const m = body.match(/^@(\S*?)\s*(==|!=|<=|>=|<|>)\s*(.+)$/);
        if (m) {
          const raw = m[3].trim();
          const value = /^['"].*['"]$/.test(raw) ? raw.slice(1, -1) : raw === "true" ? true : raw === "false" ? false : Number(raw);
          segs.push({ t: "filter", path: parsePath(m[1]), op: m[2], value });
        } else if (body.startsWith("@")) segs.push({ t: "filter", path: parsePath(body.slice(1)) });
        else throw new JsonPathError(`error parsing jsonpath ${src}, unrecognized filter ${body}`);
      } else throw new JsonPathError(`error parsing jsonpath ${src}, invalid array index ${inner}`);
    } else if (/\s/.test(s[i])) i++;
    else {
      const name = ident();
      if (!name) throw new JsonPathError(`error parsing jsonpath ${src}, unrecognized character in action: U+${s.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")} '${s[i]}'`);
      segs.push({ t: "field", name });
    }
  }
  return segs;
}

function matchBracket(s: string, at: number): number {
  let depth = 0;
  let q: string | null = null;
  for (let i = at; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') q = c;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i;
  }
  throw new JsonPathError(`error parsing jsonpath ${s}, unclosed array expect ]`);
}

function step(values: Value[], seg: Seg): Value[] {
  const out: Value[] = [];
  for (const v of values) {
    if (v === null || v === undefined) continue;
    switch (seg.t) {
      case "field":
        if (typeof v === "object" && !Array.isArray(v) && seg.name in (v as object)) out.push((v as Record<string, Value>)[seg.name]);
        break;
      case "index":
        if (Array.isArray(v)) {
          const i = seg.i < 0 ? v.length + seg.i : seg.i;
          if (i >= 0 && i < v.length) out.push(v[i]);
          else throw new JsonPathError(`array index out of bounds: index ${seg.i}, length ${v.length}`);
        }
        break;
      case "slice":
        if (Array.isArray(v)) out.push(...v.slice(seg.a, seg.b));
        break;
      case "all":
        if (Array.isArray(v)) out.push(...v);
        else if (typeof v === "object") out.push(...Object.values(v as object));
        break;
      case "recurse": {
        const walk = (x: Value) => {
          if (x === null || typeof x !== "object") return;
          if (Array.isArray(x)) return x.forEach(walk);
          for (const [k, y] of Object.entries(x as object)) {
            if (seg.name === "*" || k === seg.name) out.push(y);
            walk(y);
          }
        };
        walk(v);
        break;
      }
      case "filter":
        if (Array.isArray(v)) {
          for (const item of v) {
            const got = evalSegs([item], seg.path);
            if (seg.op === undefined) {
              if (got.length && got[0] !== false && got[0] !== null) out.push(item);
              continue;
            }
            const x = got[0];
            const y = seg.value;
            const ok =
              seg.op === "==" ? String(x) === String(y) : seg.op === "!=" ? String(x) !== String(y) : seg.op === "<" ? Number(x) < Number(y) : seg.op === ">" ? Number(x) > Number(y) : seg.op === "<=" ? Number(x) <= Number(y) : Number(x) >= Number(y);
            if (got.length && ok) out.push(item);
          }
        }
        break;
    }
  }
  return out;
}

function evalSegs(roots: Value[], segs: Seg[]): Value[] {
  let cur = roots;
  for (const s of segs) cur = step(cur, s);
  return cur;
}

export function evalPath(root: Value, path: string): Value[] {
  return evalSegs([root], parsePath(path));
}

export function formatValue(v: Value): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

type Node = { t: "text"; s: string } | { t: "expr"; path: string } | { t: "range"; path: string; body: Node[] };

function tokenize(tpl: string): { t: "text" | "block"; s: string }[] {
  const out: { t: "text" | "block"; s: string }[] = [];
  let i = 0;
  while (i < tpl.length) {
    const open = tpl.indexOf("{", i);
    if (open < 0) {
      out.push({ t: "text", s: tpl.slice(i) });
      break;
    }
    if (open > i) out.push({ t: "text", s: tpl.slice(i, open) });
    let depth = 0;
    let q: string | null = null;
    let j = open;
    for (; j < tpl.length; j++) {
      const c = tpl[j];
      if (q) {
        if (c === "\\") j++;
        else if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'") q = c;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
    }
    if (j >= tpl.length) throw new JsonPathError(`error parsing jsonpath ${tpl}, unclosed action`);
    out.push({ t: "block", s: tpl.slice(open + 1, j).trim() });
    i = j + 1;
  }
  return out;
}

function parseTemplate(tpl: string): Node[] {
  const toks = tokenize(tpl);
  let i = 0;
  const parse = (untilEnd: boolean): Node[] => {
    const nodes: Node[] = [];
    while (i < toks.length) {
      const t = toks[i++];
      if (t.t === "text") nodes.push({ t: "text", s: t.s });
      else if (t.s === "end") {
        if (untilEnd) return nodes;
        throw new JsonPathError("error parsing jsonpath, not in range, nothing to end");
      } else if (t.s.startsWith("range ")) nodes.push({ t: "range", path: t.s.slice(6).trim(), body: parse(true) });
      else if (/^".*"$|^'.*'$/.test(t.s)) nodes.push({ t: "text", s: t.s.slice(1, -1).replace(/\\t/g, "\t").replace(/\\n/g, "\n").replace(/\\"/g, '"') });
      else nodes.push({ t: "expr", path: t.s });
    }
    if (untilEnd) throw new JsonPathError("error parsing jsonpath, unclosed range");
    return nodes;
  };
  return parse(false);
}

/** Renders a kubectl JSONPath template against an object. */
export function jsonpath(root: Value, template: string): string {
  const nodes = parseTemplate(template);
  const render = (ns: Node[], cur: Value): string =>
    ns
      .map((n) => {
        if (n.t === "text") return n.s;
        if (n.t === "range") return evalPath(n.path.startsWith("$") ? root : cur, n.path).map((item) => render(n.body, item)).join("");
        const vals = evalPath(n.path.startsWith("$") ? root : cur, n.path);
        return vals.map(formatValue).join(" ");
      })
      .join("");
  return render(nodes, root);
}

/** The values a template's expressions select, for -o jsonpath-as-json. */
export function jsonpathValues(root: Value, template: string): Value[] {
  const nodes = parseTemplate(template);
  const out: Value[] = [];
  const walk = (ns: Node[], cur: Value) => {
    for (const n of ns) {
      if (n.t === "range") for (const item of evalPath(n.path.startsWith("$") ? root : cur, n.path)) walk(n.body, item);
      else if (n.t === "expr") out.push(...evalPath(n.path.startsWith("$") ? root : cur, n.path));
    }
  };
  walk(nodes, root);
  return out;
}
