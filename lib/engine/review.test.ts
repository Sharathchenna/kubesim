// Regression tests for the pre-release engine review: the update path (defaulting →
// admission → validation), kubectl apply's three-way merge, the container shell, init
// containers, scheduling (affinity, topology spread, preemption) and the controller fixes.
import { describe, expect, test } from "bun:test";
import YAML from "yaml";
import { Cluster, ApiError, MAX_PODS, killNode, userFor, type AnyObject, type Deployment, type EndpointSlice, type Endpoints, type HorizontalPodAutoscaler, type Job, type KubeEvent, type Node, type PersistentVolumeClaim, type Pod, type ReplicaSet, type Service } from "./index";
import { evictPod } from "./policy";
import { podStatusColumns } from "./podstatus";
import { runArgv, execEnv } from "./exec";

const apply = (c: Cluster, text: string, opts = {}) => YAML.parseAllDocuments(text).map((d) => c.apply(d.toJSON() as AnyObject, opts));
const action = (c: Cluster, text: string) => apply(c, text)[0].action;
const pod = (c: Cluster, name: string, ns = "default") => c.get<Pod>("Pod", ns, name);
const until = (c: Cluster, cond: () => boolean, maxMs = 120_000, step = 500) => {
  for (let t = 0; t < maxMs && !cond(); t += step) c.advance(step);
  return cond();
};
const errorOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};
const logs = (c: Cluster, p: Pod, container: string) => (c.logsFor(p, container) ?? []).map((l) => l.text);
const events = (c: Cluster, reason: string) => c.list<KubeEvent>("Event").filter((e) => e.reason === reason);

const podYaml = (name: string, image: string, extra = "") => `apiVersion: v1
kind: Pod
metadata: {name: ${name}}
spec:
  containers:
  - name: c
    image: ${image}
${extra}`;

describe("updates are defaulted and admitted before they are validated", () => {
  test("re-applying a Pod with only a new image succeeds", () => {
    const c = new Cluster({ systemPods: false });
    apply(c, podYaml("p", "nginx:1.27"));
    c.advance(10_000);
    expect(action(c, podYaml("p", "nginx:1.27"))).toBe("unchanged");
    expect(action(c, podYaml("p", "nginx:1.28"))).toBe("configured");
    expect(pod(c, "p").spec!.containers[0].image).toBe("nginx:1.28");
  });

  test("re-applying a StatefulSet with a new image rolls it", () => {
    const c = new Cluster();
    const sts = (img: string) => `apiVersion: apps/v1
kind: StatefulSet
metadata: {name: db}
spec:
  serviceName: db
  replicas: 1
  selector: {matchLabels: {app: db}}
  template:
    metadata: {labels: {app: db}}
    spec:
      containers: [{name: c, image: ${img}}]
  volumeClaimTemplates:
  - metadata: {name: data}
    spec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: 1Gi}}}`;
    apply(c, sts("nginx:1.27"));
    c.advance(20_000);
    expect(action(c, sts("nginx:1.27"))).toBe("unchanged");
    expect(action(c, sts("nginx:1.28"))).toBe("configured");
    expect(until(c, () => pod(c, "db-0").spec!.containers[0].image === "nginx:1.28" && pod(c, "db-0").status?.phase === "Running")).toBe(true);
  });

  test("a bound PVC re-applies unchanged; growing it needs an expandable StorageClass", () => {
    const c = new Cluster();
    const pvc = (size: string, sc = "") => `apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: claim}
spec:
  accessModes: [ReadWriteOnce]
  ${sc}
  resources: {requests: {storage: ${size}}}`;
    apply(c, pvc("1Gi") + "\n---\n" + podYaml("user", "nginx:1.27", "    volumeMounts: [{name: d, mountPath: /data}]\n  volumes: [{name: d, persistentVolumeClaim: {claimName: claim}}]"));
    expect(until(c, () => c.get<PersistentVolumeClaim>("PersistentVolumeClaim", "default", "claim").status?.phase === "Bound")).toBe(true);
    expect(action(c, pvc("1Gi"))).toBe("unchanged");
    expect(errorOf(() => apply(c, pvc("2Gi")))).toBe(
      'Error from server (Forbidden): persistentvolumeclaims "claim" is forbidden: only dynamically provisioned pvc can be resized and the storageclass that provisions the pvc must support resize',
    );

    apply(c, `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: {name: grow}
provisioner: rancher.io/local-path
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true`);
    apply(c, pvc("1Gi", "storageClassName: grow").replace("name: claim", "name: g") + "\n---\n" + podYaml("u2", "nginx:1.27", "    volumeMounts: [{name: d, mountPath: /data}]\n  volumes: [{name: d, persistentVolumeClaim: {claimName: g}}]"));
    expect(until(c, () => c.get<PersistentVolumeClaim>("PersistentVolumeClaim", "default", "g").status?.phase === "Bound")).toBe(true);
    expect(action(c, pvc("3Gi", "storageClassName: grow").replace("name: claim", "name: g"))).toBe("configured");
    expect(until(c, () => c.get<PersistentVolumeClaim>("PersistentVolumeClaim", "default", "g").status?.capacity?.storage === "3Gi")).toBe(true);
    expect(errorOf(() => apply(c, pvc("1Gi", "storageClassName: grow").replace("name: claim", "name: g")))).toContain("spec.resources.requests.storage: Forbidden: field can not be less than status.capacity");
  });

  test("a Job re-applies unchanged, and a mutable field can change", () => {
    const c = new Cluster({ systemPods: false });
    const job = (p: number) => `apiVersion: batch/v1
kind: Job
metadata: {name: j}
spec:
  parallelism: ${p}
  completions: 10
  template:
    spec:
      restartPolicy: Never
      containers: [{name: c, image: busybox:1.36, command: ["sh", "-c", "sleep 30"]}]`;
    apply(c, job(1));
    c.advance(5_000);
    expect(action(c, job(1))).toBe("unchanged");
    expect(action(c, job(3))).toBe("configured");
    expect(c.get<Job>("Job", "default", "j").spec!.parallelism).toBe(3);
  });

  test("LimitRange defaults are validated: a default limit below the request is rejected", () => {
    const c = new Cluster({ systemPods: false });
    apply(c, `apiVersion: v1
kind: LimitRange
metadata: {name: lr}
spec:
  limits: [{type: Container, default: {cpu: 500m}, defaultRequest: {cpu: 250m}}]`);
    expect(errorOf(() => apply(c, podYaml("p", "nginx:1.27", '    resources: {requests: {cpu: "1"}}')))).toBe(
      'The Pod "p" is invalid: spec.containers[0].resources.requests: Invalid value: "1": must be less than or equal to cpu limit of 500m',
    );
  });

  test("Recreate with a rollingUpdate block is rejected", () => {
    const c = new Cluster({ systemPods: false });
    expect(
      errorOf(() =>
        c.create({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "d" }, spec: { selector: { matchLabels: { a: "b" } }, strategy: { type: "Recreate", rollingUpdate: { maxSurge: 1 } }, template: { metadata: { labels: { a: "b" } }, spec: { containers: [{ name: "c", image: "nginx" }] } } } } as never),
      ),
    ).toBe("The Deployment \"d\" is invalid: spec.strategy.rollingUpdate: Forbidden: may not be specified when strategy `type` is 'Recreate'");
  });
});

