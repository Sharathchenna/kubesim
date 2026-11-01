// The traffic control: a steady flow of requests (load.rps) sent to one Service, too many to walk one
// by one, so they're routed as flows. Every 250ms the flow is spread over the Service's ready endpoints,
// down each app's calls (web → api → database, cache) and summed per Pod. Each Pod serves what its CPU
// allows: its CPU limit, or its share of the Node's CPU when the Node is busy, at the image's CPU cost per
// request. Past that it's throttled: latency climbs, and what it can't serve times out as errors, which
// travel back up to whoever called it. The CPU it burns shows in metrics-server, so `kubectl top` and the
// HPA see it. Whether a request can succeed at all (a Pod not ready, a NetworkPolicy, a Node down) comes
// from the same routing as a single request (traffic.ts).

import type { Cluster, ContainerRuntime } from "../cluster";
import { lookupImage } from "../images";
import { containerLimits, containerRequests, milliCpu } from "../quantity";
import { probeHop, routeCall, serviceHops, type LoadHop } from "../traffic";
import type { Container, Node, Pod, Service } from "../types";

export const LOAD_EVERY_MS = 250;
/** How far back the load model keeps its samples (per container, per Service, overall). */
const KEEP_MS = 60_000;
/** A request that waits longer than this has timed out. */
export const TIMEOUT_MS = 3000;
const MAX_DEPTH = 6;

export interface LoadState {
  /** The Service the traffic goes to: `namespace/name`. */
  target: string;
  /** Requests per second offered. */
  rps: number;
}

/** One sample of what the traffic got: requests offered and answered (per second), and the slowest 5% of answers. */
export interface LoadSample {
  t: number;
  offered: number;
  ok: number;
  p95: number;
}

export interface LoadStats {
  at: number;
  offered: number;
  ok: number;
  p95: number;
  /** The workload holding the traffic back, when one is past its capacity. */
  bottleneck?: { name: string; why: "cpu-limit" | "node-cpu" | "no-endpoints" | "unreachable" };
  /** Why nothing gets through (no such Service, no endpoints). */
  problem?: string;
  samples: LoadSample[];
}

/** What the load model leaves on a container: requests it served and failed (counts per sample) and the CPU it burned doing it. */
export interface ContainerFlow {
  t: number[];
  ok: number[];
  err: number[];
  /** Millicores the flow burns right now. */
  cpu: number;
}

interface PodLoad {
  hop: LoadHop;
  ok: boolean;
  container?: Container;
  crt?: ContainerRuntime;
  calls: string[];
  demand: number;
  /** Share of its demand it can serve (1 unless throttled). */
  served: number;
  /** Mean time to answer, its own part (ms). */
  lat: number;
  cpu: number;
  limited?: "cpu-limit" | "node-cpu";
}

/** A container's CPU limit in millicores, if it has one. */
const limitOf = (c: Container) => containerLimits(c).cpu || undefined;
/** Its CPU request (its weight when the Node's CPU is shared); 2 is the kernel's floor for none. */
const requestOf = (c: Container) => containerRequests(c).cpu || 2;

