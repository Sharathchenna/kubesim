// In-cluster networking: DNS (Services, headless Services, StatefulSet Pod
// names), Service load-balancing (kube-proxy), NodePorts, LoadBalancer IPs,
// the ingress-nginx controller, NetworkPolicy, and HTTP to container Programs.
// Used by `curl` in the terminal, `kubectl exec … -- wget`, container
// programs (load generators) and the Cluster View's traffic animation.

import type { Cluster } from "./cluster";
import { containerFs } from "./fs";
import { listenPorts, lookupImage, NGINX_404, NGINX_503, type HttpResponse } from "./images";
import { connectionAllowed, dnsAllowed } from "./netpol";
import type { Endpoints, Ingress, IngressBackend, Node, Pod, Service } from "./types";
import { unixDate } from "./util";

export interface TrafficResult {
  ok: boolean;
  status?: number;
  body?: string;
  /** curl-style error line when !ok. */
  error?: string;
  exitCode: number;
  podName?: string;
  serviceName?: string;
  ingressName?: string;
  /** The connection was dropped by a NetworkPolicy. */
  blocked?: boolean;
}

export interface RequestOptions {
  /** Pod the request comes from (for DNS search path and localhost); omit for "from the terminal". */
  fromPod?: Pod;
  /** Only resolve, don't log or emit (used by previews). */
  dryRun?: boolean;
  /** Don't animate (probes). */
  quiet?: boolean;
  /** curl -H "Host: …". */
  hostHeader?: string;
}

