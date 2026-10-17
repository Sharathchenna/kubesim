// endpointslice-controller and endpointslicemirroring-controller
// (pkg/controller/endpointslice, pkg/controller/endpointslicemirroring).
//
// For every Service with a selector, keeps EndpointSlices named
// `<service>-<random5>` labelled kubernetes.io/service-name=<service>, one
// endpoint per Pod with ready/serving/terminating conditions (podToEndpoint in
// endpointslice/util). A Service with no Pods gets one placeholder slice with
// `endpoints: null` and `ports: null`, like real clusters.
//
// For a selectorless Service whose Endpoints were written by hand, the
// mirroring controller copies those Endpoints into EndpointSlices, so
// kube-proxy-style routing (traffic.ts) can read slices only.
//
// Names and uids come from a per-Service seeded Rng, not the cluster's, so
// adding this controller doesn't change any other generated name.

import { isPodReady, isPodTerminal, type Cluster } from "../cluster";
import type { EndpointSlice, EndpointSliceEndpoint, EndpointSlicePort, Endpoints, Pod, Service } from "../types";
import { fnv32a, randSuffix, Rng } from "../util";
import { resolveTargetPort } from "./endpoints";

export const SERVICE_NAME_LABEL = "kubernetes.io/service-name";
export const MANAGED_BY_LABEL = "endpointslice.kubernetes.io/managed-by";
export const SLICE_CONTROLLER = "endpointslice-controller.k8s.io";
export const MIRROR_CONTROLLER = "endpointslicemirroring-controller.k8s.io";
/** maxEndpointsPerSlice default (kube-controller-manager --max-endpoints-per-slice). */
const MAX_PER_SLICE = 100;
/** Labels the controller never copies from the Service (reserved ones it sets itself). */
const RESERVED = new Set([SERVICE_NAME_LABEL, MANAGED_BY_LABEL, "service.kubernetes.io/headless"]);

const ipNum = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);

function sliceRng(owner: { metadata: { uid: string } }, n: number): Rng {
  return new Rng(fnv32a(`${owner.metadata.uid}/endpointslice/${n}`));
}

function derivedUid(rng: Rng): string {
  const h = () => rng.int(0x10000).toString(16).padStart(4, "0");
  return `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`;
}

/** A free `<prefix><random5>` name, deterministic per owner. */
function sliceName(cluster: Cluster, owner: { metadata: { uid: string } }, prefix: string, ns: string, taken: Set<string>): { name: string; uid: string } {
  for (let n = 0; ; n++) {
    const rng = sliceRng(owner, n);
    const name = `${prefix}${randSuffix(rng)}`;
    if (taken.has(name) || cluster.raw("EndpointSlice", ns, name)) continue;
    taken.add(name);
    return { name, uid: derivedUid(rng) };
  }
}

interface Desired {
  ports: EndpointSlicePort[] | null;
  endpoints: EndpointSliceEndpoint[] | null;
}

