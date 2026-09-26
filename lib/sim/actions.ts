// Sandbox actions: each one changes the Simulated Cluster and returns the
// kubectl command a Learner would type to do the same thing.

import { ApiError, Cluster, addNode, killNode, recoverNode, type Deployment, type Node, type Pod, type Service } from "@/lib/engine";

export type ActionResult = { cmd: string; out: string; ok: boolean };

function attempt(cmd: string, fn: () => string): ActionResult {
  try {
    return { cmd, out: fn(), ok: true };
  } catch (e) {
    return { cmd, out: e instanceof ApiError || e instanceof Error ? e.message : String(e), ok: false };
  }
}

export const IMAGES = ["nginx:1.27", "nginx:1.26", "nginxdemos/hello:plain-text", "httpd:2.4", "redis:7", "hashicorp/http-echo"];

export function createDeployment(c: Cluster, name: string, image: string, replicas: number): ActionResult {
  return attempt(`kubectl create deployment ${name} --image=${image} --replicas=${replicas}`, () => {
    const args = image.startsWith("hashicorp/http-echo") ? { args: [`-text=hello from ${name}`] } : {};
    c.create({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name, labels: { app: name } },
      spec: {
        replicas,
        selector: { matchLabels: { app: name } },
        template: { metadata: { labels: { app: name } }, spec: { containers: [{ name: image.split("/").pop()!.split(":")[0], image, ...args }] } },
      },
    });
    return `deployment.apps/${name} created`;
  });
}

export function scale(c: Cluster, name: string, replicas: number): ActionResult {
  return attempt(`kubectl scale deployment/${name} --replicas=${replicas}`, () => {
    const d = c.get<Deployment>("Deployment", "default", name);
    c.replace({ ...d, spec: { ...d.spec!, replicas: Math.max(0, replicas) } });
    return `deployment.apps/${name} scaled`;
  });
}

export function setImage(c: Cluster, name: string, image: string): ActionResult {
  const d0 = c.raw("Deployment", "default", name) as unknown as Deployment | undefined;
  const container = d0?.spec?.template.spec.containers[0]?.name ?? name;
  return attempt(`kubectl set image deployment/${name} ${container}=${image}`, () => {
    const d = c.get<Deployment>("Deployment", "default", name);
    const tpl = structuredClone(d.spec!.template);
    tpl.spec.containers[0].image = image;
    c.replace({ ...d, spec: { ...d.spec!, template: tpl } });
    return `deployment.apps/${name} image updated`;
  });
}

export function rolloutUndo(c: Cluster, name: string): ActionResult {
  return attempt(`kubectl rollout undo deployment/${name}`, () => {
    const d = c.get<Deployment>("Deployment", "default", name);
    const rss = c
      .list("ReplicaSet", "default")
      .filter((r) => r.metadata.ownerReferences?.some((o) => o.uid === d.metadata.uid))
      .sort((a, b) => Number(b.metadata.annotations?.["deployment.kubernetes.io/revision"]) - Number(a.metadata.annotations?.["deployment.kubernetes.io/revision"]));
    const prev = rss[1] as unknown as Deployment | undefined;
    if (!prev) throw new Error(`error: no rollout history found for deployment "${name}"`);
    const tpl = structuredClone(prev.spec!.template);
    delete tpl.metadata!.labels!["pod-template-hash"];
    c.replace({ ...d, spec: { ...d.spec!, template: tpl } });
    return `deployment.apps/${name} rolled back`;
  });
}

export function deleteDeployment(c: Cluster, name: string): ActionResult {
  return attempt(`kubectl delete deployment ${name}`, () => {
    c.delete("Deployment", "default", name);
    return `deployment.apps "${name}" deleted from default namespace`;
  });
}

export function deletePod(c: Cluster, name: string, ns = "default"): ActionResult {
  return attempt(`kubectl delete pod ${name}${ns !== "default" ? ` -n ${ns}` : ""}`, () => {
    c.delete("Pod", ns, name);
    return `pod "${name}" deleted from ${ns} namespace`;
  });
}

export function runCrashPod(c: Cluster): ActionResult {
  const name = `crashy-${Math.floor(Math.random() * 900 + 100)}`;
  return attempt(`kubectl run ${name} --image=busybox -- sh -c "echo starting; sleep 3; exit 1"`, () => {
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name, labels: { run: name } }, spec: { containers: [{ name, image: "busybox", command: ["sh", "-c", "echo starting; sleep 3; exit 1"] }] } });
    return `pod/${name} created`;
  });
}

export function expose(c: Cluster, name: string, type: "ClusterIP" | "NodePort"): ActionResult {
  return attempt(`kubectl expose deployment ${name} --port=80${type === "NodePort" ? " --type=NodePort" : ""}`, () => {
    const d = c.get<Deployment>("Deployment", "default", name);
    const image = d.spec!.template.spec.containers[0].image;
    const target = image.includes("http-echo") ? 5678 : image.startsWith("redis") ? 6379 : 80;
    c.create<Service>({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name, labels: { app: name } },
      spec: { type, selector: d.spec!.selector.matchLabels, ports: [{ port: 80, targetPort: target }] },
    });
    return `service/${name} exposed`;
  });
}

export function deleteService(c: Cluster, name: string): ActionResult {
  return attempt(`kubectl delete service ${name}`, () => {
    c.delete("Service", "default", name);
    return `service "${name}" deleted from default namespace`;
  });
}

export function cordon(c: Cluster, node: string, on: boolean): ActionResult {
  return attempt(`kubectl ${on ? "cordon" : "uncordon"} ${node}`, () => {
    const n = c.get<Node>("Node", undefined, node);
    c.replace({ ...n, spec: { ...n.spec, unschedulable: on || undefined } });
    return `node/${node} ${on ? "cordoned" : "uncordoned"}`;
  });
}

export function drain(c: Cluster, node: string): ActionResult {
  return attempt(`kubectl drain ${node} --ignore-daemonsets`, () => {
    cordon(c, node, true);
    const evicted: string[] = [];
    for (const p of c.list<Pod>("Pod")) {
      if (p.spec?.nodeName !== node || p.metadata.deletionTimestamp !== undefined) continue;
      if (p.metadata.namespace === "kube-system" && !p.metadata.name.startsWith("coredns")) continue;
      c.deleteObject(p);
      evicted.push(`pod/${p.metadata.name} evicted`);
    }
    c.tick(0);
    return [`node/${node} cordoned`, ...evicted, `node/${node} drained`].join("\n");
  });
}

export function chaosKill(c: Cluster, node: string): ActionResult {
  return attempt(`# chaos: power off ${node}`, () => {
    killNode(c, node);
    return `${node} lost power. It goes NotReady after ~50s; its Pods are evicted 5 min later.`;
  });
}

export function chaosRecover(c: Cluster, node: string): ActionResult {
  return attempt(`# chaos: power on ${node}`, () => {
    recoverNode(c, node);
    return `${node} is back. Its kubelet cleans up evicted Pods.`;
  });
}

export function joinNode(c: Cluster): ActionResult {
  const n = c.list("Node").length;
  let i = n;
  while (c.raw("Node", undefined, `worker-${i}`)) i++;
  const name = `worker-${i}`;
  return attempt(`kubeadm join … # new node ${name}`, () => {
    addNode(c, name);
    c.tick(0);
    return `node/${name} joined the cluster`;
  });
}
