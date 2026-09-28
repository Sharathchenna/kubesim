import type { Labels, LabelSelector } from "./types";

/** The simulated wall clock starts here; sim time 0 maps to this instant. */
export const SIM_EPOCH = Date.UTC(2026, 0, 1, 9, 0, 0);

export function goDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m${s % 60}s`;
}

export function unixDate(simMs: number): string {
  const d = new Date(SIM_EPOCH + simMs);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const t = d.toISOString().slice(11, 19);
  return `${day} ${mon} ${String(d.getUTCDate()).padStart(2, " ")} ${t} UTC ${d.getUTCFullYear()}`;
}

export function rfc3339(simMs: number): string {
  return new Date(SIM_EPOCH + simMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Seeded PRNG (mulberry32). State is a plain number so snapshots stay JSON. */
export class Rng {
  constructor(public state: number) {}
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
}

// The alphabet Kubernetes uses for generated names (k8s.io/apimachinery/pkg/util/rand).
const ALPHANUMS = "bcdfghjklmnpqrstvwxz2456789";

export function randSuffix(rng: Rng, n = 5): string {
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHANUMS[rng.int(ALPHANUMS.length)];
  return s;
}

export function fnv32a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Mirrors rand.SafeEncodeString: maps each char of the hash into ALPHANUMS. */
export function safeEncode(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) out += ALPHANUMS[s.charCodeAt(i) % ALPHANUMS.length];
  return out;
}

/** Stable JSON: object keys sorted, so hashes don't depend on key order. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Structural equality with JSON semantics (undefined fields don't count). Hot path: runs on every store write. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  let n = 0;
  for (const k in x) {
    if (x[k] === undefined) continue;
    n++;
    if (!deepEqual(x[k], y[k])) return false;
  }
  for (const k in y) if (y[k] !== undefined) n--;
  return n === 0;
}

export function matchesSelector(labels: Labels | undefined, selector: LabelSelector | Labels | undefined): boolean {
  if (!selector) return false;
  const sel: LabelSelector =
    "matchLabels" in selector || "matchExpressions" in selector ? (selector as LabelSelector) : { matchLabels: selector as Labels };
  const l = labels ?? {};
  const ml = sel.matchLabels ?? {};
  const exprs = sel.matchExpressions ?? [];
  if (Object.keys(ml).length === 0 && exprs.length === 0) return false;
  for (const [k, v] of Object.entries(ml)) if (l[k] !== v) return false;
  for (const e of exprs) {
    const has = e.key in l;
    if (e.operator === "In" && !(has && e.values?.includes(l[e.key]))) return false;
    if (e.operator === "NotIn" && has && e.values?.includes(l[e.key])) return false;
    if (e.operator === "Exists" && !has) return false;
    if (e.operator === "DoesNotExist" && has) return false;
  }
  return true;
}

/** Parses a kubectl-style label selector string, e.g. "app=web,tier!=db,env". */
export function parseSelectorString(s: string): LabelSelector {
  const sel: LabelSelector = { matchLabels: {}, matchExpressions: [] };
  for (const raw of s.split(/,(?![^(]*\))/)) {
    const part = raw.trim();
    if (!part) continue;
    let m: RegExpMatchArray | null;
    if ((m = part.match(/^([\w./-]+)\s+(in|notin)\s+\(([^)]*)\)$/))) {
      sel.matchExpressions!.push({ key: m[1], operator: m[2] === "in" ? "In" : "NotIn", values: m[3].split(",").map((x) => x.trim()) });
    } else if ((m = part.match(/^([\w./-]+)\s*!=\s*(.*)$/))) {
      sel.matchExpressions!.push({ key: m[1], operator: "NotIn", values: [m[2]] });
    } else if ((m = part.match(/^([\w./-]+)\s*==?\s*(.*)$/))) {
      sel.matchLabels![m[1]] = m[2];
    } else if ((m = part.match(/^!([\w./-]+)$/))) {
      sel.matchExpressions!.push({ key: m[1], operator: "DoesNotExist" });
    } else if ((m = part.match(/^([\w./-]+)$/))) {
      sel.matchExpressions!.push({ key: m[1], operator: "Exists" });
    } else {
      throw new Error(`unable to parse requirement: ${part}`);
    }
  }
  return sel;
}

/** Selector matching for the kubectl `-l` flag, where an empty selector matches everything. */
export function matchesSelectorString(labels: Labels | undefined, selector: LabelSelector): boolean {
  if (Object.keys(selector.matchLabels ?? {}).length === 0 && (selector.matchExpressions ?? []).length === 0) return true;
  return matchesSelector(labels, selector);
}

const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

export function isDns1123Label(s: string): boolean {
  return s.length <= 63 && DNS1123_LABEL.test(s);
}
export function isDns1123Subdomain(s: string): boolean {
  return s.length <= 253 && DNS1123_SUBDOMAIN.test(s);
}

/** Resolves an int-or-percent like maxSurge against a replica count. */
export function intOrPercent(v: number | string | undefined, total: number, roundUp: boolean, fallback: string): number {
  const val = v ?? fallback;
  if (typeof val === "number") return val;
  const m = String(val).match(/^(\d+)%$/);
  if (!m) return parseInt(String(val), 10) || 0;
  const raw = (parseInt(m[1], 10) * total) / 100;
  return roundUp ? Math.ceil(raw) : Math.floor(raw);
}
