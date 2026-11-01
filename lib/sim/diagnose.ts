// "What's wrong": reads an object the way an operator would (status, Events, logs, the traffic it
// carries) and says in plain English what's wrong with it, with the kubectl that fixes it.

import {
  containerLimits,
  matchesSelector,
  nodeAllocatable,
  podRequests,
  podStatusColumns,
  type AnyObject,
  type Cluster,
  type Container,
  type CronJob,
  type DaemonSet,
  type Deployment,
  type Endpoints,
  type HorizontalPodAutoscaler,
  type Ingress,
  type Job,
  type KubeEvent,
  type Node,
  type PersistentVolumeClaim,
  type Pod,
  type ReplicaSet,
  type Service,
  type StatefulSet,
} from "@/lib/engine";
import * as A from "./actions";
import { explainEvent } from "./explain";
import { RAW_KIND, type ObjectKind } from "./objects";

/** A way out: a kubectl command (run in the terminal, so it's learned), or a sandbox action with no kubectl (adding a Node, ending a simulated failure). */
export type Fix = { label: string; cmd: string } | { label: string; run: (c: Cluster) => A.ActionResult };

export interface Finding {
  /** bad: it's broken now. warn: it will be, or it's degraded. info: worth knowing, nothing to fix. */
  level: "bad" | "warn" | "info";
  title: string;
  detail: string;
  fixes?: Fix[];
  /** Where to look next: the Pod that shows it, the Node it's stuck on. */
  see?: { kind: ObjectKind; ns?: string; name: string };
}

type Workload = { kind: "deployment" | "statefulset" | "daemonset" | "replicaset" | "job"; ns: string; name: string };

const nsFlag = (ns?: string) => (ns && ns !== "default" ? ` -n ${ns}` : "");
const cmd = (label: string, c: string): Fix => ({ label, cmd: c });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const lastEvent = (c: Cluster, obj: AnyObject, reason: string | RegExp): KubeEvent | undefined =>
  c
    .eventsFor(obj)
    .filter((e) => (typeof reason === "string" ? e.reason === reason : reason.test(e.reason)))
    .sort((a, b) => (b.lastTimestamp ?? 0) - (a.lastTimestamp ?? 0))[0];