describe("kubectl apply is a three-way merge", () => {
  const deploy = (extra = "") => `apiVersion: apps/v1
kind: Deployment
metadata: {name: web, labels: {app: web}}
spec:
  replicas: 2
  selector: {matchLabels: {app: web}}
  template:
    metadata: {labels: {app: web}}
    spec:
      containers:
      - name: web
        image: nginx:1.27
${extra}`;

  test("re-applying after rollout restart and kubectl label changes nothing", () => {
    const c = new Cluster({ systemPods: false });
    apply(c, deploy());
    c.advance(20_000);
    const d = c.get<Deployment>("Deployment", "default", "web");
    // What kubectl rollout restart and kubectl label write.
    c.replace({ ...d, metadata: { ...d.metadata, labels: { ...d.metadata.labels, team: "a" } }, spec: { ...d.spec!, template: { ...d.spec!.template, metadata: { ...d.spec!.template.metadata, annotations: { "kubectl.kubernetes.io/restartedAt": "2026-01-01T09:00:20Z" } } } } });
    c.advance(30_000);
    const rsBefore = c.list<ReplicaSet>("ReplicaSet").length;
    expect(action(c, deploy())).toBe("unchanged");
    c.advance(30_000);
    expect(c.list<ReplicaSet>("ReplicaSet").length).toBe(rsBefore);
    expect(c.get<Deployment>("Deployment", "default", "web").metadata.labels?.team).toBe("a");
  });

  test("fields removed from the manifest since the last apply are removed", () => {
    const c = new Cluster({ systemPods: false });
    apply(c, deploy("        env: [{name: A, value: '1'}, {name: B, value: '2'}]"));
    apply(c, deploy("        env: [{name: A, value: '1'}]"));
    expect(c.get<Deployment>("Deployment", "default", "web").spec!.template.spec.containers[0].env).toEqual([{ name: "A", value: "1" }]);
    apply(c, deploy());
    expect(c.get<Deployment>("Deployment", "default", "web").spec!.template.spec.containers[0].env).toBeUndefined();
  });

  test("changing strategy to Recreate in the manifest drops the defaulted rollingUpdate (retainKeys)", () => {
    const c = new Cluster({ systemPods: false });
    apply(c, deploy());
    apply(c, deploy().replace("  replicas: 2", "  replicas: 2\n  strategy: {type: Recreate}"));
    expect(c.get<Deployment>("Deployment", "default", "web").spec!.strategy).toEqual({ type: "Recreate" });
  });

  test("a Service keeps its nodePort, and can go from NodePort back to ClusterIP", () => {
    const c = new Cluster({ systemPods: false });
    const svc = (t: string) => `apiVersion: v1
kind: Service
metadata: {name: s}
spec:
  type: ${t}
  selector: {app: x}
  ports: [{port: 80}]`;
    apply(c, svc("NodePort"));
    const np = c.get<Service>("Service", "default", "s").spec!.ports![0].nodePort;
    expect(action(c, svc("NodePort"))).toBe("unchanged");
    expect(c.get<Service>("Service", "default", "s").spec!.ports![0].nodePort).toBe(np);
    expect(action(c, svc("ClusterIP"))).toBe("configured");
    expect(c.get<Service>("Service", "default", "s").spec!.ports![0].nodePort).toBeUndefined();
    // A nodePort written on a ClusterIP Service is still an error.
    const cur = c.get<Service>("Service", "default", "s");
    expect(errorOf(() => c.replace({ ...cur, spec: { ...cur.spec!, ports: [{ ...cur.spec!.ports![0], nodePort: 30123 }] } }))).toContain("nodePort: Forbidden: may not be used when `type` is 'ClusterIP'");
  });

  test("applying over an object kubectl create made warns about the missing annotation", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "cm" }, data: { a: "1" } } as never);
    c.drainWarnings();
    apply(c, "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: cm}\ndata: {a: '2'}");
    expect(c.drainWarnings()[0]).toContain("resource configmaps/cm is missing the kubectl.kubernetes.io/last-applied-configuration annotation");
  });
});

