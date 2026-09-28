// Shareable Sandbox links: the cluster snapshot, trimmed (no Events, logs or
// metrics) and deflate-compressed, in the URL hash. Nothing leaves the
// browser until the Learner shares the link themselves; there is no backend.

import type { ClusterState } from "@/lib/engine";

export const SHARE_PARAM = "cluster";
const VERSION = "1";

/** Drops what a shared cluster can do without: Events, container logs, metrics samples. */
export function trimForShare(state: ClusterState): ClusterState {
  const objects: ClusterState["objects"] = {};
  for (const [k, o] of Object.entries(state.objects)) if (o.kind !== "Event") objects[k] = o;
  const pods: ClusterState["pods"] = {};
  for (const [uid, p] of Object.entries(state.pods)) {
    pods[uid] = { ...p, containers: Object.fromEntries(Object.entries(p.containers).map(([n, c]) => [n, { ...c, reqs: [] }])) };
  }
  return { ...state, objects, pods, logs: {}, metrics: { at: 0, pods: {}, nodes: {} } };
}

function toB64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A decompressed cluster bigger than this is not something kubesim made (a zip bomb, or garbage). */
const MAX_BYTES = 32 * 1024 * 1024;

async function pipe(data: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const reader = new Blob([data]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("That link is too large to be a kubesim cluster.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The parts of a snapshot the engine can't start without. */
function looksLikeCluster(v: unknown): v is ClusterState {
  if (!isRecord(v) || !isRecord(v.config) || !isRecord(v.objects) || !isRecord(v.pods) || !isRecord(v.nodes)) return false;
  if (typeof v.now !== "number" || typeof v.rng !== "number" || typeof v.rv !== "number") return false;
  return Object.values(v.objects).every((o) => isRecord(o) && typeof o.kind === "string" && isRecord(o.metadata) && typeof o.metadata.name === "string");
}

export async function encodeCluster(state: ClusterState): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(trimForShare(state)));
  const packed = await pipe(json, new CompressionStream("deflate-raw"));
  return `${VERSION}.${toB64Url(packed)}`;
}

export async function decodeCluster(token: string): Promise<ClusterState> {
  const [v, body] = token.split(".");
  if (v !== VERSION || !body) throw new Error("This link was made by a different version of kubesim.");
  let json: Uint8Array;
  let state: unknown;
  try {
    json = await pipe(fromB64Url(body), new DecompressionStream("deflate-raw"), MAX_BYTES);
    state = JSON.parse(new TextDecoder().decode(json));
  } catch (e) {
    if ((e as Error).message.startsWith("That link")) throw e;
    throw new Error("That link is damaged (was it cut short when it was copied?).");
  }
  if (!looksLikeCluster(state)) throw new Error("That link doesn't contain a cluster.");
  return state;
}

/** The share token in a URL hash like #cluster=1.abc…, if any. */
export function tokenFromHash(hash: string): string | undefined {
  const m = hash.replace(/^#/, "").split("&").find((kv) => kv.startsWith(`${SHARE_PARAM}=`));
  return m ? decodeURIComponent(m.slice(SHARE_PARAM.length + 1)) : undefined;
}