/** Everything wrong with an object, worst first. Empty when it's healthy. */
export function diagnose(c: Cluster, kind: ObjectKind, ns: string | undefined, name: string): Finding[] {
  const obj = c.raw(RAW_KIND[kind], kind === "node" ? undefined : (ns ?? "default"), name);
  if (!obj) return [];
  const out = (() => {
    switch (kind) {
      case "pod":
        return podFindings(c, obj as unknown as Pod);
      case "deployment":
        return deploymentFindings(c, obj as unknown as Deployment);
      case "statefulset":
      case "daemonset":
      case "replicaset":
        return workloadFindings(c, obj, { kind, ns: obj.metadata.namespace ?? "default", name }, kind === "statefulset" ? ((obj as unknown as StatefulSet).spec?.replicas ?? 1) : kind === "replicaset" ? ((obj as unknown as ReplicaSet).spec?.replicas ?? 1) : ((obj as unknown as DaemonSet).status?.desiredNumberScheduled ?? 0));
      case "job":
        return jobFindings(c, obj as unknown as Job);
      case "cronjob":
        return cronJobFindings(c, obj as unknown as CronJob);
      case "service":
        return serviceFindings(c, obj as unknown as Service);
      case "node":
        return nodeFindings(c, obj as unknown as Node);
      case "pvc":
        return pvcFindings(c, obj as unknown as PersistentVolumeClaim);
      case "hpa":
        return hpaFindings(c, obj as unknown as HorizontalPodAutoscaler);
      case "ingress":
        return ingressFindings(c, obj as unknown as Ingress);
      default:
        return [];
    }
  })();
  const rank = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

// ---------------------------------------------------------------- Pods

/** The workload that runs a Pod: a ReplicaSet's Deployment rather than the ReplicaSet. */
export function workloadOf(c: Cluster, p: Pod): Workload | undefined {
  const ns = p.metadata.namespace ?? "default";
  const o = p.metadata.ownerReferences?.find((r) => r.controller) ?? p.metadata.ownerReferences?.[0];
  if (!o) return undefined;
  if (o.kind === "ReplicaSet") {
    const d = c.raw("ReplicaSet", ns, o.name)?.metadata.ownerReferences?.find((r) => r.kind === "Deployment");
    return d ? { kind: "deployment", ns, name: d.name } : { kind: "replicaset", ns, name: o.name };
  }
  if (o.kind === "StatefulSet") return { kind: "statefulset", ns, name: o.name };
  if (o.kind === "DaemonSet") return { kind: "daemonset", ns, name: o.name };
  if (o.kind === "Job") return { kind: "job", ns, name: o.name };
  return undefined;
}

const nodeDown = (c: Cluster, name: string) => c.state.nodes[name]?.up === false;
const cordoned = (c: Cluster) => c.list<Node>("Node").filter((n) => n.spec?.unschedulable);
const downNodes = (c: Cluster) => c.list<Node>("Node").filter((n) => nodeDown(c, n.metadata.name));
const recover = (n: string): Fix => ({ label: `Recover ${n}`, run: (cl) => A.chaosRecover(cl, n) });
const addNode: Fix = { label: "Add a Node", run: (cl) => A.joinNode(cl) };

/** Fixes for a workload whose last change broke it: go back to the template that worked. */
function undoFix(c: Cluster, w: Workload | undefined): Fix[] {
  if (w?.kind !== "deployment") return [];
  const d = c.raw("Deployment", w.ns, w.name) as unknown as Deployment | undefined;
  if (!d || A.undoTarget(c, d).error) return [];
  return [cmd("Roll back to the version that worked", `kubectl rollout undo deployment/${w.name}${nsFlag(w.ns)}`)];
}

/** Commands that create the ConfigMap or Secret a container needs, with the keys it reads. */
function createConfigFix(ct: Container | undefined, kind: "configmap" | "secret", name: string, ns?: string): Fix | undefined {
  const keys = new Set<string>();
  for (const e of ct?.env ?? []) {
    const ref = kind === "configmap" ? e.valueFrom?.configMapKeyRef : e.valueFrom?.secretKeyRef;
    if (ref?.name === name) keys.add(ref.key);
  }
  const lits = [...keys].map((k) => ` --from-literal=${k}=changeme`).join("");
  return cmd(`Create ${kind === "configmap" ? "ConfigMap" : "Secret"} ${name}`, `kubectl create ${kind === "configmap" ? "configmap" : "secret generic"} ${name}${lits}${nsFlag(ns)}`);
}

function podFindings(c: Cluster, p: Pod): Finding[] {
  const out: Finding[] = [];
  const ns = p.metadata.namespace ?? "default";
  const pname = p.metadata.name;
  const w = workloadOf(c, p);
  const node = p.spec?.nodeName;
  if (p.metadata.deletionTimestamp) {
    return [{ level: "info", title: "Shutting down", detail: "It got its stop signal (SIGTERM) and has its grace period to finish what it's doing; then it's removed. Services already stopped sending it traffic." }];
  }
  if (podStatusColumns(p).status === "Completed") return [];

  // Its Node stopped answering.
  if (node && nodeDown(c, node)) {
    out.push({ level: "bad", title: "Its Node isn't responding", detail: `${node} stopped sending heartbeats. Once it's NotReady, Services stop sending this Pod traffic, and about 5 minutes later it's evicted and ${w ? "its controller replaces it on another Node" : "gone: a bare Pod isn't replaced"}.`, fixes: [recover(node)], see: { kind: "node", name: node } });
  }

  // Nowhere to run.
  if (!node && p.status?.phase === "Pending") {
    const ev = lastEvent(c, p as unknown as AnyObject, "FailedScheduling");
    const msg = ev?.message ?? p.status?.conditions?.find((x) => x.type === "PodScheduled")?.message ?? "";
    const fixes: Fix[] = [];
    if (/Insufficient (cpu|memory)/.test(msg)) {
      fixes.push(addNode);
      const r = podRequests(p.spec);
      if (w && (w.kind === "deployment" || w.kind === "statefulset") && r.cpu > 100) fixes.push(cmd("Ask for less CPU", `kubectl set resources ${w.kind} ${w.name} --requests=cpu=${Math.max(50, Math.round(r.cpu / 2))}m${nsFlag(ns)}`));
    }
    for (const n of cordoned(c)) fixes.push(cmd(`Uncordon ${n.metadata.name}`, `kubectl uncordon ${n.metadata.name}`));
    for (const n of downNodes(c)) fixes.push(recover(n.metadata.name));
    out.push({ level: "bad", title: "No Node will take it", detail: ev ? explainEvent(ev) : "The scheduler hasn't found a Node with room for it yet, so it waits in the queue.", fixes });
  }

  // Containers that can't start, or keep stopping.
  const statuses = [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])];
  const allContainers = [...(p.spec?.initContainers ?? []), ...(p.spec?.containers ?? [])];
  for (const cs of statuses) {
    const ct = allContainers.find((x) => x.name === cs.name);
    const reason = cs.state.waiting?.reason;
    const wmsg = cs.state.waiting?.message ?? "";
    const one = (p.spec?.containers?.length ?? 1) > 1 ? `Container ${cs.name}` : "Its container";
    if (reason === "ErrImagePull" || reason === "ImagePullBackOff" || reason === "InvalidImageName") {
      out.push({ level: "bad", title: "Can't pull its image", detail: `The image ${ct?.image ?? cs.image} can't be downloaded: the name or tag doesn't exist, or the registry needs credentials. The kubelet keeps retrying, waiting longer each time (${reason}).`, fixes: undoFix(c, w) });
    } else if (reason === "CrashLoopBackOff") {
      const last = cs.lastState.terminated;
      const prev = c.logsFor(p, cs.name, true) ?? [];
      const said = prev.at(-1)?.text;
      if (last?.reason === "OOMKilled") {
        const lim = ct ? containerLimits(ct).memory : 0;
        out.push({
          level: "bad",
          title: "Runs out of memory",
          detail: `${one} goes over its memory limit${lim ? ` (${Math.round(lim / 2 ** 20)}Mi)` : ""}, so the kernel kills it (OOMKilled, exit code 137). It has restarted ${plural(cs.restartCount, "time")}.`,
          fixes: w && lim && (w.kind === "deployment" || w.kind === "statefulset" || w.kind === "daemonset") ? [cmd("Give it twice the memory", `kubectl set resources ${w.kind} ${w.name} -c ${cs.name} --limits=memory=${Math.round((lim * 2) / 2 ** 20)}Mi${nsFlag(ns)}`)] : [],
        });
      } else {
        out.push({
          level: "bad",
          title: "Keeps crashing",
          detail: `${one} exits${last ? ` with code ${last.exitCode}` : ""} soon after it starts, so the kubelet restarts it, waiting longer each time (CrashLoopBackOff). It has restarted ${plural(cs.restartCount, "time")}.${said ? ` Its last log line: “${said.slice(0, 140)}”` : ""}`,
          fixes: [...undoFix(c, w), cmd("Read the crashed run's logs", `kubectl logs ${pname} -c ${cs.name} --previous${nsFlag(ns)}`)],
        });
      }
    } else if (reason === "CreateContainerConfigError") {
      const miss = wmsg.match(/(configmap|secret) "([^"]+)" not found/);
      const key = wmsg.match(/couldn't find key (\S+) in (ConfigMap|Secret) \S*?\/?([\w.-]+)/);
      const fix = miss ? createConfigFix(ct, miss[1] as "configmap" | "secret", miss[2], ns) : undefined;
      out.push({
        level: "bad",
        title: "Missing configuration",
        detail: miss ? `${one} reads ${miss[1] === "configmap" ? "ConfigMap" : "Secret"} ${miss[2]}, which doesn't exist, so it can't be created (CreateContainerConfigError). It starts as soon as that exists.` : key ? `${one} reads key ${key[1]} from ${key[2]} ${key[3]}, which doesn't have it.` : `${one} can't be created: ${wmsg}`,
        fixes: fix ? [fix] : [],
      });
    } else if (reason === "ContainerCreating" || reason === "PodInitializing") {
      const ev = lastEvent(c, p as unknown as AnyObject, "FailedMount");
      if (ev) out.push({ level: "bad", title: "Waiting for a volume", detail: explainEvent(ev) });
    } else if (reason && !["ContainerCreating", "PodInitializing"].includes(reason)) {
      out.push({ level: "bad", title: reason, detail: wmsg || `${one} is waiting: ${reason}.` });
    }
  }

  // Up, but Services skip it.
  const running = p.status?.phase === "Running";
  const ready = p.status?.conditions?.find((x) => x.type === "Ready")?.status === "True";
  if (running && !ready && statuses.every((s) => s.state.running)) {
    const ev = lastEvent(c, p as unknown as AnyObject, "Unhealthy");
    if (ev) out.push({ level: "warn", title: "Not ready, so it gets no traffic", detail: `${explainEvent(ev)} The Pod stays up; it's just left out of its Services' endpoints until the check passes.`, fixes: undoFix(c, w) });
  }

  // Under the traffic control: at its CPU limit.
  for (const ct of p.spec?.containers ?? []) {
    const f = c.state.pods[p.metadata.uid]?.containers[ct.name]?.flow;
    const lim = containerLimits(ct).cpu;
    if (!f || !lim || f.cpu < lim * 0.95) continue;
    const n = f.t.length;
    const recent = (xs: number[]) => xs.slice(Math.max(0, n - 4)).reduce((a, b) => a + b, 0);
    const errs = recent(f.err);
    const fixes: Fix[] = [];
    if (w?.kind === "deployment" || w?.kind === "statefulset") fixes.push(...scaleFixes(c, w));
    out.push({ level: errs ? "bad" : "warn", title: "At its CPU limit", detail: `It's using all ${lim}m of its CPU limit to serve about ${recent(f.ok) + errs} requests a second, so the kernel throttles it: requests queue up, slow down${errs ? `, and ${errs} a second time out` : ""}. One Pod can't go faster than its limit; more Pods share the load.`, fixes });
  }

  // Restarted, but fine now.
  const restarts = podStatusColumns(p).restarts;
  if (restarts > 0 && !out.some((f) => f.level === "bad")) {
    const why = statuses.find((s) => s.lastState.terminated)?.lastState.terminated;
    out.push({ level: "info", title: `Restarted ${plural(restarts, "time")}`, detail: `It's running now. The last run ended with ${why?.reason === "OOMKilled" ? "OOMKilled: it went over its memory limit" : why ? `${why.reason ?? "an error"} (exit ${why.exitCode})` : "an error"}.${why ? ` kubectl logs ${pname} --previous shows what it printed.` : ""}` });
  }
  return out;
}