describe("container shell", () => {
  const sh = (c: Cluster, name: string, script: string) =>
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name }, spec: { containers: [{ name: "c", image: "busybox:1.36", command: ["sh", "-c", script] }] } } as never);

  test("a for loop runs every iteration, then the rest of the script", () => {
    const c = new Cluster({ systemPods: false });
    sh(c, "f", "for i in 1 2 3; do echo n$i; done; for j in $(seq 4 5); do echo s$j; done; sleep 3600");
    c.advance(15_000);
    expect(pod(c, "f").status?.phase).toBe("Running");
    expect(pod(c, "f").status?.containerStatuses?.[0].restartCount).toBe(0);
    expect(logs(c, pod(c, "f"), "c")).toEqual(["n1", "n2", "n3", "s4", "s5"]);
  });

  test("while and until loops stop when their condition says so", () => {
    const c = new Cluster({ systemPods: false });
    sh(c, "w", "touch /tmp/x; while [ -f /tmp/x ]; do echo tick; rm /tmp/x; done; echo out; sleep 3600");
    sh(c, "u", "until test -f /tmp/ready; do echo wait; touch /tmp/ready; done; echo ready; sleep 3600");
    c.advance(15_000);
    expect(logs(c, pod(c, "w"), "c")).toEqual(["tick", "out"]);
    expect(logs(c, pod(c, "u"), "c")).toEqual(["wait", "ready"]);
  });

  test("a bad grep pattern is grep's error, not a crashed cluster", () => {
    const c = new Cluster({ systemPods: false });
    sh(c, "g", "sleep 1; grep '[' /etc/hosts; echo code=$?; grep '(' /etc/hosts || echo no-paren; sleep 3600");
    expect(() => c.advance(10_000)).not.toThrow();
    expect(logs(c, pod(c, "g"), "c")[0]).toBe("grep: bad regex '[': Unmatched [, [^, [:, [., or [=");
    expect(logs(c, pod(c, "g"), "c")).toContain("no-paren");
  });

  test("a huge seq range neither hangs nor unrolls", () => {
    const c = new Cluster({ systemPods: false });
    sh(c, "big", "for i in $(seq 1 1000000000); do sleep 1; done");
    const t = Date.now();
    c.advance(10_000);
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(c.state.pods[pod(c, "big").metadata.uid].containers.c.program!.length).toBeLessThan(10);
    sh(c, "s", "sleep 3600");
    c.advance(5_000);
    const p = pod(c, "s");
    const r = runArgv(execEnv(c, p, p.spec!.containers[0], {}), ["seq", "100000000"]);
    expect(r.out.split("\n").length).toBe(100_000);
  });
});