export function runLoad(cluster: Cluster): void {
  const load = cluster.state.load;
  if (cluster.state.now % LOAD_EVERY_MS !== 0) return;
  if (!load) {
    // Switched off: what the flow was burning stops, and its readout goes with it.
    if (cluster.state.loadStats) {
      for (const prt of Object.values(cluster.state.pods)) for (const crt of Object.values(prt.containers)) delete crt.flow;
      delete cluster.state.loadStats;
      delete cluster.state.loadLost;
      cluster.markChanged();
    }
    return;
  }
  const now = cluster.now;
  const dt = LOAD_EVERY_MS / 1000;
  const [ns, name] = load.target.split("/");
  const target = cluster.raw("Service", ns, name) as unknown as Service | undefined;
  const stats = (cluster.state.loadStats ??= { at: 0, offered: 0, ok: 0, p95: 0, samples: [] });
  const record = (ok: number, p95: number, bottleneck?: LoadStats["bottleneck"], problem?: string) => {
    Object.assign(stats, { at: now, offered: load.rps, ok, p95, bottleneck, problem });
    stats.samples.push({ t: now, offered: load.rps, ok, p95 });
    while (stats.samples.length && now - stats.samples[0].t > KEEP_MS) stats.samples.shift();
    cluster.markChanged();
  };
  // Containers the flow left last time, so one that drops out of the flow stops burning CPU.
  for (const prt of Object.values(cluster.state.pods)) for (const crt of Object.values(prt.containers)) if (crt.flow) crt.flow.cpu = 0;
  if (!target) return record(0, 0, undefined, `There's no Service ${load.target} any more.`);
  if (load.rps <= 0) return record(0, 0);

  const pods = new Map<string, PodLoad>();
  const routes = new Map<string, ReturnType<typeof routeCall>>();
  const svcLost = new Map<string, number>();
  const rootPort = target.spec?.ports?.[0]?.port ?? 80;
  const root = { svc: target, hops: serviceHops(cluster, target, rootPort), tcp: false };

  const podOf = (hop: LoadHop, from: Pod | undefined, tcp: boolean): PodLoad => {
    const key = `${hop.pod.metadata.uid}:${hop.port}`;
    let p = pods.get(key);
    if (!p) {
      const probe = probeHop(cluster, hop, from, tcp);
      p = { hop, ...probe, demand: 0, served: 1, lat: 0, cpu: 0 };
      pods.set(key, p);
    }
    return p;
  };
  const routeOf = (url: string, from: Pod) => {
    const key = `${from.metadata.uid}>${url}`;
    if (!routes.has(key)) routes.set(key, routeCall(cluster, url, from));
    return routes.get(key);
  };

  // Spread `rps` over a route's endpoints and on down what each one calls. Only what a Pod serves goes on.
  const spread = (route: { svc?: Service; hops: LoadHop[]; tcp: boolean } | undefined, rps: number, from: Pod | undefined, depth: number) => {
    if (!route || depth > MAX_DEPTH || rps <= 0) return;
    if (!route.hops.length) {
      if (route.svc) svcLost.set(route.svc.metadata.uid, (svcLost.get(route.svc.metadata.uid) ?? 0) + rps);
      return;
    }
    const per = rps / route.hops.length;
    for (const hop of route.hops) {
      const p = podOf(hop, from, route.tcp);
      p.demand += per;
      if (!p.ok) continue;
      for (const url of p.calls) spread(routeOf(url, hop.pod), per * p.served, hop.pod, depth + 1);
    }
  };

  // Two rounds: the first finds who's throttled, the second sends on only what they actually serve.
  for (let round = 0; round < 2; round++) {
    for (const p of pods.values()) p.demand = 0;
    svcLost.clear();
    spread(root, load.rps, undefined, 0);
    capacity(cluster, pods);
  }

  // How much of a route's traffic succeeds, and how long it takes, following every call.
  const memo = new Map<string, { ok: number; lat: number }>();
  const outcome = (route: { hops: LoadHop[]; tcp: boolean } | undefined, from: Pod | undefined, depth: number): { ok: number; lat: number } => {
    if (!route || !route.hops.length || depth > MAX_DEPTH) return { ok: 0, lat: TIMEOUT_MS };
    let ok = 0;
    let lat = 0;
    for (const hop of route.hops) {
      const p = podOf(hop, from, route.tcp);
      const key = `${hop.pod.metadata.uid}:${hop.port}`;
      let r = memo.get(key);
      if (!r) {
        r = { ok: p.ok ? p.served : 0, lat: p.ok ? p.lat : TIMEOUT_MS };
        memo.set(key, r);
        for (const url of p.ok ? p.calls : []) {
          const down = outcome(routeOf(url, hop.pod), hop.pod, depth + 1);
          r.ok *= down.ok;
          r.lat += down.lat;
        }
        r.lat = Math.min(TIMEOUT_MS, r.lat);
      }
      ok += r.ok / route.hops.length;
      lat += r.lat / route.hops.length;
    }
    return { ok, lat };
  };
  const result = outcome(root, undefined, 0);

  // What each container shows: requests served and failed, and the CPU they cost.
  for (const p of pods.values()) {
    if (!p.crt) continue;
    const r = memo.get(`${p.hop.pod.metadata.uid}:${p.hop.port}`);
    const okRps = p.demand * (r?.ok ?? 0);
    const f = (p.crt.flow ??= { t: [], ok: [], err: [], cpu: 0 });
    f.t.push(now);
    f.ok.push(okRps * dt);
    f.err.push(Math.max(0, p.demand - okRps) * dt);
    f.cpu = p.cpu;
    while (f.t.length && now - f.t[0] > KEEP_MS) {
      f.t.shift();
      f.ok.shift();
      f.err.shift();
    }
  }
  const lost = (cluster.state.loadLost ??= {});
  for (const [uid, rps] of svcLost) {
    const l = (lost[uid] ??= { t: [], n: [] });
    l.t.push(now);
    l.n.push(rps * dt);
  }
  for (const l of Object.values(lost))
    while (l.t.length && now - l.t[0] > KEEP_MS) {
      l.t.shift();
      l.n.shift();
    }

  // The tightest spot, for the readout: the most overloaded workload, or why nothing gets through.
  let bottleneck: LoadStats["bottleneck"];
  let worst = 1;
  for (const p of pods.values()) {
    if (!p.ok || !p.limited || p.served >= worst) continue;
    worst = p.served;
    bottleneck = { name: workloadOf(cluster, p.hop.pod), why: p.limited };
  }
  // A dependency with nothing to answer, or a Pod that can't be reached, explains failures before throttling does.
  const empty = [...svcLost.keys()].map((uid) => cluster.byUid(uid) as unknown as Service | undefined).find(Boolean);
  const down = [...pods.values()].find((p) => !p.ok);
  if (!root.hops.length) bottleneck = { name: target.metadata.name, why: "no-endpoints" };
  else if (empty) bottleneck = { name: empty.metadata.name, why: "no-endpoints" };
  else if (down && result.ok < 0.99) bottleneck = { name: workloadOf(cluster, down.hop.pod), why: "unreachable" };
  // Answer times spread out roughly exponentially around the mean: the 95th percentile is about three means.
  const p95 = result.ok > 0 ? Math.min(TIMEOUT_MS, Math.round(result.lat * 3)) : TIMEOUT_MS;
  record(load.rps * result.ok, p95, bottleneck);

  // A few of the flow's requests ride the wires, so the diagram shows where the traffic goes.
  const shown = Math.min(3, Math.ceil(load.rps / 100));
  for (let i = 0; i < shown && root.hops.length; i++) {
    const hop = root.hops[cluster.trafficRng.int(root.hops.length)];
    const p = podOf(hop, undefined, false);
    cluster.emit({ type: "traffic", serviceUid: target.metadata.uid, podUid: hop.pod.metadata.uid, nodeName: hop.pod.spec?.nodeName, ok: cluster.trafficRng.next() < (memo.get(`${hop.pod.metadata.uid}:${hop.port}`)?.ok ?? 0), via: "clusterip" });
    void p;
  }
}