// ---------------------------------------------------------------- workloads

/** Scale out, or let an HPA do it, unless one already does. `need` is how many Pods would carry the load, when that's known. */
function scaleFixes(c: Cluster, w: Workload, need?: number): Fix[] {
  const kind = w.kind === "statefulset" ? "StatefulSet" : "Deployment";
  const o = c.raw(kind, w.ns, w.name) as unknown as Deployment | StatefulSet | undefined;
  const want = o?.spec?.replicas ?? 1;
  const hpa = hpaFor(c, kind, w.ns, w.name);
  if (hpa) return [];
  const to = Math.max(2, need ?? want * 2);
  // The ceiling leaves room above what's needed now: an HPA capped below the load never catches up.
  const ceiling = Math.max(20, Math.ceil(to * 1.5), want * 4);
  return [
    cmd(`Scale to ${to}`, `kubectl scale ${w.kind} ${w.name} --replicas=${to}${nsFlag(w.ns)}`),
    ...(w.kind === "deployment" ? [cmd("Let an HPA scale it", `kubectl autoscale deployment ${w.name} --cpu=70% --min=${Math.max(1, want)} --max=${ceiling}${nsFlag(w.ns)}`)] : []),
  ];
}

const hpaFor = (c: Cluster, kind: string, ns: string, name: string) => c.list<HorizontalPodAutoscaler>("HorizontalPodAutoscaler", ns).find((h) => h.spec?.scaleTargetRef.kind === kind && h.spec.scaleTargetRef.name === name);