/** Writes `desired` into the owner's existing slices (reusing ones with the same ports), creates the rest, deletes leftovers. */
function reconcile(
  cluster: Cluster,
  owner: { apiVersion: string; kind: string; metadata: { name: string; uid: string } },
  ns: string,
  serviceName: string,
  managedBy: string,
  labels: Record<string, string>,
  desired: Desired[],
): void {
  const existing = cluster
    .list<EndpointSlice>("EndpointSlice", ns)
    .filter((s) => s.metadata.labels?.[SERVICE_NAME_LABEL] === serviceName && s.metadata.labels?.[MANAGED_BY_LABEL] === managedBy);
  const unused = [...existing];
  const taken = new Set<string>();
  for (const d of desired) {
    const key = JSON.stringify(d.ports ?? []);
    let i = unused.findIndex((s) => JSON.stringify(s.ports ?? []) === key);
    // A placeholder (or, when going back to none, any slice) is updated in place rather than replaced.
    if (i < 0) i = unused.findIndex((s) => (s.endpoints ?? []).length === 0);
    if (i < 0 && (d.endpoints ?? []).length === 0) i = unused.length ? 0 : -1;
    const prev = i >= 0 ? unused.splice(i, 1)[0] : undefined;
    const id = prev ? { name: prev.metadata.name, uid: prev.metadata.uid } : sliceName(cluster, owner, `${serviceName}-`, ns, taken);
    const next: EndpointSlice = {
      apiVersion: "discovery.k8s.io/v1",
      kind: "EndpointSlice",
      metadata: {
        name: id.name,
        // Real slices use generateName; it stays on the stored object.
        ...({ generateName: `${serviceName}-` } as object),
        namespace: ns,
        uid: id.uid,
        resourceVersion: prev?.metadata.resourceVersion ?? "",
        creationTimestamp: prev?.metadata.creationTimestamp ?? cluster.now,
        generation: prev ? (prev.metadata.generation ?? 1) : 1,
        labels,
        ownerReferences: [{ apiVersion: owner.apiVersion, kind: owner.kind, name: owner.metadata.name, uid: owner.metadata.uid, controller: true, blockOwnerDeletion: true }],
      },
      addressType: "IPv4",
      endpoints: d.endpoints,
      ports: d.ports,
    };
    if (prev) {
      const same = JSON.stringify({ ...prev, metadata: { ...prev.metadata, resourceVersion: "" } }) === JSON.stringify({ ...next, metadata: { ...next.metadata, resourceVersion: "" } });
      if (!same) next.metadata.generation = (prev.metadata.generation ?? 1) + 1;
    }
    cluster.put(next);
  }
  for (const s of unused) cluster.remove(s);
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export function runEndpointSlices(cluster: Cluster): void {
  const handled = new Set<string>();
  for (const svc of cluster.list<Service>("Service")) {
    const ns = svc.metadata.namespace!;
    const sel = svc.spec?.selector;
    if (!sel || Object.keys(sel).length === 0) {
      mirror(cluster, svc, handled);
      continue;
    }
    // "Services with Type ExternalName receive no endpoints from this controller."
    if (svc.spec?.type === "ExternalName") continue;
    handled.add(`${ns}/${svc.metadata.name}/${SLICE_CONTROLLER}`);
    const publish = !!svc.spec?.publishNotReadyAddresses;
    const headless = svc.spec?.clusterIP === "None";
    const svcPorts = svc.spec?.ports ?? [];
    const groups = new Map<string, { ports: EndpointSlicePort[]; eps: EndpointSliceEndpoint[] }>();
    // ShouldPodBeInEndpoints(pod, includeTerminating=true): terminating Pods stay, with ready=false.
    const pods = cluster
      .list<Pod>("Pod", ns)
      .filter((p) => p.status?.podIP && !isPodTerminal(p) && Object.entries(sel).every(([k, v]) => p.metadata.labels?.[k] === v));
    for (const p of pods) {
      const ports: EndpointSlicePort[] = [];
      for (const sp of svcPorts) {
        const port = resolveTargetPort(p, sp);
        const appProtocol = (sp as { appProtocol?: string }).appProtocol;
        if (port !== undefined) ports.push({ name: sp.name ?? "", port, protocol: sp.protocol ?? "TCP", ...(appProtocol ? { appProtocol } : {}) });
      }
      if (svcPorts.length > 0 && ports.length === 0) continue;
      const key = JSON.stringify(ports);
      const g = groups.get(key) ?? { ports, eps: [] };
      groups.set(key, g);
      const serving = isPodReady(p);
      const terminating = p.metadata.deletionTimestamp !== undefined;
      const node = p.spec?.nodeName ? cluster.raw("Node", undefined, p.spec.nodeName) : undefined;
      const zone = node?.metadata.labels?.["topology.kubernetes.io/zone"];
      g.eps.push({
        addresses: [p.status!.podIP!],
        // "ready should never be true if a pod is terminating, unless publishNotReadyAddresses was set."
        conditions: { ready: publish || (serving && !terminating), serving, terminating },
        ...(p.spec?.hostname && p.spec.subdomain === svc.metadata.name ? { hostname: p.spec.hostname } : {}),
        ...(p.spec?.nodeName ? { nodeName: p.spec.nodeName } : {}),
        targetRef: { kind: "Pod", name: p.metadata.name, namespace: ns, uid: p.metadata.uid },
        ...(zone ? { zone } : {}),
      });
    }
    const desired: Desired[] = [];
    for (const g of groups.values()) {
      g.eps.sort((a, b) => ipNum(a.addresses[0]) - ipNum(b.addresses[0]));
      for (const part of chunk(g.eps, MAX_PER_SLICE)) desired.push({ ports: g.ports.length ? g.ports : null, endpoints: part });
    }
    if (desired.length === 0) desired.push({ ports: null, endpoints: null });
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(svc.metadata.labels ?? {})) if (!RESERVED.has(k)) labels[k] = v;
    if (headless) labels["service.kubernetes.io/headless"] = "";
    labels[SERVICE_NAME_LABEL] = svc.metadata.name;
    labels[MANAGED_BY_LABEL] = SLICE_CONTROLLER;
    reconcile(cluster, svc, ns, svc.metadata.name, SLICE_CONTROLLER, labels, desired);
  }
  // Controller-managed slices with nothing left to manage (Service deleted, selector removed,
  // became ExternalName, mirrored Endpoints deleted) go away.
  for (const s of cluster.list<EndpointSlice>("EndpointSlice")) {
    const by = s.metadata.labels?.[MANAGED_BY_LABEL];
    if (by !== SLICE_CONTROLLER && by !== MIRROR_CONTROLLER) continue;
    if (!handled.has(`${s.metadata.namespace}/${s.metadata.labels?.[SERVICE_NAME_LABEL]}/${by}`)) cluster.remove(s);
  }
}

