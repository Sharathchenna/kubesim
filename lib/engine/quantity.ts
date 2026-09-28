// Resource quantities ("250m", "128Mi", "1.5", "2G") and the requests/limits
// arithmetic the scheduler, kubelet and HPA share (behaviour reference v2 §2).

import type { Container, Pod, PodSpec } from "./types";

const BINARY: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DECIMAL: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

/** Parses a quantity to its base unit (cores for cpu, bytes for memory). NaN if malformed. */
export function parseQuantity(q: string | number | undefined): number {
  if (q === undefined || q === null) return NaN;
  if (typeof q === "number") return q;
  const m = String(q).trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+))(?:[eE]([+-]?\d+))?(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E)?$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]) * (m[2] ? 10 ** parseInt(m[2], 10) : 1);
  const suf = m[3] ?? "";
  return n * (BINARY[suf] ?? DECIMAL[suf]);
}

export const isQuantity = (q: unknown) => (typeof q === "string" || typeof q === "number") && !Number.isNaN(parseQuantity(q as string));

/** CPU in millicores. */
export const milliCpu = (q: string | number | undefined) => {
  const v = parseQuantity(q);
  return Number.isNaN(v) ? 0 : Math.round(v * 1000);
};

/** Memory (or storage) in bytes. */
export const bytes = (q: string | number | undefined) => {
  const v = parseQuantity(q);
  return Number.isNaN(v) ? 0 : Math.round(v);
};

/** How `kubectl top` and describe print CPU: "250m", "2". */
export function formatCpu(m: number): string {
  return `${Math.round(m)}m`;
}

/** How `kubectl top` prints memory: whole Mi. */
export function formatMemMi(b: number): string {
  return `${Math.round(b / 2 ** 20)}Mi`;
}

/** Canonical form the API server stores quantities in: "500m" stays, "0.5" becomes "500m", "1024Mi" becomes "1Gi". */
export function canonicalQuantity(q: string, kind: "cpu" | "bytes"): string {
  const v = parseQuantity(q);
  if (Number.isNaN(v)) return q;
  if (kind === "cpu") {
    const m = Math.round(v * 1000);
    return m % 1000 === 0 ? String(m / 1000) : `${m}m`;
  }
  if (/i$/.test(q.trim())) {
    for (const [suf, mul] of Object.entries(BINARY).reverse()) if (v >= mul && v % mul === 0) return `${v / mul}${suf}`;
    return String(v);
  }
  return q.trim();
}

export interface Resources {
  cpu: number; // millicores
  memory: number; // bytes
}

const containerReq = (c: Container, key: "requests" | "limits"): Resources => ({
  cpu: milliCpu(c.resources?.[key]?.cpu),
  memory: bytes(c.resources?.[key]?.memory),
});

/** A Pod's effective requests: the sum over its containers (the scheduler's view). */
export function podRequests(spec: PodSpec | undefined): Resources {
  const out = { cpu: 0, memory: 0 };
  for (const c of spec?.containers ?? []) {
    const r = containerReq(c, "requests");
    out.cpu += r.cpu;
    out.memory += r.memory;
  }
  return out;
}

export function podLimits(spec: PodSpec | undefined): Resources {
  const out = { cpu: 0, memory: 0 };
  for (const c of spec?.containers ?? []) {
    const r = containerReq(c, "limits");
    out.cpu += r.cpu;
    out.memory += r.memory;
  }
  return out;
}

export function containerLimits(c: Container): Resources {
  return containerReq(c, "limits");
}

export function containerRequests(c: Container): Resources {
  return containerReq(c, "requests");
}

/** QoS class (pkg/apis/core/helper/qos): Guaranteed, Burstable or BestEffort. */
export function qosClass(spec: PodSpec | undefined): "Guaranteed" | "Burstable" | "BestEffort" {
  const cs = spec?.containers ?? [];
  let any = false;
  let guaranteed = cs.length > 0;
  for (const c of cs) {
    const req = c.resources?.requests ?? {};
    const lim = c.resources?.limits ?? {};
    for (const r of ["cpu", "memory"]) {
      if (req[r] !== undefined || lim[r] !== undefined) any = true;
      if (lim[r] === undefined || (req[r] !== undefined && parseQuantity(req[r]) !== parseQuantity(lim[r]))) guaranteed = false;
    }
  }
  if (!any) return "BestEffort";
  return guaranteed ? "Guaranteed" : "Burstable";
}

export function nodeAllocatable(n: { status?: { allocatable?: Record<string, string> } }): Resources {
  return { cpu: milliCpu(n.status?.allocatable?.cpu ?? "4"), memory: bytes(n.status?.allocatable?.memory ?? "8141592Ki") };
}

/** Requests of the Pods counted against a Node (bound, not terminal). */
export function nodeRequested(pods: Pod[], nodeName: string): Resources {
  const out = { cpu: 0, memory: 0 };
  for (const p of pods) {
    if (p.spec?.nodeName !== nodeName) continue;
    if (p.status?.phase === "Succeeded" || p.status?.phase === "Failed") continue;
    const r = podRequests(p.spec);
    out.cpu += r.cpu;
    out.memory += r.memory;
  }
  return out;
}