function podsOf(c: Cluster, obj: AnyObject): Pod[] {
  const ns = obj.metadata.namespace;
  if (obj.kind === "Deployment") {
    const rs = c.list<ReplicaSet>("ReplicaSet", ns).filter((r) => r.metadata.ownerReferences?.some((o) => o.uid === obj.metadata.uid)).map((r) => r.metadata.uid);
    return c.list<Pod>("Pod", ns).filter((p) => p.metadata.ownerReferences?.some((o) => rs.includes(o.uid)));
  }
  return c.list<Pod>("Pod", ns).filter((p) => p.metadata.ownerReferences?.some((o) => o.uid === obj.metadata.uid));
}

/** Its Pods' problems, grouped (three Pods with the same bad image are one finding), plus the traffic holding at it. */
function workloadFindings(c: Cluster, obj: AnyObject, w: Workload, want: number): Finding[] {
  const out: Finding[] = [];
  const pods = podsOf(c, obj).filter((p) => !p.metadata.deletionTimestamp);
  const bottleneck = c.state.loadStats?.bottleneck;
  const held = bottleneck?.name === w.name && (!c.state.load || c.state.load.target.startsWith(`${w.ns}/`));
  if (held) {
    const why = bottleneck!.why;
    out.push({
      level: "bad",
      title: why === "no-endpoints" ? "No ready Pods for the traffic" : why === "unreachable" ? "The traffic can't reach it" : "It's what's slowing the traffic",
      detail:
        why === "cpu-limit"
          ? `Its Pods are each at their CPU limit, so they can't serve the requests coming in: they queue, slow down and time out. Run more Pods to share the load, or let an HPA add them as CPU climbs.`
          : why === "node-cpu"
            ? `Its Pods sit on Nodes whose CPU is used up, so each gets only a share. More Pods on more Nodes, or a bigger CPU request (a bigger share), fixes it.`
            : why === "no-endpoints"
              ? `None of its Pods is ready, so its Service has no endpoints and every request to it fails.`
              : `Requests to it are blocked on the way, by a NetworkPolicy or a Service that doesn't match.`,
      fixes: why === "node-cpu" ? [addNode, ...scaleFixes(c, w)] : why === "cpu-limit" ? scaleFixes(c, w, carry(c, want)) : [],
    });
  }
  const groups = new Map<string, { f: Finding; pods: Pod[] }>();
  for (const p of pods)
    for (const f of podFindings(c, p)) {
      if (f.level === "info" || (held && f.title === "At its CPU limit")) continue;
      const g = groups.get(f.title) ?? { f, pods: [] };
      g.pods.push(p);
      groups.set(f.title, g);
    }
  for (const { f, pods: ps } of groups.values()) {
    out.push({ ...f, detail: `${ps.length === pods.length && pods.length > 1 ? `All ${pods.length} of its Pods` : ps.length > 1 ? `${ps.length} of its ${pods.length} Pods` : `Pod ${ps[0].metadata.name}`}: ${f.detail}`, see: { kind: "pod", ns: w.ns, name: ps[0].metadata.name } });
  }
  if (w.kind !== "daemonset" && w.kind !== "replicaset" && want === 0) out.push({ level: "info", title: "Scaled to zero", detail: "It wants no Pods, so nothing runs and anything sending it traffic fails.", fixes: [cmd("Scale to 1", `kubectl scale ${w.kind} ${w.name} --replicas=1${nsFlag(w.ns)}`)] });

  const hpa = hpaFor(c, w.kind === "statefulset" ? "StatefulSet" : "Deployment", w.ns, w.name);
  if (hpa) {
    const cur = hpa.status?.currentMetrics?.[0]?.resource?.current?.averageUtilization;
    const tgt = hpa.spec?.metrics?.[0]?.resource?.target.averageUtilization ?? 80;
    const max = hpa.spec?.maxReplicas ?? 1;
    if ((hpa.status?.currentReplicas ?? 0) >= max && cur !== undefined && cur > tgt) out.push({ level: "warn", title: "Its autoscaler is at the maximum", detail: `HPA ${hpa.metadata.name} would add Pods (CPU ${cur}% against a ${tgt}% target), but it's already at its max of ${max}.`, fixes: [cmd(`Raise the max to ${max * 2}`, `kubectl patch hpa ${hpa.metadata.name} -p '{"spec":{"maxReplicas":${max * 2}}}'${nsFlag(w.ns)}`)], see: { kind: "hpa", ns: w.ns, name: hpa.metadata.name } });
  }
  return out;
}

