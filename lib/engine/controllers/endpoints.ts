// endpoints-controller: keeps one Endpoints object per selector Service,
// listing ready and not-ready Pod addresses; terminating Pods are left out
// unless publishNotReadyAddresses is set (behaviour reference §7.2).

import { isPodReady, isPodTerminal, type Cluster } from "../cluster";
import type { EndpointAddress, EndpointSubset, Endpoints, Pod, Service, ServicePort } from "../types";

export function resolveTargetPort(pod: Pod, p: ServicePort): number | undefined {
  const tp = p.targetPort ?? p.port;
  if (typeof tp === "number") return tp;
  if (/^\d+$/.test(tp)) return parseInt(tp, 10);
  for (const c of pod.spec?.containers ?? []) for (const cp of c.ports ?? []) if (cp.name === tp) return cp.containerPort;
  return undefined;
}

export function runEndpoints(cluster: Cluster): void {
  for (const svc of cluster.list<Service>("Service")) {
    const sel = svc.spec?.selector;
    if (!sel || Object.keys(sel).length === 0) continue;
    const ns = svc.metadata.namespace!;
    const pods = cluster
      .list<Pod>("Pod", ns)
      // ShouldPodBeInEndpoints(pod, includeTerminating = publishNotReadyAddresses): terminating Pods drop out.
      .filter((p) => p.status?.podIP && !isPodTerminal(p) && (svc.spec?.publishNotReadyAddresses || p.metadata.deletionTimestamp === undefined) && Object.entries(sel).every(([k, v]) => p.metadata.labels?.[k] === v));

    // Group by resolved port set (named targetPorts can differ per Pod).
    const groups = new Map<string, { ports: { name?: string; port: number; protocol: string }[]; ready: EndpointAddress[]; notReady: EndpointAddress[] }>();
    for (const p of pods) {
      const ports: { name?: string; port: number; protocol: string }[] = [];
      for (const sp of svc.spec?.ports ?? []) {
        const port = resolveTargetPort(p, sp);
        if (port !== undefined) ports.push({ ...(sp.name ? { name: sp.name } : {}), port, protocol: sp.protocol ?? "TCP" });
      }
      // A headless Service with no ports still lists its Pods (addEndpointSubset with no port).
      if (ports.length === 0 && !((svc.spec?.ports ?? []).length === 0 && svc.spec?.clusterIP === "None")) continue;
      const key = JSON.stringify(ports);
      const g = groups.get(key) ?? { ports, ready: [], notReady: [] };
      groups.set(key, g);
      const addr: EndpointAddress = {
        ip: p.status!.podIP!,
        // Pods with a hostname under this (headless) Service get their own DNS name.
        ...(p.spec?.hostname && p.spec.subdomain === svc.metadata.name ? { hostname: p.spec.hostname } : {}),
        nodeName: p.spec?.nodeName,
        targetRef: { kind: "Pod", name: p.metadata.name, namespace: ns, uid: p.metadata.uid },
      };
      if (svc.spec?.publishNotReadyAddresses || (isPodReady(p) && p.metadata.deletionTimestamp === undefined)) g.ready.push(addr);
      else g.notReady.push(addr);
    }
    const ipNum = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
    const byIp = (a: EndpointAddress, b: EndpointAddress) => ipNum(a.ip) - ipNum(b.ip);
    const subsets: EndpointSubset[] = [...groups.values()].map((g) => ({
      ...(g.ready.length ? { addresses: g.ready.sort(byIp) } : {}),
      ...(g.notReady.length ? { notReadyAddresses: g.notReady.sort(byIp) } : {}),
      ...(g.ports.length ? { ports: g.ports } : {}),
    }));

    const existing = cluster.raw("Endpoints", ns, svc.metadata.name) as unknown as Endpoints | undefined;
    const next: Endpoints = {
      apiVersion: "v1",
      kind: "Endpoints",
      metadata: {
        name: svc.metadata.name,
        namespace: ns,
        uid: existing?.metadata.uid ?? cluster.uid(),
        resourceVersion: existing?.metadata.resourceVersion ?? "",
        creationTimestamp: existing?.metadata.creationTimestamp ?? cluster.now,
        ...(svc.metadata.labels ? { labels: svc.metadata.labels } : {}),
      },
      ...(subsets.length ? { subsets } : {}),
    };
    cluster.put(next);
  }
}
