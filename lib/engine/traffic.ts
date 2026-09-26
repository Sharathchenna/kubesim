// In-cluster networking: DNS, Service load-balancing (kube-proxy), NodePorts,
// and HTTP to container Programs. Used by `curl` in the terminal and by the
// Cluster View's traffic animation.

import type { Cluster } from "./cluster";
import { lookupImage } from "./images";
import { unixDate } from "./controllers/kubelet";
import type { Endpoints, Node, Pod, Service } from "./types";

export interface TrafficResult {
  ok: boolean;
  status?: number;
  body?: string;
  /** curl-style error line when !ok. */
  error?: string;
  exitCode: number;
  podName?: string;
  serviceName?: string;
}

export interface RequestOptions {
  /** Pod the request comes from (for DNS search path and localhost); omit for "from a Node / outside". */
  fromPod?: Pod;
  /** Only resolve, don't log or emit (used by previews). */
  dryRun?: boolean;
}

export function parseUrl(url: string): { host: string; port?: number; path: string; scheme: string } | undefined {
  const m = url.match(/^(?:(https?):\/\/)?([^/:?#]+)(?::(\d+))?([^#]*)?/);
  if (!m) return undefined;
  return { scheme: m[1] ?? "http", host: m[2], port: m[3] ? parseInt(m[3], 10) : undefined, path: m[4] || "/" };
}

function findService(cluster: Cluster, host: string, fromNs: string): Service | undefined {
  const parts = host.replace(/\.$/, "").split(".");
  if (parts.length === 1) return cluster.raw("Service", fromNs, parts[0]) as unknown as Service | undefined;
  if (parts.length === 2 || (parts.length === 3 && parts[2] === "svc") || (parts.length === 5 && parts.slice(2).join(".") === "svc.cluster.local")) {
    return cluster.raw("Service", parts[1], parts[0]) as unknown as Service | undefined;
  }
  return undefined;
}

type Target = { kind: "service"; svc: Service; port: number } | { kind: "pod"; pod: Pod; port: number } | { kind: "none"; error: string; exitCode: number };

function resolve(cluster: Cluster, host: string, port: number, from?: Pod): Target {
  const ns = from?.metadata.namespace ?? "default";
  if ((host === "localhost" || host === "127.0.0.1") && from) return { kind: "pod", pod: from, port };
  const svc = findService(cluster, host, ns);
  if (svc) return { kind: "service", svc, port };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const byIp = cluster.list<Service>("Service").find((s) => s.spec?.clusterIP === host);
    if (byIp) return { kind: "service", svc: byIp, port };
    const node = cluster.list<Node>("Node").find((n) => n.status?.addresses.some((a) => a.address === host));
    if (node) {
      if (cluster.state.nodes[node.metadata.name]?.up === false) return timeout(host, port);
      const np = cluster.list<Service>("Service").find((s) => s.spec?.ports?.some((p) => p.nodePort === port));
      if (np) return { kind: "service", svc: np, port: np.spec!.ports!.find((p) => p.nodePort === port)!.port };
      return refused(host, port);
    }
    const pod = cluster.list<Pod>("Pod").find((p) => p.status?.podIP === host && !p.metadata.annotations?.["kubernetes.io/config.source"]);
    if (pod) return { kind: "pod", pod, port };
    return timeout(host, port);
  }
  return { kind: "none", error: `curl: (6) Could not resolve host: ${host}`, exitCode: 6 };
}

const refusedMsg = (host: string, port: number) => `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server`;
const timeoutMsg = (host: string, port: number) => `curl: (28) Failed to connect to ${host} port ${port} after 10002 ms: Timeout was reached`;
const refused = (host: string, port: number): Target => ({ kind: "none", error: refusedMsg(host, port), exitCode: 7 });
const timeout = (host: string, port: number): Target => ({ kind: "none", error: timeoutMsg(host, port), exitCode: 28 });

/** Sends an HTTP GET inside the cluster. */
export function request(cluster: Cluster, url: string, opts: RequestOptions = {}): TrafficResult {
  const u = parseUrl(url);
  if (!u) return { ok: false, error: `curl: (3) URL rejected: Malformed input to a URL function`, exitCode: 3 };
  const port = u.port ?? (u.scheme === "https" ? 443 : 80);
  const target = resolve(cluster, u.host, port, opts.fromPod);
  if (target.kind === "none") return { ok: false, error: target.error, exitCode: target.exitCode };

  let pod: Pod | undefined;
  let podPort = port;
  let svc: Service | undefined;
  let via: "clusterip" | "nodeport" | "pod" = "pod";
  if (target.kind === "service") {
    svc = target.svc;
    via = u.port && svc.spec?.ports?.some((p) => p.nodePort === u.port) ? "nodeport" : "clusterip";
    const sp = svc.spec?.ports?.find((p) => p.port === target.port);
    const shownHost = u.host;
    if (!sp) return { ok: false, error: timeoutMsg(shownHost, port), exitCode: 28 };
    const ep = cluster.raw("Endpoints", svc.metadata.namespace, svc.metadata.name) as unknown as Endpoints | undefined;
    const ready = (ep?.subsets ?? []).flatMap((s) =>
      (s.addresses ?? []).map((a) => ({ a, port: s.ports?.find((p) => p.name === sp.name || (!p.name && !sp.name))?.port ?? s.ports?.[0]?.port ?? port })),
    );
    if (ready.length === 0) return { ok: false, error: refusedMsg(shownHost, port), exitCode: 7 };
    const pick = ready[cluster.rng.int(ready.length)];
    pod = cluster.byUid(pick.a.targetRef?.uid ?? "") as unknown as Pod | undefined;
    podPort = pick.port;
    if (!pod) return { ok: false, error: refusedMsg(shownHost, port), exitCode: 7 };
  } else {
    pod = target.pod;
  }

  const nodeName = pod.spec?.nodeName;
  if (!nodeName || cluster.state.nodes[nodeName]?.up === false) {
    return { ok: false, error: timeoutMsg(u.host, port), exitCode: 28, podName: pod.metadata.name };
  }
  const prt = cluster.state.pods[pod.metadata.uid];
  for (const c of pod.spec?.containers ?? []) {
    const crt = prt?.containers[c.name];
    if (!crt || (crt.phase !== "running" && crt.phase !== "stopping")) continue;
    const serving = crt.program?.[crt.pc]?.op === "serve";
    const { info } = lookupImage(crt.image);
    if (!serving || !info?.http || info.defaultPort !== podPort) continue;
    const ctx = {
      podName: pod.metadata.name,
      podIP: pod.status?.podIP ?? "",
      port: podPort,
      path: u.path,
      clientIP: opts.fromPod?.status?.podIP ?? (via === "nodeport" ? "10.244.0.0" : "10.244.0.1"),
      now: unixDate(cluster.now),
      args: [...(c.command ?? []), ...(c.args ?? [])],
    };
    const res = info.http(ctx);
    if (!opts.dryRun) {
      if (info.accessLog) cluster.log(pod.metadata.uid, c.name, crt.restarts, cluster.now, info.accessLog(ctx));
      cluster.markChanged();
      cluster.emit({ type: "traffic", serviceUid: svc?.metadata.uid, podUid: pod.metadata.uid, nodeName, ok: true, via });
    }
    return { ok: true, status: res.status, body: res.body, exitCode: 0, podName: pod.metadata.name, serviceName: svc?.metadata.name };
  }
  if (!opts.dryRun) cluster.emit({ type: "traffic", serviceUid: svc?.metadata.uid, podUid: pod.metadata.uid, nodeName, ok: false, via });
  const shown = target.kind === "service" ? u.host : (pod.status?.podIP ?? u.host);
  return { ok: false, error: refusedMsg(shown, port), exitCode: 7, podName: pod.metadata.name };
}
