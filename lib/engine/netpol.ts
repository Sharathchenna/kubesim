// NetworkPolicy enforcement (networking.k8s.io/v1), as a policy-aware CNI does
// it: a Pod selected by a policy of a type is isolated for that direction, and
// traffic is allowed only if some rule of some selecting policy allows it.
// Kubelet probes are never blocked. See behaviour reference v2 §8.

import type { Cluster } from "./cluster";
import type { Namespace, NetworkPolicy, NetworkPolicyPeer, NetworkPolicyPort, Pod } from "./types";
import { matchesSelectorString } from "./util";

export interface Endpoint {
  pod?: Pod;
  ip: string;
}

export function policyTypes(np: NetworkPolicy): ("Ingress" | "Egress")[] {
  const t = np.spec?.policyTypes;
  if (t && t.length) return t;
  return np.spec?.egress ? ["Ingress", "Egress"] : ["Ingress"];
}

/** Policies in a Pod's namespace that select it for a direction. */
export function selectingPolicies(cluster: Cluster, pod: Pod, dir: "Ingress" | "Egress"): NetworkPolicy[] {
  return cluster
    .list<NetworkPolicy>("NetworkPolicy", pod.metadata.namespace)
    .filter((np) => policyTypes(np).includes(dir) && matchesSelectorString(pod.metadata.labels, np.spec?.podSelector ?? {}));
}

export function isIsolated(cluster: Cluster, pod: Pod, dir: "Ingress" | "Egress"): boolean {
  return selectingPolicies(cluster, pod, dir).length > 0;
}

function ipToInt(ip: string): number | undefined {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return undefined;
  return ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4];
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsS] = cidr.split("/");
  const a = ipToInt(ip);
  const b = ipToInt(base);
  if (a === undefined || b === undefined) return false;
  const bits = bitsS === undefined ? 32 : parseInt(bitsS, 10);
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function peerMatches(cluster: Cluster, policyNs: string, peer: NetworkPolicyPeer, target: Endpoint): boolean {
  if (peer.ipBlock) {
    if (!inCidr(target.ip, peer.ipBlock.cidr)) return false;
    return !(peer.ipBlock.except ?? []).some((e) => inCidr(target.ip, e));
  }
  const pod = target.pod;
  if (!pod) return false;
  const ns = pod.metadata.namespace ?? "default";
  if (peer.namespaceSelector) {
    const nsObj = cluster.raw("Namespace", undefined, ns) as unknown as Namespace | undefined;
    if (!matchesSelectorString(nsObj?.metadata.labels, peer.namespaceSelector)) return false;
  } else if (ns !== policyNs) return false;
  if (peer.podSelector) return matchesSelectorString(pod.metadata.labels, peer.podSelector);
  return true;
}

function portMatches(ports: NetworkPolicyPort[] | undefined, port: number, protocol: string, pod?: Pod): boolean {
  if (!ports || ports.length === 0) return true;
  return ports.some((p) => {
    if ((p.protocol ?? "TCP") !== protocol) return false;
    if (p.port === undefined) return true;
    if (typeof p.port === "number") return p.endPort ? port >= p.port && port <= p.endPort : port === p.port;
    if (/^\d+$/.test(p.port)) return port === parseInt(p.port, 10);
    // Named port: resolved against the destination Pod's container ports.
    return (pod?.spec?.containers ?? []).some((c) => (c.ports ?? []).some((cp) => cp.name === p.port && cp.containerPort === port));
  });
}

/** Whether `dst` accepts traffic from `src` on a port (ingress side). */
export function ingressAllowed(cluster: Cluster, src: Endpoint, dst: Pod, port: number, protocol = "TCP"): { ok: boolean; policies: NetworkPolicy[] } {
  const pols = selectingPolicies(cluster, dst, "Ingress");
  if (pols.length === 0) return { ok: true, policies: [] };
  const ns = dst.metadata.namespace ?? "default";
  const ok = pols.some((np) =>
    (np.spec?.ingress ?? []).some((rule) => portMatches(rule.ports, port, protocol, dst) && (!rule.from || rule.from.length === 0 || rule.from.some((peer) => peerMatches(cluster, ns, peer, src)))),
  );
  return { ok, policies: pols };
}

/** Whether `src` may send traffic to `dst` on a port (egress side). */
export function egressAllowed(cluster: Cluster, src: Pod, dst: Endpoint, port: number, protocol = "TCP"): { ok: boolean; policies: NetworkPolicy[] } {
  const pols = selectingPolicies(cluster, src, "Egress");
  if (pols.length === 0) return { ok: true, policies: [] };
  const ns = src.metadata.namespace ?? "default";
  const ok = pols.some((np) =>
    (np.spec?.egress ?? []).some((rule) => portMatches(rule.ports, port, protocol, dst.pod) && (!rule.to || rule.to.length === 0 || rule.to.some((peer) => peerMatches(cluster, ns, peer, dst)))),
  );
  return { ok, policies: pols };
}

/** Both sides of a connection. */
export function connectionAllowed(cluster: Cluster, src: Endpoint, dst: Pod, port: number, protocol = "TCP"): boolean {
  if (src.pod && !egressAllowed(cluster, src.pod, { pod: dst, ip: dst.status?.podIP ?? "" }, port, protocol).ok) return false;
  return ingressAllowed(cluster, src, dst, port, protocol).ok;
}

/** Can this Pod reach cluster DNS? An egress policy that forgets port 53 breaks every name lookup. */
export function dnsAllowed(cluster: Cluster, src: Pod): boolean {
  if (!isIsolated(cluster, src, "Egress")) return true;
  const dns = cluster.list<Pod>("Pod", "kube-system").filter((p) => p.metadata.labels?.["k8s-app"] === "kube-dns");
  const targets: Endpoint[] = dns.length
    ? dns.map((p) => ({ pod: p, ip: p.status?.podIP ?? "" }))
    : [{ ip: "10.244.0.2", pod: { apiVersion: "v1", kind: "Pod", metadata: { name: "coredns", namespace: "kube-system", uid: "", resourceVersion: "", creationTimestamp: 0, labels: { "k8s-app": "kube-dns" } } } as Pod }];
  return targets.some((t) => egressAllowed(cluster, src, t, 53, "UDP").ok || egressAllowed(cluster, src, t, 53, "TCP").ok);
}