/** Pods it would take to carry the offered load, from what the current ones manage (with 15% to spare). */
function carry(c: Cluster, want: number): number | undefined {
  const st = c.state.loadStats;
  if (!st || !st.ok || !want) return undefined;
  return Math.min(60, Math.max(want * 2, Math.ceil(want * (st.offered / st.ok) * 1.15)));
}

function deploymentFindings(c: Cluster, d: Deployment): Finding[] {
  return workloadFindings(c, d as unknown as AnyObject, { kind: "deployment", ns: d.metadata.namespace ?? "default", name: d.metadata.name }, d.spec?.replicas ?? 1);
}

function jobFindings(c: Cluster, j: Job): Finding[] {
  const failed = j.status?.conditions?.find((x) => x.type === "Failed" && x.status === "True");
  const out = workloadFindings(c, j as unknown as AnyObject, { kind: "job", ns: j.metadata.namespace ?? "default", name: j.metadata.name }, j.spec?.completions ?? 1);
  if (failed) out.unshift({ level: "bad", title: "The Job failed", detail: failed.reason === "DeadlineExceeded" ? `It ran longer than its activeDeadlineSeconds (${j.spec?.activeDeadlineSeconds}s), so it was stopped.` : `Its Pods failed ${plural(j.status?.failed ?? 0, "time")}, past its backoffLimit of ${j.spec?.backoffLimit ?? 6}, so it gave up.`, fixes: [cmd("Read its logs", `kubectl logs job/${j.metadata.name}${nsFlag(j.metadata.namespace)}`)] });
  return out;
}