/**
 * How much of its demand each Pod can serve. A container gets the CPU it needs while its Node has
 * room. When the Node's CPU runs out, it's shared the way the kernel's CFS does it: by weight (the CPU
 * request), but work-conserving, so CPU a container can't use (it wants less, or its limit caps it) goes
 * to the others. Either way it never gets more than its CPU limit. At the image's CPU cost per request
 * that gives a capacity in requests per second; latency rises as it fills up (a queue), and past it the
 * rest waits until it times out.
 */
function capacity(cluster: Cluster, pods: Map<string, PodLoad>) {
  const byNode = new Map<string, PodLoad[]>();
  for (const p of pods.values()) {
    if (!p.ok || !p.container || !p.crt) continue;
    const info = lookupImage(p.crt.image).info;
    const cost = info?.cpuPerRps ?? 0.5;
    p.cpu = (info?.idleCpu ?? 1) + p.demand * cost;
    const node = p.hop.pod.spec?.nodeName ?? "";
    (byNode.get(node) ?? byNode.set(node, []).get(node)!).push(p);
  }
  for (const [nodeName, list] of byNode) {
    const node = cluster.raw("Node", undefined, nodeName) as unknown as Node | undefined;
    const alloc = node?.status?.allocatable?.cpu ? milliCpu(node.status.allocatable.cpu) : 4000;
    // Everything else on the Node idles along: count it, so a full Node is full.
    const others = otherCpu(cluster, nodeName, list);
    const got = fairShares(
      list.map((p) => ({ want: Math.min(p.cpu, limitOf(p.container!) ?? Infinity), weight: requestOf(p.container!) })),
      Math.max(0, alloc - others),
    );
    list.forEach((p, i) => {
      const info = lookupImage(p.crt!.image).info;
      const cost = info?.cpuPerRps ?? 0.5;
      const idle = info?.idleCpu ?? 1;
      const limit = limitOf(p.container!);
      // What it could have used if nothing else on the Node wanted CPU: its demand, up to its limit.
      const ceiling = limit ?? Infinity;
      const avail = Math.max(idle + 1, got[i] >= Math.min(p.cpu, ceiling) - 0.5 ? ceiling : got[i]);
      const cap = Math.max(0.5, (avail - idle) / cost);
      const rho = p.demand / cap;
      p.served = p.demand > 0 ? Math.min(1, cap / p.demand) : 1;
      // Throttled by its own limit, or starved because the Node ran out first.
      p.limited = rho > 1 ? (limit !== undefined && got[i] >= limit - 0.5 ? "cpu-limit" : "node-cpu") : undefined;
      p.cpu = Math.min(p.cpu, avail);
      const base = info?.latencyMs ?? (info?.http ? 12 : 2);
      p.lat = rho < 1 ? base / (1 - Math.min(rho, 0.97)) : TIMEOUT_MS;
    });
  }
}