describe("init containers and sidecars", () => {
  test("run in order before the app; STATUS shows Init:x/y", () => {
    const c = new Cluster({ systemPods: false });
    c.create({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "p" },
      spec: {
        initContainers: [
          { name: "one", image: "busybox:1.36", command: ["sh", "-c", "echo one; sleep 3"] },
          { name: "two", image: "busybox:1.36", command: ["sh", "-c", "echo two; sleep 3"] },
        ],
        containers: [{ name: "app", image: "nginx:1.27" }],
      },
    } as never);
    expect(until(c, () => podStatusColumns(pod(c, "p")).status === "Init:0/2", 10_000, 100)).toBe(true);
    expect(pod(c, "p").status?.containerStatuses?.[0].state.waiting?.reason).toBe("PodInitializing");
    expect(until(c, () => podStatusColumns(pod(c, "p")).status === "Init:1/2", 10_000, 100)).toBe(true);
    expect(until(c, () => podStatusColumns(pod(c, "p")).ready === "1/1", 20_000, 100)).toBe(true);
    const p = pod(c, "p");
    expect(p.status?.conditions?.find((x) => x.type === "Initialized")?.status).toBe("True");
    expect(p.status?.initContainerStatuses?.map((s) => s.state.terminated?.reason)).toEqual(["Completed", "Completed"]);
    expect(podStatusColumns(p)).toEqual({ ready: "1/1", status: "Running", restarts: 0 });
  });

  test("a failing init container blocks the app (CrashLoopBackOff), or fails the Pod with restartPolicy Never", () => {
    const c = new Cluster({ systemPods: false });
    const mk = (name: string, rp: string) => c.create({ apiVersion: "v1", kind: "Pod", metadata: { name }, spec: { restartPolicy: rp, initContainers: [{ name: "bad", image: "busybox:1.36", command: ["sh", "-c", "exit 1"] }], containers: [{ name: "app", image: "nginx:1.27" }] } } as never);
    mk("loop", "Always");
    mk("once", "Never");
    expect(until(c, () => podStatusColumns(pod(c, "loop")).status === "Init:CrashLoopBackOff", 60_000)).toBe(true);
    expect(pod(c, "loop").status?.conditions?.find((x) => x.type === "Initialized")).toMatchObject({ status: "False", reason: "ContainersNotInitialized", message: "containers with incomplete status: [bad]" });
    expect(until(c, () => pod(c, "once").status?.phase === "Failed", 20_000)).toBe(true);
    expect(podStatusColumns(pod(c, "once")).status).toBe("Init:Error");
  });

  test("a sidecar starts first, keeps running and counts toward READY", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "s" }, spec: { initContainers: [{ name: "proxy", image: "nginx:1.27", restartPolicy: "Always" }], containers: [{ name: "app", image: "busybox:1.36", command: ["sleep", "3600"] }] } } as never);
    expect(until(c, () => podStatusColumns(pod(c, "s")).ready === "2/2", 30_000)).toBe(true);
    expect(pod(c, "s").status?.initContainerStatuses?.[0].state.running).toBeDefined();
  });

  test("count toward the scheduler's effective requests", () => {
    const c = new Cluster({ systemPods: false });
    const err = errorOf(() => c.advance(0));
    expect(err).toBe("");
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "fat" }, spec: { initContainers: [{ name: "i", image: "busybox:1.36", command: ["true"], resources: { requests: { cpu: "10" } } }], containers: [{ name: "a", image: "nginx:1.27" }] } } as never);
    c.advance(6_000);
    expect(pod(c, "fat").status?.conditions?.find((x) => x.type === "PodScheduled")?.message).toContain("Insufficient cpu");
  });
});

describe("scheduling", () => {
  const web = (name: string, extra: object) => ({ apiVersion: "v1", kind: "Pod", metadata: { name, labels: { app: "web" } }, spec: { containers: [{ name: "c", image: "nginx:1.27" }], ...extra } });

  test("topologySpreadConstraints DoNotSchedule keeps the skew within maxSkew", () => {
    const c = new Cluster({ systemPods: false });
    const tsc = { topologySpreadConstraints: [{ maxSkew: 1, topologyKey: "kubernetes.io/hostname", whenUnsatisfiable: "DoNotSchedule", labelSelector: { matchLabels: { app: "web" } } }], nodeSelector: { "kubernetes.io/hostname": "worker-1" } };
    c.create(web("a", tsc) as never);
    c.create(web("b", tsc) as never);
    c.advance(6_000);
    expect(pod(c, "a").spec?.nodeName).toBe("worker-1");
    // worker-2 doesn't count for b's constraint (nodeAffinityPolicy Honor), so a second Pod on worker-1 is skew 2-0? No: only worker-1 is eligible.
    expect(pod(c, "b").spec?.nodeName).toBe("worker-1");
    const free = { topologySpreadConstraints: tsc.topologySpreadConstraints, affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: "node-role.kubernetes.io/control-plane", operator: "DoesNotExist" }] }] } } } };
    c.create(web("c", free) as never);
    c.create(web("d", free) as never);
    c.advance(6_000);
    expect(pod(c, "c").spec?.nodeName).toBe("worker-2");
    expect(pod(c, "d").spec?.nodeName).toBe("worker-2");
    c.create(web("e", { ...free, topologySpreadConstraints: [{ ...tsc.topologySpreadConstraints[0], topologyKey: "topology.kubernetes.io/zone" }] }) as never);
    c.advance(6_000);
    expect(pod(c, "e").status?.conditions?.find((x) => x.type === "PodScheduled")?.message).toContain("node(s) didn't match pod topology spread constraints (missing required label)");
  });

  test("required pod affinity and anti-affinity", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "cache", labels: { app: "cache" } }, spec: { nodeName: "worker-2", containers: [{ name: "c", image: "redis:7" }] } } as never);
    const term = { labelSelector: { matchLabels: { app: "cache" } }, topologyKey: "kubernetes.io/hostname" };
    c.create(web("near", { affinity: { podAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [term] } } }) as never);
    c.create(web("far", { affinity: { podAntiAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [term] } } }) as never);
    c.create(web("lost", { affinity: { podAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [{ ...term, labelSelector: { matchLabels: { app: "nope" } } }] } } }) as never);
    c.advance(6_000);
    expect(pod(c, "near").spec?.nodeName).toBe("worker-2");
    expect(pod(c, "far").spec?.nodeName).toBe("worker-1");
    expect(pod(c, "lost").status?.conditions?.find((x) => x.type === "PodScheduled")?.message).toBe(
      "0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 node(s) didn't match pod affinity rules. preemption: 0/3 nodes are available: 3 Preemption is not helpful for scheduling.",
    );
  });

  test("a higher-priority Pod preempts lower-priority ones", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "scheduling.k8s.io/v1", kind: "PriorityClass", metadata: { name: "high" }, value: 1000 } as never);
    for (const n of ["w1", "w2"]) c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: n }, spec: { containers: [{ name: "c", image: "nginx:1.27", resources: { requests: { cpu: "3" } } }] } } as never);
    c.advance(6_000);
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "vip" }, spec: { priorityClassName: "high", containers: [{ name: "c", image: "nginx:1.27", resources: { requests: { cpu: "3" } } }] } } as never);
    c.advance(200);
    const vip = pod(c, "vip");
    expect(vip.status?.nominatedNodeName).toMatch(/^worker-/);
    expect(events(c, "Preempted")[0].message).toBe(`Preempted by pod ${vip.metadata.uid} on node ${vip.status?.nominatedNodeName}`);
    expect(until(c, () => !!pod(c, "vip").spec?.nodeName, 60_000)).toBe(true);
    expect(c.list<Pod>("Pod").length).toBe(2);
  });

  test("a Pod for another scheduler stays Pending", () => {
    const c = new Cluster({ systemPods: false });
    c.create(web("other", { schedulerName: "my-scheduler" }) as never);
    c.advance(10_000);
    expect(pod(c, "other").spec?.nodeName).toBeUndefined();
  });
});