export function parseUrl(url: string): { host: string; port?: number; path: string; scheme: string } | undefined {
  const m = url.match(/^(?:(https?):\/\/)?([^/:?#]+)(?::(\d+))?([^#]*)?/);
  if (!m) return undefined;
  return { scheme: m[1] ?? "http", host: m[2], port: m[3] ? parseInt(m[3], 10) : undefined, path: m[4] || "/" };
}

const isIp = (h: string) => /^\d+\.\d+\.\d+\.\d+$/.test(h);
const INGRESS_NS = "ingress-nginx";

/** Ready (or all, for publishNotReadyAddresses) endpoint addresses of a Service. */
function endpointAddrs(cluster: Cluster, svc: Service): { ip: string; hostname?: string; uid?: string; ports: { name?: string; port: number }[] }[] {
  const ep = cluster.raw("Endpoints", svc.metadata.namespace, svc.metadata.name) as unknown as Endpoints | undefined;
  return (ep?.subsets ?? []).flatMap((s) =>
    [...(s.addresses ?? []), ...(svc.spec?.publishNotReadyAddresses ? (s.notReadyAddresses ?? []) : [])].map((a) => ({ ip: a.ip, hostname: a.hostname, uid: a.targetRef?.uid, ports: s.ports ?? [] })),
  );
}

export interface Resolution {
  ips: string[];
  fqdn?: string;
  /** DNS itself was unreachable (NetworkPolicy, or no CoreDNS). */
  blocked?: boolean;
  svc?: Service;
  pod?: Pod;
}

function coreDnsUp(cluster: Cluster): boolean {
  const svc = cluster.raw("Service", "kube-system", "kube-dns") as unknown as Service | undefined;
  if (!svc) return true; // no system Pods in this cluster: resolve anyway
  return endpointAddrs(cluster, svc).length > 0;
}

/** Resolves a name the way a Pod's resolv.conf would (search path, ndots:5). */
export function resolveName(cluster: Cluster, name: string, fromPod?: Pod): Resolution {
  const host = name.replace(/\.$/, "");
  if (isIp(host)) return { ips: [host], fqdn: host };
  if (host === "localhost") return { ips: ["127.0.0.1"], fqdn: "localhost" };
  if (fromPod && !dnsAllowed(cluster, fromPod)) return { ips: [], blocked: true };
  if (!coreDnsUp(cluster)) return { ips: [], blocked: true };
  const ns = fromPod?.metadata.namespace ?? "default";
  const candidates = name.endsWith(".") || host.split(".").length > 5 ? [host] : [`${host}.${ns}.svc.cluster.local`, `${host}.svc.cluster.local`, `${host}.cluster.local`, host];
  for (const fqdn of candidates) {
    const r = lookupFqdn(cluster, fqdn);
    if (r) return { ...r, fqdn };
  }
  return { ips: [], fqdn: candidates[0] };
}

function lookupFqdn(cluster: Cluster, fqdn: string): Omit<Resolution, "fqdn"> | undefined {
  const parts = fqdn.split(".");
  // <svc>.<ns>.svc.cluster.local
  if (parts.length === 5 && parts.slice(2).join(".") === "svc.cluster.local") {
    const svc = cluster.raw("Service", parts[1], parts[0]) as unknown as Service | undefined;
    if (!svc) return undefined;
    if (svc.spec?.type === "ExternalName") return { ips: [], svc };
    if (svc.spec?.clusterIP === "None") return { ips: endpointAddrs(cluster, svc).map((a) => a.ip), svc };
    return { ips: [svc.spec!.clusterIP!], svc };
  }
  // <hostname>.<svc>.<ns>.svc.cluster.local (StatefulSet Pods behind a headless Service)
  if (parts.length === 6 && parts.slice(3).join(".") === "svc.cluster.local") {
    const svc = cluster.raw("Service", parts[2], parts[1]) as unknown as Service | undefined;
    if (!svc || svc.spec?.clusterIP !== "None") return undefined;
    const pod = cluster.list<Pod>("Pod", parts[2]).find((p) => (p.spec?.hostname ?? p.metadata.name) === parts[0] && p.spec?.subdomain === parts[1] && p.status?.podIP);
    const addr = endpointAddrs(cluster, svc).find((a) => a.hostname === parts[0]) ?? (pod && svc.spec?.publishNotReadyAddresses ? { ip: pod.status!.podIP! } : undefined);
    if (!addr) return undefined;
    return { ips: [addr.ip], pod };
  }
  // a-b-c-d.<ns>.pod.cluster.local
  if (parts.length === 5 && parts.slice(2).join(".") === "pod.cluster.local" && /^\d+-\d+-\d+-\d+$/.test(parts[0])) {
    return { ips: [parts[0].replace(/-/g, ".")] };
  }
  return undefined;
}

type Target =
  | { kind: "service"; svc: Service; port: number; via: "clusterip" | "nodeport" | "lb" }
  | { kind: "pod"; pod: Pod; port: number }
  | { kind: "ingress" }
  | { kind: "none"; error: string; exitCode: number };

const refusedMsg = (host: string, port: number) => `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server`;
const timeoutMsg = (host: string, port: number) => `curl: (28) Failed to connect to ${host} port ${port} after 10002 ms: Timeout was reached`;
const refused = (host: string, port: number): Target => ({ kind: "none", error: refusedMsg(host, port), exitCode: 7 });
const timeout = (host: string, port: number): Target => ({ kind: "none", error: timeoutMsg(host, port), exitCode: 28 });

/** Hosts an Ingress rule answers for. */
function ingressHosts(cluster: Cluster): Set<string> {
  const s = new Set<string>();
  for (const ing of cluster.list<Ingress>("Ingress")) for (const r of ing.spec?.rules ?? []) if (r.host) s.add(r.host);
  return s;
}

function ingressController(cluster: Cluster): Pod | undefined {
  return cluster.list<Pod>("Pod", INGRESS_NS).find((p) => p.metadata.labels?.["app.kubernetes.io/component"] === "controller" && p.status?.phase === "Running" && !p.metadata.deletionTimestamp);
}

function resolveTarget(cluster: Cluster, host: string, port: number, from: Pod | undefined): Target {
  if ((host === "localhost" || host === "127.0.0.1") && from) return { kind: "pod", pod: from, port };
  // From the terminal: localhost and Ingress hostnames go to the ingress controller (kind's port mapping).
  if (!from && (host === "localhost" || host === "127.0.0.1" || ingressHosts(cluster).has(host) || [...ingressHosts(cluster)].some((h) => h.startsWith("*.") && host.endsWith(h.slice(1))))) {
    if (port !== 80 && port !== 443) return refused(host, port);
    return ingressController(cluster) ? { kind: "ingress" } : refused(host, port);
  }
  let ip = host;
  if (!isIp(host)) {
    const r = resolveName(cluster, host, from);
    if (r.svc?.spec?.type === "ExternalName") return { kind: "none", error: `curl: (6) Could not resolve host: ${r.svc.spec.externalName}`, exitCode: 6 };
    if (!r.ips.length) return { kind: "none", error: `curl: (6) Could not resolve host: ${host}`, exitCode: 6 };
    ip = r.ips[r.ips.length > 1 ? cluster.rng.int(r.ips.length) : 0];
  }
  const svcs = cluster.list<Service>("Service");
  const byIp = svcs.find((s) => s.spec?.clusterIP === ip && ip !== "None");
  if (byIp) return { kind: "service", svc: byIp, port, via: "clusterip" };
  const lb = svcs.find((s) => s.status?.loadBalancer?.ingress?.some((i) => i.ip === ip));
  if (lb) return { kind: "service", svc: lb, port, via: "lb" };
  const node = cluster.list<Node>("Node").find((n) => n.status?.addresses.some((a) => a.address === ip));
  if (node) {
    if (cluster.state.nodes[node.metadata.name]?.up === false) return timeout(host, port);
    const np = svcs.find((s) => s.spec?.ports?.some((p) => p.nodePort === port));
    if (np) return { kind: "service", svc: np, port: np.spec!.ports!.find((p) => p.nodePort === port)!.port, via: "nodeport" };
    if ((port === 80 || port === 443) && ingressController(cluster)) return { kind: "ingress" };
    return refused(host, port);
  }
  const pod = cluster.list<Pod>("Pod").find((p) => p.status?.podIP === ip && !p.spec?.hostNetwork && !p.metadata.annotations?.["kubernetes.io/config.source"]);
  if (pod) return { kind: "pod", pod, port };
  return timeout(host, port);
}

/** Sends an HTTP GET inside the cluster. */
export function request(cluster: Cluster, url: string, opts: RequestOptions = {}): TrafficResult {
  const u = parseUrl(url);
  if (!u) return { ok: false, error: `curl: (3) URL rejected: Malformed input to a URL function`, exitCode: 3 };
  const port = u.port ?? (u.scheme === "https" ? 443 : 80);
  const target = resolveTarget(cluster, u.host, port, opts.fromPod);
  if (target.kind === "none") return { ok: false, error: target.error, exitCode: target.exitCode };
  if (target.kind === "ingress") return viaIngress(cluster, u, opts);
  const src = opts.fromPod ? { pod: opts.fromPod, ip: opts.fromPod.status?.podIP ?? "" } : { ip: target.kind === "service" && target.via !== "clusterip" ? "172.18.0.1" : "10.244.0.1" };
  if (target.kind === "service") return viaService(cluster, target.svc, target.port, u.host, u.path, src, opts, target.via);
  return toPod(cluster, target.pod, port, u.path, u.host, src, opts, {});
}

function viaService(
  cluster: Cluster,
  svc: Service,
  port: number,
  shownHost: string,
  path: string,
  src: { pod?: Pod; ip: string },
  opts: RequestOptions,
  via: "clusterip" | "nodeport" | "lb" | "ingress",
  extra: { ingressUid?: string; hostHeader?: string } = {},
): TrafficResult {
  const sp = svc.spec?.ports?.find((p) => p.port === port);
  if (!sp) return { ok: false, error: timeoutMsg(shownHost, port), exitCode: 28 };
  const ready = endpointAddrs(cluster, svc).map((a) => ({ a, port: a.ports.find((p) => p.name === sp.name || (!p.name && !sp.name))?.port ?? a.ports[0]?.port ?? port }));
  if (ready.length === 0) return { ok: false, error: refusedMsg(shownHost, port), exitCode: 7, serviceName: svc.metadata.name };
  const pick = ready[cluster.rng.int(ready.length)];
  const pod = cluster.byUid(pick.a.uid ?? "") as unknown as Pod | undefined;
  if (!pod) return { ok: false, error: refusedMsg(shownHost, port), exitCode: 7 };
  const r = toPod(cluster, pod, pick.port, path, shownHost, src, opts, { serviceUid: svc.metadata.uid, via, ...extra });
  return { ...r, serviceName: svc.metadata.name };
}

function toPod(
  cluster: Cluster,
  pod: Pod,
  podPort: number,
  path: string,
  shownHost: string,
  src: { pod?: Pod; ip: string },
  opts: RequestOptions,
  sig: { serviceUid?: string; via?: "clusterip" | "nodeport" | "lb" | "ingress" | "pod"; ingressUid?: string; hostHeader?: string },
): TrafficResult {
  const nodeName = pod.spec?.nodeName;
  const via = sig.via ?? "pod";
  const emit = (ok: boolean, blocked = false) => {
    if (!opts.dryRun && !opts.quiet) cluster.emit({ type: "traffic", serviceUid: sig.serviceUid, ingressUid: sig.ingressUid, podUid: pod.metadata.uid, nodeName, ok, via, blocked, fromUid: src.pod?.metadata.uid });
  };
  if (!nodeName || cluster.state.nodes[nodeName]?.up === false) {
    return { ok: false, error: timeoutMsg(shownHost, podPort), exitCode: 28, podName: pod.metadata.name };
  }
  // NetworkPolicy drops the packets: the client sees a timeout, not a refusal.
  if (src.pod !== pod && !connectionAllowed(cluster, src, pod, podPort)) {
    emit(false, true);
    return { ok: false, error: timeoutMsg(shownHost, podPort), exitCode: 28, podName: pod.metadata.name, blocked: true };
  }
  const prt = cluster.state.pods[pod.metadata.uid];
  for (const c of pod.spec?.containers ?? []) {
    const crt = prt?.containers[c.name];
    if (!crt || (crt.phase !== "running" && crt.phase !== "stopping")) continue;
    const serving = crt.program?.[crt.pc]?.op === "serve" && crt.wakeAt <= cluster.now;
    const { info } = lookupImage(crt.image);
    if (!serving || !info?.http || !listenPorts(info, c).includes(podPort)) continue;
    const fs = containerFs(cluster, pod, c, crt);
    const [p, q = ""] = path.split("?");
    const ctx = {
      podName: pod.spec?.hostname ?? pod.metadata.name,
      podIP: pod.status?.podIP ?? "",
      port: podPort,
      path,
      query: Object.fromEntries(q.split("&").filter(Boolean).map((kv) => { const [k, v = ""] = kv.split("="); return [decodeURIComponent(k), decodeURIComponent(v)]; })),
      clientIP: src.ip,
      now: unixDate(cluster.now),
      args: [...(c.command ?? []), ...(c.args ?? []), ...(crt.image.endsWith(":2.0") ? ["__v2"] : [])],
      uptimeMs: cluster.now - (crt.startedAt ?? cluster.now),
      read: (f: string) => fs.read(f),
      isDir: (f: string) => fs.isDir(f),
      host: sig.hostHeader,
    };
    void p;
    const res: HttpResponse = info.http(ctx);
    if (!opts.dryRun) {
      if (info.accessLog && !opts.quiet) cluster.log(pod.metadata.uid, c.name, crt.restarts, cluster.now, info.accessLog(ctx, res));
      (crt.reqs ??= []).push(cluster.now);
      if (crt.reqs.length > 400) crt.reqs.splice(0, crt.reqs.length - 400);
      cluster.markChanged();
      emit(true);
    }
    return { ok: true, status: res.status, body: res.body, exitCode: 0, podName: pod.metadata.name };
  }
  if (!opts.dryRun) emit(false);
  const shown = sig.serviceUid || sig.ingressUid ? shownHost : (pod.status?.podIP ?? shownHost);
  return { ok: false, error: refusedMsg(shown, podPort), exitCode: 7, podName: pod.metadata.name };
}

// ---------- Ingress (ingress-nginx) ----------

function hostMatches(ruleHost: string | undefined, host: string): boolean {
  if (!ruleHost) return true;
  if (ruleHost.startsWith("*.")) return host.endsWith(ruleHost.slice(1)) && host.split(".").length === ruleHost.split(".").length;
  return ruleHost === host;
}

function pathMatches(type: string, rulePath: string, reqPath: string, regex: boolean): { ok: boolean; len: number; m?: RegExpMatchArray } {
  if (regex) {
    const m = reqPath.match(new RegExp(`^${rulePath}`, "i"));
    return m ? { ok: true, len: rulePath.length, m } : { ok: false, len: 0 };
  }
  if (type === "Exact") return { ok: reqPath === rulePath, len: rulePath.length + 1 };
  // Prefix: element-wise match on "/"-separated parts.
  const rp = rulePath.replace(/\/+$/, "");
  const ok = rp === "" || reqPath === rp || reqPath.startsWith(rp + "/");
  return { ok, len: rp.length };
}

export interface IngressRoute {
  ingress: Ingress;
  backend: IngressBackend;
  path: string;
}

/** Picks the Ingress rule for a host and path: exact host before wildcard before hostless, longest path first. */
export function routeIngress(cluster: Cluster, host: string, reqPath: string): (IngressRoute & { rewritten: string }) | undefined {
  const ings = cluster.list<Ingress>("Ingress").filter((i) => !i.spec?.ingressClassName || i.spec.ingressClassName === "nginx");
  let best: (IngressRoute & { rewritten: string; score: number }) | undefined;
  for (const ing of ings) {
    const regex = ing.metadata.annotations?.["nginx.ingress.kubernetes.io/use-regex"] === "true" || !!ing.metadata.annotations?.["nginx.ingress.kubernetes.io/rewrite-target"];
    const rewrite = ing.metadata.annotations?.["nginx.ingress.kubernetes.io/rewrite-target"];
    for (const rule of ing.spec?.rules ?? []) {
      if (!hostMatches(rule.host, host)) continue;
      const hostScore = rule.host ? (rule.host.startsWith("*.") ? 1 : 2) : 0;
      for (const p of rule.http?.paths ?? []) {
        const m = pathMatches(p.pathType, p.path ?? "/", reqPath.split("?")[0], regex && p.pathType === "ImplementationSpecific" ? true : regex);
        if (!m.ok) continue;
        const score = hostScore * 10_000 + m.len;
        if (best && best.score >= score) continue;
        let rewritten = reqPath;
        if (rewrite) {
          rewritten = rewrite.replace(/\$(\d)/g, (_, n) => m.m?.[+n] ?? "");
          if (!rewritten.startsWith("/")) rewritten = "/" + rewritten;
        }
        best = { ingress: ing, backend: p.backend, path: p.path ?? "/", rewritten, score };
      }
    }
    if (!best && ing.spec?.defaultBackend && !(ing.spec.rules ?? []).some((r) => hostMatches(r.host, host))) {
      best = { ingress: ing, backend: ing.spec.defaultBackend, path: "", rewritten: reqPath, score: -1 };
    }
  }
  return best;
}

function viaIngress(cluster: Cluster, u: { host: string; path: string; port?: number }, opts: RequestOptions): TrafficResult {
  const controller = ingressController(cluster)!;
  const host = opts.hostHeader ?? (isIp(u.host) || u.host === "localhost" ? "" : u.host);
  const route = routeIngress(cluster, host, u.path);
  if (!route?.backend.service) return { ok: true, status: 404, body: NGINX_404, exitCode: 0 };
  const svc = cluster.raw("Service", route.ingress.metadata.namespace, route.backend.service.name) as unknown as Service | undefined;
  const unavailable = { ok: true, status: 503, body: NGINX_503, exitCode: 0, ingressName: route.ingress.metadata.name };
  if (!svc) return unavailable;
  const bp = route.backend.service.port;
  const sp = svc.spec?.ports?.find((p) => (bp.number !== undefined ? p.port === bp.number : p.name === bp.name));
  if (!sp) return unavailable;
  const src = { pod: controller, ip: controller.status?.podIP ?? "" };
  const r = viaService(cluster, svc, sp.port, u.host, route.rewritten, src, opts, "ingress", { ingressUid: route.ingress.metadata.uid, hostHeader: host });
  // nginx answers for the backend: failures become 502/503/504 pages.
  if (!r.ok) return { ...unavailable, status: r.blocked ? 504 : r.exitCode === 7 && r.podName ? 502 : 503, body: r.blocked ? nginxPage(504, "Gateway Time-out") : r.exitCode === 7 && r.podName ? nginxPage(502, "Bad Gateway") : NGINX_503 };
  return { ...r, ingressName: route.ingress.metadata.name };
}

const nginxPage = (code: number, text: string) => `<html>\n<head><title>${code} ${text}</title></head>\n<body>\n<center><h1>${code} ${text}</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>`;
