// Sandbox actions: each one changes the Simulated Cluster and returns the
// kubectl command a Learner would type to do the same thing.

import { ApiError, Cluster, addNode, execEnv, killNode, kindByName, recoverNode, runArgv, type Deployment, type Node, type Pod, type Service, type StatefulSet } from "@/lib/engine";

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

export function rolloutUndo(c: Cluster, name: string, ns = "default", toRevision?: number): ActionResult {
  return attempt(`kubectl rollout undo deployment/${name}${toRevision ? ` --to-revision=${toRevision}` : ""}`, () => {
    const d = c.get<Deployment>("Deployment", ns, name);
    const rss = c
      .list("ReplicaSet", ns)
      .filter((r) => r.metadata.ownerReferences?.some((o) => o.uid === d.metadata.uid))
      .sort((a, b) => Number(b.metadata.annotations?.["deployment.kubernetes.io/revision"]) - Number(a.metadata.annotations?.["deployment.kubernetes.io/revision"]));
    const prev = (toRevision ? rss.find((r) => Number(r.metadata.annotations?.["deployment.kubernetes.io/revision"]) === toRevision) : rss[1]) as unknown as Deployment | undefined;
    if (!prev) throw new Error(toRevision ? `error: unable to find specified revision ${toRevision} in history` : `error: no rollout history found for deployment "${name}"`);
    const tpl = structuredClone(prev.spec!.template);
    delete tpl.metadata!.labels!["pod-template-hash"];
    if (JSON.stringify(tpl) === JSON.stringify(d.spec!.template)) return `deployment.apps/${name} skipped rollback (current template already matches revision ${prev.metadata.annotations?.["deployment.kubernetes.io/revision"]})`;
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
    if (!!n.spec?.unschedulable === on) return `node/${node} already ${on ? "cordoned" : "uncordoned"}`;
    c.replace({ ...n, spec: { ...n.spec, unschedulable: on || undefined } });
    return `node/${node} ${on ? "cordoned" : "uncordoned"}`;
  });
}

export interface DrainOptions {
  ignoreDaemonSets?: boolean;
  deleteEmptyDir?: boolean;
  force?: boolean;
}

