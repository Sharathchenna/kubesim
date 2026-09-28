// metrics-server: scrapes every kubelet's usage every 15s, so `kubectl top`
// and the HPA see numbers that lag reality a little, as in a real cluster.
// Usage is modelled per container: idle CPU, CPU per request/s served,
// `stress` burns, capped by the CPU limit (throttling); memory is the image's
// resident set plus what the program allocated.

import type { Cluster, ContainerRuntime } from "../cluster";
import { lookupImage } from "../images";
import { containerLimits } from "../quantity";
import type { Container, Node, Pod } from "../types";

export const SCRAPE_MS = 15_000;
const WINDOW_MS = 15_000;
const Mi = 2 ** 20;

export interface PodMetrics {
  cpu: number; // millicores
  memory: number; // bytes
  containers: Record<string, { cpu: number; memory: number }>;
  at: number;
}

export interface MetricsState {
  at: number;
  pods: Record<string, PodMetrics>;
  nodes: Record<string, { cpu: number; memory: number; at: number }>;
}

export function containerMemory(c: Container, crt: ContainerRuntime): number {
  const { info } = lookupImage(crt.image);
  return (info?.baseMem ?? 2 * Mi) + (crt.alloc ?? 0);
}

export function containerCpu(c: Container, crt: ContainerRuntime, now: number): number {
  const { info } = lookupImage(crt.image);
  const recent = (crt.reqs ?? []).filter((t) => now - t <= WINDOW_MS).length;
  const rps = recent / (WINDOW_MS / 1000);
  const raw = (info?.idleCpu ?? 1) + rps * (info?.cpuPerRps ?? 1) + (crt.burn ?? 0);
  const limit = containerLimits(c).cpu;
  return Math.max(0, Math.round(limit ? Math.min(raw, limit) : raw));
}

/** Is metrics-server running (so the Metrics API answers)? */
export function metricsAvailable(cluster: Cluster): boolean {
  const pods = cluster.list<Pod>("Pod", "kube-system").filter((p) => p.metadata.labels?.["k8s-app"] === "metrics-server");
  return pods.some((p) => p.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"));
}

export function runMetrics(cluster: Cluster): void {
  const now = cluster.now;
  const m = (cluster.state.metrics ??= { at: 0, pods: {}, nodes: {} });
  if (now - m.at < SCRAPE_MS) return;
  m.at = now;
  if (!metricsAvailable(cluster)) {
    m.pods = {};
    m.nodes = {};
    return;
  }
  const pods: Record<string, PodMetrics> = {};
  const nodeUse: Record<string, { cpu: number; memory: number }> = {};
  for (const p of cluster.list<Pod>("Pod")) {
    const prt = cluster.state.pods[p.metadata.uid];
    const node = p.spec?.nodeName;
    if (!prt || !node || cluster.state.nodes[node]?.up === false) continue;
    const containers: PodMetrics["containers"] = {};
    let cpu = 0;
    let memory = 0;
    let running = false;
    for (const c of p.spec?.containers ?? []) {
      const crt = prt.containers[c.name];
      if (!crt || (crt.phase !== "running" && crt.phase !== "stopping")) continue;
      running = true;
      const u = { cpu: containerCpu(c, crt, now), memory: containerMemory(c, crt) };
      containers[c.name] = u;
      cpu += u.cpu;
      memory += u.memory;
    }
    // A container needs to have been up for one scrape before it has metrics.
    const since = Math.min(...Object.values(prt.containers).map((c) => c.startedAt ?? Infinity));
    if (!running || now - since < SCRAPE_MS) continue;
    pods[p.metadata.uid] = { cpu, memory, containers, at: now };
    const n = (nodeUse[node] ??= { cpu: 0, memory: 0 });
    n.cpu += cpu;
    n.memory += memory;
  }
  m.pods = pods;
  const nodes: MetricsState["nodes"] = {};
  for (const n of cluster.list<Node>("Node")) {
    const rt = cluster.state.nodes[n.metadata.name];
    if (!rt?.up) continue;
    const cp = n.metadata.labels?.["node-role.kubernetes.io/control-plane"] !== undefined;
    // The OS, kubelet and container runtime use some too.
    const u = nodeUse[n.metadata.name] ?? { cpu: 0, memory: 0 };
    nodes[n.metadata.name] = { cpu: u.cpu + (cp ? 60 : 25), memory: u.memory + (cp ? 420 : 280) * Mi, at: now };
  }
  m.nodes = nodes;
  cluster.markChanged();
}
