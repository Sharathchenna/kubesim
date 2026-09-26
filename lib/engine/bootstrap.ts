// Builds a fresh cluster: built-in namespaces, Nodes, the `kubernetes` and
// `kube-dns` Services, and (optionally) the kube-system Pods.

import type { Cluster } from "./cluster";
import { addNode } from "./nodes";
import { parseImage } from "./images";
import type { Deployment, Endpoints, Pod, Service } from "./types";

const SYSTEM_IMAGES = {
  etcd: "registry.k8s.io/etcd:3.6.4-0",
  "kube-apiserver": "registry.k8s.io/kube-apiserver:v1.37.0",
  "kube-controller-manager": "registry.k8s.io/kube-controller-manager:v1.37.0",
  "kube-scheduler": "registry.k8s.io/kube-scheduler:v1.37.0",
  "kube-proxy": "registry.k8s.io/kube-proxy:v1.37.0",
  coredns: "registry.k8s.io/coredns/coredns:v1.12.1",
};

export function bootstrap(cluster: Cluster): void {
  for (const name of ["default", "kube-node-lease", "kube-public", "kube-system"]) {
    cluster.create({ apiVersion: "v1", kind: "Namespace", metadata: { name } });
  }
  for (const n of cluster.state.config.nodes) addNode(cluster, n.name, n.role);
  const cp = cluster.state.config.nodes.find((n) => n.role === "control-plane")?.name ?? cluster.state.config.nodes[0]?.name;

  cluster.create<Service>({
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "kubernetes", namespace: "default", labels: { component: "apiserver", provider: "kubernetes" } },
    spec: { clusterIP: "10.96.0.1", ports: [{ name: "https", port: 443, protocol: "TCP", targetPort: 6443 }] },
  });
  cluster.put<Endpoints>({
    apiVersion: "v1",
    kind: "Endpoints",
    metadata: { name: "kubernetes", namespace: "default", uid: cluster.uid(), resourceVersion: "", creationTimestamp: cluster.now, labels: { "endpointslice.kubernetes.io/skip-mirror": "true" } },
    subsets: [{ addresses: [{ ip: "172.18.0.2" }], ports: [{ name: "https", port: 6443, protocol: "TCP" }] }],
  });

  if (!cluster.state.config.systemPods) return;

  // Pre-pulled on every Node, so system Pods start fast.
  for (const rt of Object.values(cluster.state.nodes)) rt.images.push(...Object.values(SYSTEM_IMAGES).map((i) => parseImage(i).full));

  cluster.create<Service>({
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: "kube-dns",
      namespace: "kube-system",
      labels: { "k8s-app": "kube-dns", "kubernetes.io/cluster-service": "true", "kubernetes.io/name": "CoreDNS" },
    },
    spec: {
      clusterIP: "10.96.0.10",
      selector: { "k8s-app": "kube-dns" },
      ports: [
        { name: "dns", port: 53, protocol: "UDP", targetPort: 53 },
        { name: "dns-tcp", port: 53, protocol: "TCP", targetPort: 53 },
        { name: "metrics", port: 9153, protocol: "TCP", targetPort: 9153 },
      ],
    },
  });

  if (cp) {
    for (const comp of ["etcd", "kube-apiserver", "kube-controller-manager", "kube-scheduler"] as const) {
      cluster.create<Pod>({
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: `${comp}-${cp}`,
          namespace: "kube-system",
          labels: { component: comp, tier: "control-plane" },
          annotations: { "kubernetes.io/config.source": "file" },
          ownerReferences: [{ apiVersion: "v1", kind: "Node", name: cp, uid: cluster.raw("Node", undefined, cp)!.metadata.uid, controller: true }],
        },
        spec: {
          nodeName: cp,
          priority: 2000001000,
          tolerations: [{ operator: "Exists", effect: "NoExecute" }],
          containers: [{ name: comp, image: SYSTEM_IMAGES[comp] }],
        },
      });
    }
  }

  for (const n of cluster.state.config.nodes) {
    cluster.create<Pod>({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { generateName: "kube-proxy-", namespace: "kube-system", labels: { "k8s-app": "kube-proxy" } },
      spec: {
        nodeName: n.name,
        tolerations: [{ operator: "Exists" }],
        containers: [{ name: "kube-proxy", image: SYSTEM_IMAGES["kube-proxy"] }],
      },
    });
  }

  cluster.create<Deployment>({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "coredns", namespace: "kube-system", labels: { "k8s-app": "kube-dns" } },
    spec: {
      replicas: 2,
      selector: { matchLabels: { "k8s-app": "kube-dns" } },
      strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: 1 } },
      template: {
        metadata: { labels: { "k8s-app": "kube-dns" } },
        spec: {
          tolerations: [
            { key: "CriticalAddonsOnly", operator: "Exists" },
            { key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" },
          ],
          containers: [
            {
              name: "coredns",
              image: SYSTEM_IMAGES.coredns,
              args: ["-conf", "/etc/coredns/Corefile"],
              ports: [
                { containerPort: 53, name: "dns", protocol: "UDP" },
                { containerPort: 53, name: "dns-tcp", protocol: "TCP" },
                { containerPort: 9153, name: "metrics", protocol: "TCP" },
              ],
            },
          ],
        },
      },
    },
  });
}