describe("controllers", () => {
  test("DaemonSet Pods stay on an unreachable Node", () => {
    const c = new Cluster();
    apply(c, `apiVersion: apps/v1
kind: DaemonSet
metadata: {name: agent}
spec:
  selector: {matchLabels: {app: agent}}
  template:
    metadata: {labels: {app: agent}}
    spec:
      containers: [{name: a, image: nginx:1.27}]`);
    c.advance(20_000);
    killNode(c, "worker-1");
    c.advance(120_000);
    const onW1 = c.list<Pod>("Pod").filter((p) => p.metadata.labels?.app === "agent" && p.spec?.nodeName === "worker-1");
    expect(onW1.length).toBe(1);
    expect(onW1[0].metadata.deletionTimestamp).toBeUndefined();
  });

  test("Pod IPs are reused and stay inside the Node's /24; LoadBalancer IPs are reused", () => {
    const c = new Cluster({ systemPods: false });
    for (let i = 0; i < 300; i++) {
      c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: `p${i}` }, spec: { nodeName: "worker-1", containers: [{ name: "c", image: "nginx:1.27" }] } } as never);
      c.advance(1_000);
      expect(pod(c, `p${i}`).status?.podIP).toMatch(/^10\.244\.1\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/);
      c.delete("Pod", "default", `p${i}`, { force: true });
    }
    for (let i = 0; i < 60; i++) {
      c.create({ apiVersion: "v1", kind: "Service", metadata: { name: `lb${i}` }, spec: { type: "LoadBalancer", selector: { a: "b" }, ports: [{ port: 80 }] } } as never);
      c.advance(2_500);
      const ip = c.get<Service>("Service", "default", `lb${i}`).status?.loadBalancer?.ingress?.[0]?.ip;
      expect(ip).toMatch(/^172\.18\.255\.(2[0-4]\d|250)$/);
      c.delete("Service", "default", `lb${i}`);
    }
  });

  test("container logs are dropped with their Pod and after two restarts", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "crash" }, spec: { containers: [{ name: "c", image: "busybox:1.36", command: ["sh", "-c", "echo hi; exit 1"] }] } } as never);
    c.advance(120_000);
    const uid = pod(c, "crash").metadata.uid;
    const keys = Object.keys(c.state.logs).filter((k) => k.startsWith(uid));
    expect(keys.length).toBeLessThanOrEqual(2);
    c.delete("Pod", "default", "crash", { force: true });
    expect(Object.keys(c.state.logs).some((k) => k.startsWith(uid))).toBe(false);
  });

  test("egress: [] doesn't make a policy an Egress policy", () => {
    const c = new Cluster({ systemPods: false });
    apply(c, "apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata: {name: np}\nspec:\n  podSelector: {}\n  egress: []");
    expect(c.get<AnyObject>("NetworkPolicy", "default", "np").spec).toMatchObject({ policyTypes: ["Ingress"] });
  });

  test("RBAC: you can't grant permissions you don't have unless you may bind or escalate", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: { name: "rb" }, rules: [{ apiGroups: ["rbac.authorization.k8s.io"], resources: ["rolebindings", "roles"], verbs: ["create"] }] } as never);
    c.create({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: { name: "bob-rb" }, roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "rb" }, subjects: [{ kind: "User", name: "bob" }] } as never);
    const bob = userFor("bob");
    const pwn = { apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: { name: "pwn" }, roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "cluster-admin" }, subjects: [{ kind: "User", name: "bob" }] };
    expect(errorOf(() => c.create(pwn as never, { user: bob }))).toBe(
      'Error from server (Forbidden): rolebindings.rbac.authorization.k8s.io "pwn" is forbidden: user "bob" (groups=["system:authenticated"]) is attempting to grant RBAC permissions not currently held:\n{APIGroups:["*"], Resources:["*"], Verbs:["*"]}\n{NonResourceURLs:["*"], Verbs:["*"]}',
    );
    expect(errorOf(() => c.create({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: { name: "r2" }, rules: [{ apiGroups: [""], resources: ["secrets"], verbs: ["get", "list"] }] } as never, { user: bob }))).toContain(
      'is attempting to grant RBAC permissions not currently held:\n{APIGroups:[""], Resources:["secrets"], Verbs:["get" "list"]}',
    );
    // A role that grants only what bob holds is fine; so is binding with the bind verb.
    expect(errorOf(() => c.create({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: { name: "r3" }, rules: [{ apiGroups: ["rbac.authorization.k8s.io"], resources: ["roles"], verbs: ["create"] }] } as never, { user: bob }))).toBe("");
    c.create({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", metadata: { name: "binder" }, rules: [{ apiGroups: ["rbac.authorization.k8s.io"], resources: ["clusterroles"], verbs: ["bind"], resourceNames: ["view"] }] } as never);
    c.create({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: { name: "bob-binder" }, roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "binder" }, subjects: [{ kind: "User", name: "bob" }] } as never);
    expect(errorOf(() => c.create({ ...pwn, metadata: { name: "viewer" }, roleRef: { ...pwn.roleRef, name: "view" } } as never, { user: bob }))).toBe("");
  });

  test("a PodDisruptionBudget with selector {} covers every Pod in its namespace; disruptedPods uses the sim clock", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web" }, spec: { replicas: 3, selector: { matchLabels: { app: "web" } }, template: { metadata: { labels: { app: "web" } }, spec: { containers: [{ name: "c", image: "nginx:1.27" }] } } } } as never);
    c.create({ apiVersion: "policy/v1", kind: "PodDisruptionBudget", metadata: { name: "all" }, spec: { selector: {}, minAvailable: 1 } } as never);
    c.advance(15_000);
    const pdb = () => c.get<AnyObject & { status: { currentHealthy: number; disruptionsAllowed: number; disruptedPods?: Record<string, string> } }>("PodDisruptionBudget", "default", "all");
    expect(pdb().status.currentHealthy).toBe(3);
    expect(pdb().status.disruptionsAllowed).toBe(2);
    const victim = c.list<Pod>("Pod")[0];
    expect(evictPod(c, victim).ok).toBe(true);
    expect(Object.values(pdb().status.disruptedPods ?? {})[0]).toMatch(/^2026-01-01T09:00:\d\dZ$/);
  });

  test("--cascade=foreground keeps the owner until its dependents are gone", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web" }, spec: { replicas: 2, selector: { matchLabels: { app: "web" } }, template: { metadata: { labels: { app: "web" } }, spec: { containers: [{ name: "c", image: "busybox:1.36", command: ["sh", "-c", "sleep 3600"] }] } } } } as never);
    c.advance(15_000);
    c.delete("Deployment", "default", "web", { propagationPolicy: "Foreground" });
    c.advance(1_000);
    const d = c.raw("Deployment", "default", "web");
    expect(d?.metadata.finalizers).toEqual(["foregroundDeletion"]);
    expect(d?.metadata.deletionTimestamp).toBeDefined();
    expect(until(c, () => !c.raw("Deployment", "default", "web"), 60_000)).toBe(true);
    expect(c.list<Pod>("Pod").length).toBe(0);
    expect(c.list<ReplicaSet>("ReplicaSet").length).toBe(0);
  });

  test("a ServiceAccount with automountServiceAccountToken: false gets no token volume", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "quiet" }, automountServiceAccountToken: false } as never);
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "a" }, spec: { serviceAccountName: "quiet", containers: [{ name: "c", image: "nginx:1.27" }] } } as never);
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "b" }, spec: { serviceAccountName: "quiet", automountServiceAccountToken: true, containers: [{ name: "c", image: "nginx:1.27" }] } } as never);
    expect(pod(c, "a").spec?.volumes ?? []).toEqual([]);
    expect(pod(c, "b").spec?.volumes?.[0].name).toMatch(/^kube-api-access-/);
  });

  test("CronJob Forbid: a run held back by an active Job starts when it finishes", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "batch/v1", kind: "CronJob", metadata: { name: "cj" }, spec: { schedule: "* * * * *", concurrencyPolicy: "Forbid", jobTemplate: { spec: { template: { spec: { restartPolicy: "Never", containers: [{ name: "c", image: "busybox:1.36", command: ["sh", "-c", "sleep 90"] }] } } } } } } as never);
    c.advance(200_000);
    expect(events(c, "JobAlreadyActive").length).toBeGreaterThan(0);
    // The second Job starts right after the first finishes, not at the following minute.
    const jobs = c.list<Job>("Job").sort((a, b) => a.metadata.creationTimestamp - b.metadata.creationTimestamp);
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    const firstDone = jobs[0].status?.completionTime ?? 0;
    expect(jobs[1].metadata.creationTimestamp - firstDone).toBeLessThan(2_000);
  });

  test("a Job with parallelism and no completions is a work queue", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "batch/v1", kind: "Job", metadata: { name: "wq" }, spec: { parallelism: 3, template: { spec: { restartPolicy: "Never", containers: [{ name: "c", image: "busybox:1.36", command: ["sh", "-c", "sleep 5"] }] } } } } as never);
    c.advance(30_000);
    const j = c.get<Job>("Job", "default", "wq");
    expect(j.spec?.completions).toBeUndefined();
    expect(j.status?.succeeded).toBe(3);
    expect(j.status?.conditions?.some((x) => x.type === "Complete")).toBe(true);
  });

  test("taint eviction counts from when the Pod meets the taint, even for taints written without timeAdded", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "t" }, spec: { nodeName: "worker-1", tolerations: [{ key: "maint", operator: "Exists", effect: "NoExecute", tolerationSeconds: 60 }], containers: [{ name: "c", image: "nginx:1.27" }] } } as never);
    c.advance(120_000);
    const n = c.get<Node>("Node", undefined, "worker-1");
    c.replace({ ...n, spec: { ...n.spec, taints: [...(n.spec?.taints ?? []), { key: "maint", effect: "NoExecute" }] } });
    c.advance(30_000);
    expect(pod(c, "t").metadata.deletionTimestamp).toBeUndefined();
    c.advance(40_000);
    expect(c.raw("Pod", "default", "t")?.metadata.deletionTimestamp ?? "gone").toBeDefined();
  });

  test("terminating Pods leave Endpoints (but stay in EndpointSlices as terminating)", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "slow", labels: { app: "s" } }, spec: { containers: [{ name: "c", image: "busybox:1.36", command: ["sh", "-c", "sleep 3600"] }] } } as never);
    c.create({ apiVersion: "v1", kind: "Service", metadata: { name: "s" }, spec: { selector: { app: "s" }, ports: [{ port: 80 }] } } as never);
    c.advance(10_000);
    c.delete("Pod", "default", "slow");
    c.advance(1_000);
    expect(c.get<Endpoints>("Endpoints", "default", "s").subsets).toBeUndefined();
    const slice = c.list<EndpointSlice>("EndpointSlice").find((s) => s.metadata.labels?.["kubernetes.io/service-name"] === "s")!;
    expect(slice.endpoints?.[0].conditions).toMatchObject({ ready: false, terminating: true });
  });

  test("HPA behavior: a scale-up policy of 1 Pod per minute is honoured", () => {
    const c = new Cluster();
    apply(c, `apiVersion: apps/v1
kind: Deployment
metadata: {name: hot}
spec:
  replicas: 1
  selector: {matchLabels: {app: hot}}
  template:
    metadata: {labels: {app: hot}}
    spec:
      containers: [{name: s, image: polinux/stress, command: [stress, --cpu, "1"], resources: {requests: {cpu: 100m}}}]
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: {name: hot}
spec:
  scaleTargetRef: {apiVersion: apps/v1, kind: Deployment, name: hot}
  minReplicas: 1
  maxReplicas: 10
  metrics: [{type: Resource, resource: {name: cpu, target: {type: Utilization, averageUtilization: 50}}}]
  behavior:
    scaleUp:
      policies: [{type: Pods, value: 1, periodSeconds: 60}]`);
    expect(until(c, () => (c.get<Deployment>("Deployment", "default", "hot").spec?.replicas ?? 1) > 1, 120_000)).toBe(true);
    expect(c.get<Deployment>("Deployment", "default", "hot").spec?.replicas).toBe(2);
    c.advance(30_000);
    expect(c.get<Deployment>("Deployment", "default", "hot").spec?.replicas).toBe(2);
    expect(c.get<HorizontalPodAutoscaler>("HorizontalPodAutoscaler", "default", "hot").status?.conditions?.find((x) => x.type === "ScalingLimited")?.reason).toBe("ScaleUpLimit");
    c.advance(45_000);
    expect(c.get<Deployment>("Deployment", "default", "hot").spec?.replicas).toBe(3);
  });

  test("StatefulSet whenScaled: Delete removes a scaled-away ordinal's claim", () => {
    const c = new Cluster();
    apply(c, `apiVersion: apps/v1
kind: StatefulSet
metadata: {name: db}
spec:
  serviceName: db
  replicas: 2
  persistentVolumeClaimRetentionPolicy: {whenScaled: Delete}
  selector: {matchLabels: {app: db}}
  template:
    metadata: {labels: {app: db}}
    spec:
      containers: [{name: c, image: nginx:1.27}]
  volumeClaimTemplates:
  - metadata: {name: data}
    spec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: 1Gi}}}`);
    expect(until(c, () => !!c.raw("PersistentVolumeClaim", "default", "data-db-1") && c.raw("Pod", "default", "db-1")?.status !== undefined && pod(c, "db-1").status?.phase === "Running")).toBe(true);
    const s = c.get<AnyObject>("StatefulSet", "default", "db");
    c.replace({ ...s, spec: { ...(s.spec as object), replicas: 1 } } as AnyObject);
    expect(until(c, () => !c.raw("PersistentVolumeClaim", "default", "data-db-1"), 120_000)).toBe(true);
    expect(c.raw("PersistentVolumeClaim", "default", "data-db-0")).toBeDefined();
  });
});