function cronJobFindings(c: Cluster, cj: CronJob): Finding[] {
  const ns = cj.metadata.namespace ?? "default";
  const out: Finding[] = [];
  if (cj.spec?.suspend) out.push({ level: "info", title: "Suspended", detail: "It won't start new Jobs until it's resumed.", fixes: [cmd("Resume it", `kubectl patch cronjob ${cj.metadata.name} -p '{"spec":{"suspend":false}}'${nsFlag(ns)}`)] });
  const jobs = c.list<Job>("Job", ns).filter((j) => j.metadata.ownerReferences?.some((o) => o.uid === cj.metadata.uid)).sort((a, b) => b.metadata.creationTimestamp - a.metadata.creationTimestamp);
  if (jobs[0]?.status?.conditions?.some((x) => x.type === "Failed" && x.status === "True")) out.push({ level: "warn", title: "Its last run failed", detail: `Job ${jobs[0].metadata.name} gave up. The next run starts on schedule anyway.`, see: { kind: "job", ns, name: jobs[0].metadata.name } });
  return out;
}

// ---------------------------------------------------------------- Services and Ingresses

function serviceFindings(c: Cluster, s: Service): Finding[] {
  const out: Finding[] = [];
  const ns = s.metadata.namespace ?? "default";
  const sel = s.spec?.selector;
  if (!sel || !Object.keys(sel).length || s.spec?.type === "ExternalName") return out;
  const pods = c.list<Pod>("Pod", ns).filter((p) => !p.metadata.deletionTimestamp && matchesSelector(p.metadata.labels, sel));
  const ep = c.raw("Endpoints", ns, s.metadata.name) as unknown as Endpoints | undefined;
  const ready = (ep?.subsets ?? []).reduce((a, x) => a + (x.addresses?.length ?? 0), 0);
  const selStr = Object.entries(sel).map(([k, v]) => `${k}=${v}`).join(",");
  if (!pods.length) {
    // Workloads it was probably meant for: their Pods carry one of its keys, or share its name.
    const workloads = [...c.list<Deployment>("Deployment", ns), ...c.list<StatefulSet>("StatefulSet", ns)];
    const near = workloads
      .map((w) => ({ w, labels: w.spec?.template?.metadata?.labels ?? {} }))
      .filter(({ w, labels }) => Object.keys(sel).some((k) => k in labels) || w.metadata.name === s.metadata.name)
      .slice(0, 2);
    out.push({
      level: "bad",
      title: "It selects no Pods",
      detail: `Its selector ${selStr} matches no Pod, so it has no endpoints and every request to it is refused.${near.length ? ` ${near.map(({ w, labels }) => `${w.metadata.name}'s Pods are labelled ${Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(",")}`).join("; ")}.` : ""}`,
      fixes: near.map(({ w, labels }) => {
        const patch: Record<string, string | null> = { ...labels };
        for (const k of Object.keys(sel)) if (!(k in labels)) patch[k] = null;
        return cmd(`Point it at ${w.metadata.name}`, `kubectl patch service ${s.metadata.name} -p '${JSON.stringify({ spec: { selector: patch } })}'${nsFlag(ns)}`);
      }),
    });
    return out;
  }
  if (!ready && !s.spec?.publishNotReadyAddresses) {
    out.push({ level: "bad", title: "None of its Pods is ready", detail: `${plural(pods.length, "Pod")} match ${selStr}, but none is Ready, so it has no endpoints and requests to it fail. Fix the Pods and it recovers on its own.`, see: { kind: "pod", ns, name: pods[0].metadata.name } });
  }
  // targetPort the Pods don't listen on.
  for (const port of s.spec?.ports ?? []) {
    const tp = port.targetPort ?? port.port;
    const declared = pods.flatMap((p) => (p.spec?.containers ?? []).flatMap((ct) => ct.ports ?? []));
    if (!declared.length) continue;
    const hit = typeof tp === "number" ? declared.some((d) => d.containerPort === tp) : declared.some((d) => d.name === tp);
    if (hit) continue;
    const real = [...new Set(declared.map((d) => d.containerPort))];
    out.push({
      level: "bad",
      title: "Wrong targetPort",
      detail: `Port ${port.port} forwards to ${typeof tp === "number" ? "port" : "a port named"} ${tp}, but its Pods listen on ${real.join(", ")}. Connections are refused.`,
      fixes: real.length === 1 ? [cmd(`Forward to ${real[0]}`, `kubectl patch service ${s.metadata.name} -p '${JSON.stringify({ spec: { ports: [{ port: port.port, targetPort: real[0] }] } })}'${nsFlag(ns)}`)] : [],
    });
  }
  if (s.spec?.type === "LoadBalancer" && !s.status?.loadBalancer?.ingress?.length) out.push({ level: "info", title: "Waiting for an external IP", detail: "The cloud's load balancer hasn't given it an address yet." });
  return out;
}