/** endpointslicemirroring-controller: hand-written Endpoints of a selectorless Service, copied into slices. */
function mirror(cluster: Cluster, svc: Service, handled: Set<string>): void {
  const ns = svc.metadata.namespace!;
  const ep = cluster.raw("Endpoints", ns, svc.metadata.name) as unknown as Endpoints | undefined;
  if (!ep || ep.metadata.labels?.["endpointslice.kubernetes.io/skip-mirror"] === "true") return;
  handled.add(`${ns}/${svc.metadata.name}/${MIRROR_CONTROLLER}`);
  const desired: Desired[] = [];
  for (const sub of ep.subsets ?? []) {
    const ports: EndpointSlicePort[] = (sub.ports ?? []).map((p) => ({ name: p.name ?? "", port: p.port, protocol: p.protocol ?? "TCP" }));
    const toEp = (ready: boolean) => (a: NonNullable<typeof sub.addresses>[number]): EndpointSliceEndpoint => ({
      addresses: [a.ip],
      conditions: { ready },
      ...(a.hostname ? { hostname: a.hostname } : {}),
      ...(a.nodeName ? { nodeName: a.nodeName } : {}),
      ...(a.targetRef ? { targetRef: a.targetRef } : {}),
    });
    const eps = [...(sub.addresses ?? []).map(toEp(true)), ...(sub.notReadyAddresses ?? []).map(toEp(false))];
    for (const part of chunk(eps, MAX_PER_SLICE)) desired.push({ ports: ports.length ? ports : null, endpoints: part });
  }
  if (desired.length === 0) return;
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(ep.metadata.labels ?? {})) if (!RESERVED.has(k)) labels[k] = v;
  labels[SERVICE_NAME_LABEL] = svc.metadata.name;
  labels[MANAGED_BY_LABEL] = MIRROR_CONTROLLER;
  reconcile(cluster, ep, ns, svc.metadata.name, MIRROR_CONTROLLER, labels, desired);
}

/** EndpointSlices that belong to a Service (any manager, as kube-proxy sees them). */
export function slicesFor(cluster: Cluster, svc: { metadata: { name: string; namespace?: string } }): EndpointSlice[] {
  return cluster.list<EndpointSlice>("EndpointSlice", svc.metadata.namespace).filter((s) => s.metadata.labels?.[SERVICE_NAME_LABEL] === svc.metadata.name);
}