describe("pod-level details", () => {
  test("activeDeadlineSeconds fails the Pod with DeadlineExceeded", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "d" }, spec: { activeDeadlineSeconds: 5, containers: [{ name: "c", image: "nginx:1.27" }] } } as never);
    c.advance(15_000);
    expect(pod(c, "d").status).toMatchObject({ phase: "Failed", reason: "DeadlineExceeded" });
  });

  test("readinessGates keep a Pod unready until their condition is True", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "g" }, spec: { readinessGates: [{ conditionType: "example.com/ready" }], containers: [{ name: "c", image: "nginx:1.27" }] } } as never);
    c.advance(10_000);
    expect(pod(c, "g").status?.conditions?.find((x) => x.type === "Ready")).toMatchObject({ status: "False", reason: "ReadinessGatesNotReady", message: 'corresponding condition of pod readiness gate "example.com/ready" does not exist.' });
  });

  test("runAsNonRoot without runAsUser is CreateContainerConfigError; runAsUser shows in id", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "nr" }, spec: { securityContext: { runAsNonRoot: true }, containers: [{ name: "c", image: "nginx:1.27" }] } } as never);
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "u" }, spec: { securityContext: { runAsUser: 1000, runAsGroup: 3000 }, containers: [{ name: "c", image: "busybox:1.36", command: ["sleep", "3600"] }] } } as never);
    c.advance(10_000);
    expect(pod(c, "nr").status?.containerStatuses?.[0].state.waiting?.reason).toBe("CreateContainerConfigError");
    const u = pod(c, "u");
    expect(runArgv(execEnv(c, u, u.spec!.containers[0], {}), ["id"]).out).toBe("uid=1000 gid=3000 groups=3000");
  });
});

