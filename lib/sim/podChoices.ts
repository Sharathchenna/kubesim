// "What should this Pod run?": when a Learner adds a Pod (dropped on a Node, or clicked in the
// palette), the choices come from the cluster in front of them: more of the workloads already
// running, tools pointed at its Services, and small breakages to diagnose. Each is one kubectl
// command, run in the terminal so it's learned.

import { nodeAllocatable, podRequests, type Cluster, type Deployment, type HorizontalPodAutoscaler, type Node, type Pod, type Service, type StatefulSet } from "@/lib/engine";
import { SYSTEM_NAMESPACES } from "@/lib/engine/bootstrap";

export type PodChoiceGroup = "More of what's running" | "Tools" | "Break something";

export interface PodChoice {
  id: string;
  group: PodChoiceGroup;
  label: string;
  hint: string;
  cmd: string;
  /** What to watch for once it's run. */
  note: string;
}

const isCp = (n: Node) => "node-role.kubernetes.io/control-plane" in (n.metadata.labels ?? {});
const freeName = (c: Cluster, base: string) => {
  if (!c.raw("Pod", "default", base)) return base;
  for (let i = 2; ; i++) if (!c.raw("Pod", "default", `${base}-${i}`)) return `${base}-${i}`;
};
/** CPU (millicores) requested on a Node by the Pods there. */
const requested = (c: Cluster, node: string) =>
  c
    .list<Pod>("Pod")
    .filter((p) => p.spec?.nodeName === node && p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed")
    .reduce((a, p) => a + podRequests(p.spec).cpu, 0);

/** The worker the scheduler would pick for a small Pod: the least requested, among those that take Pods. */
export function emptiestNode(c: Cluster): string | undefined {
  const ok = c.list<Node>("Node").filter((n) => !isCp(n) && !n.spec?.unschedulable && c.nodeReady(n) && c.state.nodes[n.metadata.name]?.up !== false);
  return ok.map((n) => ({ n: n.metadata.name, r: requested(c, n.metadata.name) / Math.max(1, nodeAllocatable(n).cpu) })).sort((a, b) => a.r - b.r)[0]?.n;
}

export function podChoices(c: Cluster, node?: string): PodChoice[] {
  const out: PodChoice[] = [];
  const pin = node ? `{"spec":{"nodeSelector":{"kubernetes.io/hostname":"${node}"}}}` : undefined;
  const pinFlag = pin ? ` --overrides='${pin}'` : "";
  const where = node ? ` on ${node}` : "";
  const placed = node ? ` It's pinned to ${node} with a nodeSelector.` : " The scheduler picks its Node.";

  // ---- more of what's running: the honest way to get a Pod of an app is another replica.
  const hpaOwned = new Set(c.list<HorizontalPodAutoscaler>("HorizontalPodAutoscaler").map((h) => `${h.metadata.namespace}/${h.spec?.scaleTargetRef.kind}/${h.spec?.scaleTargetRef.name}`));
  const bottleneck = c.state.loadStats?.bottleneck?.name;
  const workloads = [
    ...c.list<Deployment>("Deployment").map((o) => ({ o, kind: "deployment" as const, k: "Deployment" })),
    ...c.list<StatefulSet>("StatefulSet").map((o) => ({ o, kind: "statefulset" as const, k: "StatefulSet" })),
  ]
    .filter(({ o }) => !SYSTEM_NAMESPACES.has(o.metadata.namespace ?? ""))
    .sort((a, b) => Number(b.o.metadata.name === bottleneck) - Number(a.o.metadata.name === bottleneck) || a.o.metadata.name.localeCompare(b.o.metadata.name));
  const emptiest = emptiestNode(c);
  for (const { o, kind, k } of workloads.slice(0, 5)) {
    const ns = o.metadata.namespace ?? "default";
    const name = o.metadata.name;
    const n = o.spec?.replicas ?? 1;
    const auto = hpaOwned.has(`${ns}/${k}/${name}`);
    const lands = emptiest ? (node && node !== emptiest ? `The scheduler, not you, picks the Node: the emptiest is ${emptiest}, not ${node}. To keep a workload on one Node, give its Pod template a nodeSelector.` : `The scheduler picks the emptiest Node, which is ${emptiest}.`) : "The scheduler picks its Node.";
    out.push({
      id: `scale:${kind}/${ns}/${name}`,
      group: "More of what's running",
      label: `Another ${name} Pod`,
      hint: `${k} · ${n} → ${n + 1}${name === bottleneck ? " · the traffic's bottleneck" : ""}${auto ? " · its HPA may scale it back" : ""}`,
      cmd: `kubectl scale ${kind} ${name} --replicas=${n + 1}${ns !== "default" ? ` -n ${ns}` : ""}`,
      note: `${k} ${name} now wants ${n + 1} Pods, so its controller creates one. ${kind === "statefulset" ? `It's ${name}-${n}, with its own volume. ` : ""}${lands}`,
    });
  }

  // ---- tools, pointed at what's here.
  const services = c
    .list<Service>("Service", "default")
    .filter((s) => s.metadata.name !== "kubernetes" && s.spec?.clusterIP !== "None" && s.spec?.selector)
    .sort((a, b) => Number(b.metadata.name.endsWith("-web") || b.metadata.name === "web") - Number(a.metadata.name.endsWith("-web") || a.metadata.name === "web"));
  const svc = services[0]?.metadata.name;
  const debug = freeName(c, "debug");
  out.push({
    id: "debug",
    group: "Tools",
    label: "A shell to look around",
    hint: `busybox${where}, for exec, wget and nslookup`,
    cmd: `kubectl run ${debug} --image=busybox${pinFlag} -- sleep 3600`,
    note: `A busybox Pod to work from inside the cluster.${placed} Try ${svc ? `kubectl exec ${debug} -- wget -qO- http://${svc}` : `kubectl exec ${debug} -- nslookup kubernetes`}.`,
  });
  for (const s of services.slice(0, 2)) {
    const lg = freeName(c, `load-${s.metadata.name}`);
    out.push({
      id: `load:${s.metadata.name}`,
      group: "Tools",
      label: `Send traffic to ${s.metadata.name}`,
      hint: "a busybox loop of wget",
      cmd: `kubectl run ${lg} --image=busybox${pinFlag} -- /bin/sh -c "while sleep 0.05; do wget -q -O- http://${s.metadata.name}; done"`,
      note: `It requests http://${s.metadata.name} about 20 times a second, so you can watch the Service spread them over its Pods.${placed}`,
    });
  }
  out.push({
    id: "nginx",
    group: "Tools",
    label: "A plain nginx Pod",
    hint: "a bare Pod: nothing replaces it",
    cmd: `kubectl run ${freeName(c, "nginx")} --image=nginx${pinFlag}`,
    note: `A bare Pod.${placed} Delete it and it's gone for good: that's what Deployments are for.`,
  });

  // ---- break something: each lands in a state the sidebar explains.
  const broke = (id: string, label: string, hint: string, cmd: string, watch: string) => out.push({ id, group: "Break something", label, hint, cmd, note: `${watch} Click it to see what's wrong and how to fix it.` });
  broke("typo", "A typo in the image name", "ngnix instead of nginx", `kubectl run ${freeName(c, "typo")} --image=ngnix${pinFlag}`, "The kubelet can't pull an image that doesn't exist: ErrImagePull, then ImagePullBackOff.");
  broke("crash", "One that crashes on start", "exits with code 1 after 3 s", `kubectl run ${freeName(c, "crashy")} --image=busybox${pinFlag} -- sh -c "echo starting; sleep 3; exit 1"`, "It starts, exits, and the kubelet restarts it, waiting longer each time: CrashLoopBackOff.");
  const hog = freeName(c, "hog");
  broke("oom", "One that runs out of memory", "wants 128Mi, limited to 64Mi", `kubectl run ${hog} --image=polinux/stress --overrides='{"spec":{${pin ? `"nodeSelector":{"kubernetes.io/hostname":"${node}"},` : ""}"containers":[{"name":"${hog}","image":"polinux/stress","args":["--vm","1","--vm-bytes","128M"],"resources":{"limits":{"memory":"64Mi"}}}]}}'`, "It allocates past its memory limit and the kernel kills it: OOMKilled, exit code 137.");
  const nodes = c.list<Node>("Node");
  const target = node ? nodes.find((n) => n.metadata.name === node) : undefined;
  const cores = Math.ceil((target ? nodeAllocatable(target).cpu : Math.max(...nodes.map((n) => nodeAllocatable(n).cpu))) / 1000) + 1;
  const big = freeName(c, "big");
  broke("big", `Too big for ${node ?? "any Node"}`, `requests ${cores} CPUs`, `kubectl run ${big} --image=nginx --overrides='{"spec":{${pin ? `"nodeSelector":{"kubernetes.io/hostname":"${node}"},` : ""}"containers":[{"name":"${big}","image":"nginx","resources":{"requests":{"cpu":"${cores}"}}}]}}'`, `No Node${node ? ` it may use` : ""} has ${cores} CPUs free, so the scheduler leaves it Pending.`);
  const cfg = freeName(c, "configless");
  broke("config", "One missing its ConfigMap", "reads app-settings, which doesn't exist", `kubectl run ${cfg} --image=nginx --overrides='{"spec":{${pin ? `"nodeSelector":{"kubernetes.io/hostname":"${node}"},` : ""}"containers":[{"name":"${cfg}","image":"nginx","env":[{"name":"MODE","valueFrom":{"configMapKeyRef":{"name":"app-settings","key":"mode"}}}]}]}}'`, "Its container can't be created without the ConfigMap it reads: CreateContainerConfigError.");
  const nr = freeName(c, "unready");
  broke("unready", "One that's never ready", "its readiness check hits a closed port", `kubectl run ${nr} --image=nginx --overrides='{"spec":{${pin ? `"nodeSelector":{"kubernetes.io/hostname":"${node}"},` : ""}"containers":[{"name":"${nr}","image":"nginx","readinessProbe":{"httpGet":{"path":"/","port":8080},"periodSeconds":5}}]}}'`, "It runs, but its readiness probe asks port 8080 and nginx listens on 80, so it never turns Ready and gets no traffic.");
  return out;
}