function ingressFindings(c: Cluster, ing: Ingress): Finding[] {
  const ns = ing.metadata.namespace ?? "default";
  const out: Finding[] = [];
  const backends = [...(ing.spec?.rules ?? []).flatMap((r) => r.http?.paths.map((p) => p.backend.service?.name) ?? []), ing.spec?.defaultBackend?.service?.name].filter((x): x is string => !!x);
  for (const name of [...new Set(backends)]) {
    const s = c.raw("Service", ns, name);
    if (!s) out.push({ level: "bad", title: `Service ${name} doesn't exist`, detail: `A rule sends requests to Service ${name}, which isn't there, so they get a 503.` });
    else if (serviceFindings(c, s as unknown as Service).some((f) => f.level === "bad")) out.push({ level: "bad", title: `Service ${name} can't answer`, detail: `A rule sends requests to Service ${name}, which has no ready endpoints, so they get a 503.`, see: { kind: "service", ns, name } });
  }
  if (!ing.status?.loadBalancer?.ingress?.length) out.push({ level: "info", title: "No address yet", detail: "The ingress controller hasn't picked it up. It needs one running (ingress-nginx) and a matching ingressClassName." });
  return out;
}

// ---------------------------------------------------------------- Nodes

function nodeFindings(c: Cluster, n: Node): Finding[] {
  const out: Finding[] = [];
  const nm = n.metadata.name;
  const isCp = "node-role.kubernetes.io/control-plane" in (n.metadata.labels ?? {});
  if (nodeDown(c, nm)) {
    out.push({ level: "bad", title: "Not responding", detail: "Its kubelet stopped (a simulated failure). After about 50 s it's NotReady and Services stop sending its Pods traffic; about 5 minutes later those Pods are evicted and their controllers recreate them on other Nodes.", fixes: [recover(nm)] });
  } else if (!c.nodeReady(n)) {
    out.push({ level: "warn", title: "Not ready yet", detail: "Its kubelet is starting up. No Pods are scheduled here until it reports Ready." });
  }
  if (n.spec?.unschedulable) out.push({ level: "warn", title: "Cordoned", detail: "No new Pods are scheduled here. The Pods already here keep running.", fixes: [cmd("Uncordon it", `kubectl uncordon ${nm}`)] });
  for (const cd of n.status?.conditions ?? []) if (cd.type !== "Ready" && cd.status === "True") out.push({ level: "bad", title: cd.type.replace(/([a-z])([A-Z])/g, "$1 $2"), detail: cd.message ?? `${cd.type} is True: the kubelet starts evicting Pods to recover.` });

  const pods = c.list<Pod>("Pod").filter((p) => p.spec?.nodeName === nm && p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed");
  const alloc = nodeAllocatable(n);
  const req = pods.reduce((a, p) => a + podRequests(p.spec).cpu, 0);
  const pending = c.list<Pod>("Pod").filter((p) => !p.spec?.nodeName && p.status?.phase === "Pending" && /Insufficient/.test(lastEvent(c, p as unknown as AnyObject, "FailedScheduling")?.message ?? ""));
  if (alloc.cpu && req >= alloc.cpu * 0.9 && !isCp) out.push({ level: pending.length ? "bad" : "warn", title: "Full", detail: `Its Pods request ${req}m of its ${alloc.cpu}m CPU.${pending.length ? ` ${plural(pending.length, "Pod")} can't find room on any Node and wait Pending.` : " New Pods that don't fit go elsewhere, or wait Pending."}`, fixes: pending.length ? [addNode] : [], see: pending[0] ? { kind: "pod", ns: pending[0].metadata.namespace, name: pending[0].metadata.name } : undefined });
  const use = c.state.metrics.nodes[nm]?.cpu;
  if (use && alloc.cpu && use >= alloc.cpu * 0.95 && !isCp) out.push({ level: "warn", title: "CPU used up", detail: `It's using ${use}m of ${alloc.cpu}m. Its Pods share what there is by their CPU requests, so each runs slower.`, fixes: [addNode] });

  // A new, empty worker: running Pods never move to it.
  const apps = pods.filter((p) => !p.metadata.ownerReferences?.some((o) => o.kind === "DaemonSet") && !["kube-system", "local-path-storage", "ingress-nginx"].includes(p.metadata.namespace ?? ""));
  const deps = c.list<Deployment>("Deployment", "default").filter((d) => (d.spec?.replicas ?? 0) > 0).sort((a, b) => (b.spec?.replicas ?? 0) - (a.spec?.replicas ?? 0));
  if (!isCp && c.nodeReady(n) && !n.spec?.unschedulable && !apps.length && deps.length) {
    out.push({
      level: "info",
      title: "Nothing runs here yet",
      detail: "Running Pods never move to a new Node; the scheduler only places new ones, on the least-loaded Node. Scale a Deployment up, or restart it to replace its Pods one by one, and they spread out onto this one.",
      fixes: deps.slice(0, 2).map((d) => cmd(`Restart ${d.metadata.name}`, `kubectl rollout restart deployment ${d.metadata.name}`)),
    });
  }
  return out;
}

// ---------------------------------------------------------------- storage and autoscaling

function pvcFindings(c: Cluster, pvc: PersistentVolumeClaim): Finding[] {
  const ns = pvc.metadata.namespace ?? "default";
  const users = c.list<Pod>("Pod", ns).filter((p) => p.spec?.volumes?.some((v) => v.persistentVolumeClaim?.claimName === pvc.metadata.name));
  if (pvc.metadata.deletionTimestamp) return [{ level: "info", title: "Waiting to be deleted", detail: `${users.length ? `Pod ${users[0].metadata.name} still uses it, so` : "Until no Pod uses it,"} it stays in Terminating (pvc-protection) and the data is safe.`, see: users[0] ? { kind: "pod", ns, name: users[0].metadata.name } : undefined }];
  if (pvc.status?.phase === "Bound") return [];
  const failed = lastEvent(c, pvc as unknown as AnyObject, /ProvisioningFailed|FailedBinding/);
  if (failed) return [{ level: "bad", title: "Can't get a volume", detail: explainEvent(failed) }];
  if (lastEvent(c, pvc as unknown as AnyObject, "WaitForFirstConsumer") && !users.length) return [{ level: "info", title: "Waits for a Pod", detail: "Its StorageClass makes the volume on the Node where the first Pod using it lands, so it stays Pending until one does." }];
  return [];
}

function hpaFindings(c: Cluster, h: HorizontalPodAutoscaler): Finding[] {
  const ns = h.metadata.namespace ?? "default";
  const t = h.spec?.scaleTargetRef;
  if (!t) return [];
  const kind = t.kind === "StatefulSet" ? "statefulset" : "deployment";
  if (!c.raw(t.kind, ns, t.name)) return [{ level: "bad", title: `${t.kind} ${t.name} doesn't exist`, detail: "It has nothing to scale." }];
  const miss = lastEvent(c, h as unknown as AnyObject, "FailedGetResourceMetric");
  if (miss && /missing request/.test(miss.message) && !h.status?.currentMetrics?.length)
    return [{ level: "bad", title: "No CPU requests to measure against", detail: `Utilisation is CPU used ÷ CPU requested, and ${t.name}'s Pods request no CPU, so it can't compute it and won't scale.`, fixes: [cmd("Request CPU", `kubectl set resources ${kind} ${t.name} --requests=cpu=100m${nsFlag(ns)}`)] }];
  if (!h.status?.currentMetrics?.length) return [{ level: "info", title: "No metrics yet", detail: "metrics-server scrapes every 15 seconds; it starts scaling once it has a reading." }];
  const cur = h.status.currentMetrics[0]?.resource?.current?.averageUtilization;
  const tgt = h.spec?.metrics?.[0]?.resource?.target.averageUtilization ?? 80;
  const max = h.spec?.maxReplicas ?? 1;
  if ((h.status.currentReplicas ?? 0) >= max && cur !== undefined && cur > tgt) return [{ level: "warn", title: "At its maximum", detail: `CPU is at ${cur}% against a ${tgt}% target, so it wants more Pods, but it's at its max of ${max}.`, fixes: [cmd(`Raise the max to ${max * 2}`, `kubectl patch hpa ${h.metadata.name} -p '{"spec":{"maxReplicas":${max * 2}}}'${nsFlag(ns)}`)] }];
  return [];
}