describe("API warnings for fields the simulator doesn't act on", () => {
  test("a user's create warns; a controller's doesn't", () => {
    const c = new Cluster({ systemPods: false });
    c.drainWarnings();
    c.create({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "h" }, spec: { replicas: 1, selector: { matchLabels: { a: "h" } }, template: { metadata: { labels: { a: "h" } }, spec: { containers: [{ name: "c", image: "nginx:1.27", lifecycle: { preStop: { exec: { command: ["sleep", "5"] } } } }] } } } } as never);
    expect(c.drainWarnings()).toEqual(["spec.template.spec.containers[0].lifecycle: lifecycle hooks (postStart, preStop) is not simulated by kubesim (accepted and stored, but has no effect)"]);
    c.advance(5_000); // the ReplicaSet controller creates the Pod: no warning for that
    expect(c.drainWarnings()).toEqual([]);
  });
});

describe("snapshots", () => {
  test("a snapshot from before trafficRng and initialized restores and runs", () => {
    const c = new Cluster({ seed: 3 });
    const snap = c.snapshot() as unknown as Record<string, unknown>;
    delete snap.trafficRng;
    const r = new Cluster(snap as never);
    expect(() => r.advance(5_000)).not.toThrow();
  });

  test("a restored cluster stays identical to the original", () => {
    const a = new Cluster({ seed: 11 });
    a.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "i" }, spec: { initContainers: [{ name: "w", image: "busybox:1.36", command: ["sh", "-c", "for i in 1 2; do sleep 1; done"] }], containers: [{ name: "c", image: "nginx:1.27" }] } } as never);
    a.advance(1_500);
    const b = new Cluster(a.snapshot());
    a.advance(20_000);
    b.advance(20_000);
    expect(JSON.stringify(b.snapshot())).toBe(JSON.stringify(a.snapshot()));
  });

  test("an ApiError still carries its reason", () => {
    const c = new Cluster({ systemPods: false });
    try {
      c.get("Pod", "default", "nope");
    } catch (e) {
      expect((e as ApiError).reason).toBe("NotFound");
    }
  });
});