/** kubectl drain: cordon, then evict every Pod that may be evicted (staging/src/k8s.io/kubectl/pkg/drain). */
export function drain(c: Cluster, node: string, opts: DrainOptions = { ignoreDaemonSets: true, deleteEmptyDir: true }): ActionResult {
  const flags = [opts.ignoreDaemonSets ? " --ignore-daemonsets" : "", opts.deleteEmptyDir ? " --delete-emptydir-data" : "", opts.force ? " --force" : ""].join("");
  return attempt(`kubectl drain ${node}${flags}`, () => {
    c.get<Node>("Node", undefined, node);
    const out = [cordon(c, node, true).out];
    const pods = c.list<Pod>("Pod").filter((p) => p.spec?.nodeName === node && p.metadata.deletionTimestamp === undefined);
    const owner = (p: Pod) => p.metadata.ownerReferences?.find((o) => o.controller);
    const id = (p: Pod) => `${p.metadata.namespace}/${p.metadata.name}`;
    const mirror = pods.filter((p) => p.metadata.annotations?.["kubernetes.io/config.source"] === "file");
    const ds = pods.filter((p) => owner(p)?.kind === "DaemonSet");
    const bare = pods.filter((p) => !owner(p) && !mirror.includes(p));
    const local = pods.filter((p) => (p.spec?.volumes ?? []).some((v) => v.emptyDir) && !ds.includes(p));
    const errs: string[] = [];
    if (ds.length && !opts.ignoreDaemonSets) errs.push(`cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore): ${ds.map(id).join(", ")}`);
    if (bare.length && !opts.force) errs.push(`cannot delete Pods that declare no controller (use --force to override): ${bare.map(id).join(", ")}`);
    if (local.length && !opts.deleteEmptyDir) errs.push(`cannot delete Pods with local storage (use --delete-emptydir-data to override): ${local.map(id).join(", ")}`);
    if (errs.length) {
      const agg = errs.length > 1 ? `[${errs.join(", ")}]` : errs[0];
      throw new Error([...out, `error: unable to drain node "${node}" due to error: ${agg}, continuing command...`, "There are pending nodes to be drained:", ` ${node}`, `error: ${agg}`].join("\n"));
    }
    // One Warning line, parts joined by "; " (drain.go).
    const warnings = [
      ...(ds.length ? [`ignoring DaemonSet-managed Pods: ${ds.map(id).join(", ")}`] : []),
      ...(bare.length ? [`deleting Pods that declare no controller: ${bare.map(id).join(", ")}`] : []),
      ...(local.length ? [`deleting Pods with local storage: ${local.map(id).join(", ")}`] : []),
    ];
    if (warnings.length) out.push(`Warning: ${warnings.join("; ")}`);
    const evict = pods.filter((p) => !ds.includes(p) && !mirror.includes(p));
    for (const p of evict) out.push(`evicting pod ${id(p)}`);
    for (const p of evict) {
      c.deleteObject(p);
      out.push(`pod/${p.metadata.name} evicted`);
    }
    c.tick(0);
    out.push(`node/${node} drained`);
    return out.join("\n");
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

// ---------------------------------------------------------------- Explainer helpers (v2)

/** Creates an object from a manifest, shown as the kubectl command that would do it. */
export function createObject(c: Cluster, obj: object, cmd: string): ActionResult {
  return attempt(cmd, () => {
    const o = c.create(obj as never) as { kind: string; metadata: { name: string } };
    const k = kindByName(o.kind);
    return `${k ? `${k.singular}${k.group ? `.${k.group}` : ""}` : o.kind.toLowerCase()}/${o.metadata.name} created`;
  });
}

/** kubectl exec POD -- COMMAND, in the Pod's first container. */
export function execIn(c: Cluster, podName: string, argv: string[], ns = "default"): ActionResult {
  const shown = argv.map((a) => (/[\s;&|]/.test(a) ? `'${a}'` : a)).join(" ");
  return attempt(`kubectl exec ${podName}${ns !== "default" ? ` -n ${ns}` : ""} -- ${shown}`, () => {
    const p = c.get<Pod>("Pod", ns, podName);
    const ct = p.spec!.containers[0];
    const crt = c.state.pods[p.metadata.uid]?.containers[ct.name];
    if (!crt || (crt.phase !== "running" && crt.phase !== "stopping")) throw new Error(`error: unable to upgrade connection: container not found ("${ct.name}")`);
    const r = runArgv(execEnv(c, p, ct, crt.env ?? {}), argv);
    c.markChanged();
    const out = r.out.replace(/\n$/, "");
    if (r.code !== 0) throw new Error(`${out}${out ? "\n" : ""}command terminated with exit code ${r.code}`);
    return out;
  });
}

/** The load generator from the HorizontalPodAutoscaler walkthrough. */
export function runLoadGenerator(c: Cluster, target = "php-apache"): ActionResult {
  const script = `while sleep 0.01; do wget -q -O- http://${target}; done`;
  return attempt(`kubectl run load-generator --image=busybox:1.28 --restart=Never -- /bin/sh -c "${script}"`, () => {
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "load-generator", labels: { run: "load-generator" } }, spec: { restartPolicy: "Never", containers: [{ name: "load-generator", image: "busybox:1.28", args: ["/bin/sh", "-c", script] }] } });
    return "pod/load-generator created";
  });
}

export function scaleStatefulSet(c: Cluster, name: string, replicas: number): ActionResult {
  return attempt(`kubectl scale statefulset/${name} --replicas=${replicas}`, () => {
    const s = c.get<StatefulSet>("StatefulSet", "default", name);
    c.replace({ ...s, spec: { ...s.spec!, replicas: Math.max(0, replicas) } });
    return `statefulset.apps/${name} scaled`;
  });
}
