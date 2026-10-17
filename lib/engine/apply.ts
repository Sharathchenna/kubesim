// kubectl apply's client-side three-way merge (k8s.io/kubectl/pkg/cmd/apply, strategicpatch).
//
//   original = the live object's kubectl.kubernetes.io/last-applied-configuration
//   modified = the manifest being applied now
//   live     = the object as the API server has it
//
// Fields set in `modified` win. Fields that were in `original` but are gone from
// `modified` are deleted. Everything else in `live` (defaults, controller-written
// annotations, labels added with `kubectl label`, `kubectl rollout restart`'s
// restartedAt, an allocated nodePort or clusterIP) is kept. Lists of objects with a
// strategic-merge key (containers by name, Service ports by port…) merge item by
// item; other lists are replaced. Fields tagged `retainKeys` (Deployment
// spec.strategy, a volume's source) keep only the keys the manifest sets.

import { clone } from "./util";

export const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

type Json = unknown;
type Obj = Record<string, unknown>;

const isObj = (v: Json): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** patchMergeKey per list field name (from the API types' struct tags). */
const MERGE_KEY: Record<string, (item: Obj) => string> = {
  containers: (x) => String(x.name),
  initContainers: (x) => String(x.name),
  ephemeralContainers: (x) => String(x.name),
  volumes: (x) => String(x.name),
  env: (x) => String(x.name),
  imagePullSecrets: (x) => String(x.name),
  volumeMounts: (x) => String(x.mountPath),
  hostAliases: (x) => String(x.ip),
  ownerReferences: (x) => String(x.uid),
  topologySpreadConstraints: (x) => `${x.topologyKey}|${x.whenUnsatisfiable}`,
  // Container ports merge on containerPort+protocol, Service ports on port+protocol.
  ports: (x) => (x.containerPort !== undefined ? `c${x.containerPort}/${x.protocol ?? "TCP"}` : `s${x.port}/${x.protocol ?? "TCP"}`),
};

/** Paths whose value is replaced wholesale by the keys the manifest sets (patchStrategy retainKeys). */
function retainKeys(path: string, kind: string): boolean {
  if (kind === "Deployment" && path === ".spec.strategy") return true;
  return path.endsWith(".volumes[]");
}

function mergeValue(live: Json, original: Json, modified: Json, path: string, kind: string): Json {
  if (modified === null) return undefined; // an explicit null deletes the field
  if (isObj(modified)) {
    const base: Obj = isObj(live) ? clone(live) : {};
    const orig: Obj = isObj(original) ? original : {};
    for (const [k, v] of Object.entries(modified)) {
      const next = mergeValue(base[k], orig[k], v, `${path}.${k}`, kind);
      if (next === undefined) delete base[k];
      else base[k] = next;
    }
    for (const k of Object.keys(orig)) if (!(k in modified)) delete base[k];
    if (retainKeys(path, kind)) for (const k of Object.keys(base)) if (!(k in modified)) delete base[k];
    return base;
  }
  if (Array.isArray(modified)) {
    const field = path.slice(path.lastIndexOf(".") + 1);
    const keyOf = MERGE_KEY[field];
    if (!keyOf || !Array.isArray(live) || !modified.every(isObj)) return clone(modified);
    const liveByKey = new Map<string, Obj>();
    for (const x of live) if (isObj(x)) liveByKey.set(keyOf(x), x);
    const origByKey = new Map<string, Obj>();
    for (const x of Array.isArray(original) ? original : []) if (isObj(x)) origByKey.set(keyOf(x), x);
    const out: Json[] = [];
    const seen = new Set<string>();
    for (const m of modified as Obj[]) {
      const key = keyOf(m);
      seen.add(key);
      out.push(mergeValue(liveByKey.get(key), origByKey.get(key), m, `${path}[]`, kind));
    }
    // Items someone else added (not in the last applied config) stay.
    for (const x of live) if (isObj(x) && !seen.has(keyOf(x)) && !origByKey.has(keyOf(x))) out.push(clone(x));
    return out;
  }
  return modified;
}

const SKIP_TOP = new Set(["apiVersion", "kind", "metadata", "status"]);

/**
 * The object kubectl apply would send: `live` with the changes between the last
 * applied config and `modified`. `original` undefined means the live object has no
 * last-applied annotation (nothing is deleted then, as in real kubectl).
 */
export function threeWayMerge<T extends { kind: string; metadata: object }>(live: T, original: Obj | undefined, modified: Obj): T {
  const out = clone(live) as unknown as Obj;
  const orig = original ?? {};
  const kind = live.kind;
  for (const [k, v] of Object.entries(modified)) {
    if (SKIP_TOP.has(k)) continue;
    const next = mergeValue(out[k], orig[k], v, `.${k}`, kind);
    if (next === undefined) delete out[k];
    else out[k] = next;
  }
  for (const k of Object.keys(orig)) if (!SKIP_TOP.has(k) && !(k in modified)) delete out[k];
  // metadata: only labels and annotations are merged; identity fields stay as they are.
  const meta = out.metadata as Obj;
  const mm = (modified.metadata ?? {}) as Obj;
  const om = (orig.metadata ?? {}) as Obj;
  for (const f of ["labels", "annotations"]) {
    if (mm[f] === undefined && om[f] === undefined) continue;
    const next = mergeValue(meta[f], om[f], mm[f] ?? {}, `.metadata.${f}`, kind);
    if (next === undefined || (isObj(next) && Object.keys(next).length === 0)) delete meta[f];
    else meta[f] = next;
  }
  return out as unknown as T;
}

/** The last applied config stored on an object, if any. */
export function lastApplied(o: { metadata: { annotations?: Record<string, string> } }): Obj | undefined {
  const raw = o.metadata.annotations?.[LAST_APPLIED];
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