/**
 * Weighted max-min fair shares of `cpu` (water-filling): each claim gets its weight's share, a claim
 * that wants less than that keeps only what it wants, and the rest is shared again among the others.
 */
export function fairShares(claims: { want: number; weight: number }[], cpu: number): number[] {
  const got = claims.map(() => 0);
  let left = cpu;
  let open = claims.map((_, i) => i);
  while (open.length && left > 0.001) {
    const weight = open.reduce((a, i) => a + claims[i].weight, 0);
    const done = open.filter((i) => claims[i].want - got[i] <= (left * claims[i].weight) / weight);
    if (!done.length) {
      for (const i of open) got[i] += (left * claims[i].weight) / weight;
      break;
    }
    for (const i of done) {
      left -= claims[i].want - got[i];
      got[i] = claims[i].want;
    }
    open = open.filter((i) => !done.includes(i));
  }
  return got;
}

/** CPU the rest of a Node's Pods use while idle (system Pods, Pods outside the flow). */
function otherCpu(cluster: Cluster, nodeName: string, inFlow: PodLoad[]): number {
  const skip = new Set(inFlow.map((p) => `${p.hop.pod.metadata.uid}/${p.container!.name}`));
  let sum = 0;
  for (const pod of cluster.list<Pod>("Pod")) {
    if (pod.spec?.nodeName !== nodeName) continue;
    const prt = cluster.state.pods[pod.metadata.uid];
    for (const c of pod.spec?.containers ?? []) {
      const crt = prt?.containers[c.name];
      if (!crt || crt.phase !== "running" || skip.has(`${pod.metadata.uid}/${c.name}`)) continue;
      sum += (lookupImage(crt.image).info?.idleCpu ?? 1) + (crt.burn ?? 0);
    }
  }
  return sum;
}

/** The Deployment (or StatefulSet…) a Pod belongs to, by name, for the readout. */
function workloadOf(cluster: Cluster, pod: Pod): string {
  const own = pod.metadata.ownerReferences?.find((r) => r.controller);
  if (own?.kind === "ReplicaSet") {
    const rs = cluster.raw("ReplicaSet", pod.metadata.namespace, own.name);
    return rs?.metadata.ownerReferences?.find((r) => r.controller)?.name ?? own.name;
  }
  return own?.name ?? pod.metadata.name;
}