describe("the cluster-wide Pod cap", () => {
  test(`a user's create past ${MAX_PODS} Pods is Forbidden; controllers record FailedCreate and retry`, () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web" }, spec: { replicas: MAX_PODS + 50, selector: { matchLabels: { app: "web" } }, template: { metadata: { labels: { app: "web" } }, spec: { containers: [{ name: "c", image: "nginx:1.27" }] } } } } as never);
    expect(() => c.advance(3_000)).not.toThrow();
    expect(c.list<Pod>("Pod").length).toBe(MAX_PODS);
    const failed = events(c, "FailedCreate");
    expect(failed.length).toBe(1);
    expect(failed[0].message).toMatch(/^Error creating: pods "web-[a-z0-9]+-" is forbidden: kubesim limits a cluster to 600 Pods so your browser stays responsive$/);
    expect(failed[0].count).toBeGreaterThan(1);
    expect(errorOf(() => c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "x" }, spec: { containers: [{ name: "c", image: "nginx" }] } } as never))).toBe(
      'Error from server (Forbidden): pods "x" is forbidden: kubesim limits a cluster to 600 Pods so your browser stays responsive',
    );
    // Room again: the ReplicaSet fills it on a later sync.
    const d = c.get<Deployment>("Deployment", "default", "web");
    c.replace({ ...d, spec: { ...d.spec!, replicas: MAX_PODS - 10 } });
    c.advance(1_000);
    expect(c.list<Pod>("Pod").filter((p) => !p.metadata.deletionTimestamp).length).toBe(MAX_PODS - 10);
  });
});
