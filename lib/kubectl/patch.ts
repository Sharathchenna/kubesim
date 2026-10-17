// kubectl patch: strategic merge (lists of named items merge by key), JSON
// merge patch (RFC 7386) and JSON patch (RFC 6902), with the apiserver's errors.

import YAML from "yaml";

export class PatchError extends Error {}

export const PATCH_TYPES = ["json", "merge", "strategic"] as const;

/** kubectl turns the -p text from YAML into JSON before sending it; parse errors read like Go's. */
export function parsePatch(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through to YAML, which kubectl also accepts */
  }
  try {
    const doc = YAML.parseDocument(raw);
    if (doc.errors.length) throw new Error(doc.errors[0].message.split("\n")[0]);
    return doc.toJS();
  } catch (e) {
    throw new PatchError(`error: unable to parse "${raw}": yaml: ${(e as Error).message.split("\n")[0].toLowerCase()}`);
  }
}

const goType = (v: unknown) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v === "object" ? "object" : typeof v === "string" ? "string" : typeof v === "number" ? "number" : "bool");

/** Strategic-ish merge: lists of named items (containers, env, volumes…) merge by key. */
export function strategicMerge(base: unknown, patch: unknown): unknown {
  if (patch === null) return undefined;
  if (Array.isArray(patch)) {
    if (!Array.isArray(base)) return patch;
    const key = ["name", "containerPort", "mountPath", "port", "ip"].find((k) => patch.every((p) => p && typeof p === "object" && k in p) && base.every((b) => b && typeof b === "object" && k in b));
    if (!key) return patch;
    const out = [...base];
    for (const p of patch) {
      const i = out.findIndex((b) => (b as Record<string, unknown>)[key] === (p as Record<string, unknown>)[key]);
      if ((p as { $patch?: string }).$patch === "delete") {
        if (i >= 0) out.splice(i, 1);
      } else if (i >= 0) out[i] = strategicMerge(out[i], p);
      else out.push(p);
    }
    return out;
  }
  if (patch && typeof patch === "object") {
    const out: Record<string, unknown> = base && typeof base === "object" && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {};
    for (const [k, v] of Object.entries(patch)) {
      const merged = strategicMerge(out[k], v);
      if (merged === undefined) delete out[k];
      else out[k] = merged;
    }
    return out;
  }
  return patch;
}

export function mergePatch(base: unknown, patch: unknown): unknown {
  if (patch === null) return undefined;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = base && typeof base === "object" && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch)) {
    const m = mergePatch(out[k], v);
    if (m === undefined) delete out[k];
    else out[k] = m;
  }
  return out;
}

type Op = { op?: unknown; path?: unknown; value?: unknown; from?: unknown };

export function jsonPatch(doc: unknown, ops: Op[]): unknown {
  const root = structuredClone(doc) as Record<string, unknown>;
  const parts = (path: string) => path.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  const locate = (op: string, path: string) => {
    const ps = parts(path);
    const last = ps.pop();
    if (last === undefined) throw new PatchError(`Error from server (UnprocessableEntity): ${op} operation does not apply: doc is missing path: "${path}": missing value`);
    let cur: unknown = root;
    for (const p of ps) {
      cur = Array.isArray(cur) ? cur[Number(p)] : cur && typeof cur === "object" ? (cur as Record<string, unknown>)[p] : undefined;
      if (cur === undefined || cur === null || typeof cur !== "object") throw new PatchError(`Error from server (UnprocessableEntity): ${op} operation does not apply: doc is missing path: "${path}": missing value`);
    }
    return { parent: cur as Record<string, unknown> | unknown[], last };
  };
  const read = (path: string, op: string) => {
    const { parent, last } = locate(op, path);
    const v = Array.isArray(parent) ? parent[Number(last)] : parent[last];
    if (v === undefined) throw new PatchError(`Error from server (UnprocessableEntity): ${op} operation does not apply: doc is missing path: "${path}": missing value`);
    return v;
  };
  for (const raw of ops) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PatchError("Error from server (BadRequest): json: cannot unmarshal " + goType(raw) + " into Go value of type jsonpatch.Operation");
    const op = String(raw.op ?? "");
    const path = typeof raw.path === "string" ? raw.path : "";
    if (!["add", "remove", "replace", "move", "copy", "test"].includes(op)) throw new PatchError(`Error from server: Unexpected kind: ${op || "unknown"}`);
    if (op === "test") {
      if (JSON.stringify(read(path, op)) !== JSON.stringify(raw.value)) throw new PatchError(`Error from server (UnprocessableEntity): testing value ${path} failed: test failed`);
      continue;
    }
    let value = raw.value;
    if (op === "move" || op === "copy") {
      const from = String(raw.from ?? "");
      value = structuredClone(read(from, op));
      if (op === "move") {
        const { parent, last } = locate(op, from);
        if (Array.isArray(parent)) parent.splice(Number(last), 1);
        else delete parent[last];
      }
    }
    const { parent, last } = locate(op, path);
    if (Array.isArray(parent)) {
      const i = last === "-" ? parent.length : Number(last);
      if (!Number.isInteger(i) || i < 0 || i > parent.length || (op !== "add" && op !== "move" && op !== "copy" && i >= parent.length)) throw new PatchError(`Error from server (UnprocessableEntity): ${op} operation does not apply: doc is missing path: "${path}": missing value`);
      if (op === "remove") parent.splice(i, 1);
      else if (op === "replace") parent[i] = value;
      else parent.splice(i, 0, value);
    } else {
      if ((op === "remove" || op === "replace") && !(last in parent)) throw new PatchError(`Error from server (UnprocessableEntity): ${op} operation does not apply: doc is missing path: "${path}": missing value`);
      if (op === "remove") delete parent[last];
      else parent[last] = value;
    }
  }
  return root;
}

/** Applies a parsed patch of the given type to an object, with the apiserver's type errors. */
export function applyPatch(obj: unknown, patch: unknown, type: string): Record<string, unknown> {
  if (type === "json") {
    if (!Array.isArray(patch)) throw new PatchError(`Error from server (BadRequest): json: cannot unmarshal ${goType(patch)} into Go value of type jsonpatch.Patch`);
    return jsonPatch(obj, patch as Op[]) as Record<string, unknown>;
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new PatchError(`Error from server (BadRequest): json: cannot unmarshal ${goType(patch)} into Go value of type map[string]interface {}`);
  return (type === "merge" ? mergePatch(obj, patch) : strategicMerge(obj, patch)) as Record<string, unknown>;
}
