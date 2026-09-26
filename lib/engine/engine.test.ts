import { describe, expect, test } from "bun:test";
import { Cluster, isPodReady, killNode, recoverNode, request, type Deployment, type Node, type Pod, type ReplicaSet, type KubeEvent } from "./index";

const deployment = (name: string, image: string, replicas = 3, extra: Partial<Deployment["spec"]> = {}) => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name },
  spec: {
    replicas,
    selector: { matchLabels: { app: name } },
    template: { metadata: { labels: { app: name } }, spec: { containers: [{ name, image }] } },
    ...extra,
  },
});

const setImage = (c: Cluster, d: Deployment, image: string) =>
  c.replace({ ...d, spec: { ...d.spec!, template: { ...d.spec!.template, spec: { containers: [{ name: "web", image }] } } } });

const pods = (c: Cluster, app: string) => c.list<Pod>("Pod", "default").filter((p) => p.metadata.labels?.app === app);
const running = (c: Cluster, app: string) => pods(c, app).filter((p) => p.status?.phase === "Running" && isPodReady(p) && !p.metadata.deletionTimestamp);

describe("bootstrap", () => {
  test("nodes ready and system pods running", () => {
    const c = new Cluster();
    const nodes = c.list<Node>("Node");
    expect(nodes.map((n) => n.metadata.name)).toEqual(["control-plane", "worker-1", "worker-2"]);
    for (const n of nodes) {
      expect(c.nodeReady(n)).toBe(true);
      expect(n.spec?.taints?.some((t) => t.key === "node.kubernetes.io/not-ready")).toBe(false);
    }
    const sys = c.list<Pod>("Pod", "kube-system");
    expect(sys.length).toBe(4 + 3 + 2);
    for (const p of sys) expect(p.status?.phase).toBe("Running");
  });

  test("is deterministic for a seed", () => {
    const a = new Cluster({ seed: 7 });
    const b = new Cluster({ seed: 7 });
    a.create(deployment("web", "nginx"));
    b.create(deployment("web", "nginx"));
    a.advance(10_000);
    b.advance(10_000);
    expect(pods(a, "web").map((p) => p.metadata.name)).toEqual(pods(b, "web").map((p) => p.metadata.name));
  });
});

describe("deployments", () => {
  test("creates pods that spread across workers and become ready", () => {
    const c = new Cluster({ systemPods: false });
    c.create(deployment("web", "nginx:1.27"));
    c.advance(10_000);
    const ps = running(c, "web");
    expect(ps.length).toBe(3);
    expect(ps[0].metadata.name).toMatch(/^web-[bcdfghjklmnpqrstvwxz2456789]+-[bcdfghjklmnpqrstvwxz2456789]{5}$/);
    const nodes = new Set(ps.map((p) => p.spec?.nodeName));
    expect(nodes.has("control-plane")).toBe(false);
    expect(nodes.size).toBe(2);
    const d = c.get<Deployment>("Deployment", "default", "web");
    expect(d.status?.availableReplicas).toBe(3);
    expect(d.status?.conditions?.find((x) => x.type === "Progressing")?.reason).toBe("NewReplicaSetAvailable");
  });

  test("self-heals when a pod is deleted", () => {
    const c = new Cluster({ systemPods: false });
    c.create(deployment("web", "nginx:1.27"));
    c.advance(10_000);
    const victim = running(c, "web")[0];
    c.delete("Pod", "default", victim.metadata.name);
    c.advance(100);
    expect(pods(c, "web").length).toBe(4); // replacement created while victim terminates
    c.advance(10_000);
    expect(running(c, "web").length).toBe(3);
    expect(pods(c, "web").some((p) => p.metadata.name === victim.metadata.name)).toBe(false);
  });

  test("rolling update follows surge 1 / unavailable 0", () => {
    const c = new Cluster({ systemPods: false });
    c.create(deployment("web", "nginx:1.26"));
    c.advance(10_000);
    const d = c.get<Deployment>("Deployment", "default", "web");
    setImage(c, d, "nginx:1.27");
    c.advance(30_000);
    const msgs = c.eventsFor(d).filter((e) => e.reason === "ScalingReplicaSet").map((e) => e.message.replace(/web-\w+/, "X"));
    const [oldRs, newRs] = c.list<ReplicaSet>("ReplicaSet", "default").sort((a, b) => a.metadata.creationTimestamp - b.metadata.creationTimestamp);
    const tail = c.eventsFor(d).filter((e) => e.reason === "ScalingReplicaSet").slice(1).map((e) => e.message);
    expect(tail).toEqual([
      `Scaled up replica set ${newRs.metadata.name} from 0 to 1`,
      `Scaled down replica set ${oldRs.metadata.name} from 3 to 2`,
      `Scaled up replica set ${newRs.metadata.name} from 1 to 2`,
      `Scaled down replica set ${oldRs.metadata.name} from 2 to 1`,
      `Scaled up replica set ${newRs.metadata.name} from 2 to 3`,
      `Scaled down replica set ${oldRs.metadata.name} from 1 to 0`,
    ]);
    expect(msgs.length).toBe(7);
    expect(running(c, "web").every((p) => p.spec?.containers[0].image === "nginx:1.27")).toBe(true);
    expect(c.get<Deployment>("Deployment", "default", "web").metadata.annotations?.["deployment.kubernetes.io/revision"]).toBe("2");
  });

  test("a broken image stalls the rollout and keeps old pods serving", () => {
    const c = new Cluster({ systemPods: false });
    c.create(deployment("web", "nginx:1.26"));
    c.advance(10_000);
    const d = c.get<Deployment>("Deployment", "default", "web");
    setImage(c, d, "nginx:doesnotexist");
    c.advance(60_000);
    const bad = pods(c, "web").filter((p) => p.spec?.containers[0].image === "nginx:doesnotexist");
    expect(bad.length).toBe(1);
    const reason = bad[0].status?.containerStatuses?.[0].state.waiting?.reason;
    expect(["ErrImagePull", "ImagePullBackOff"]).toContain(reason ?? "");
    expect(bad[0].status?.phase).toBe("Pending");
    expect(running(c, "web").length).toBe(3);
  });

  test("scale down removes pods", () => {
    const c = new Cluster({ systemPods: false });
    c.create(deployment("web", "nginx:1.27", 4));
    c.advance(10_000);
    const d = c.get<Deployment>("Deployment", "default", "web");
    c.replace({ ...d, spec: { ...d.spec!, replicas: 1 } });
    c.advance(5_000);
    expect(pods(c, "web").length).toBe(1);
  });
});

describe("pods", () => {
  test("crash loop back-off timing is 0, 10s, 20s", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "crashy" }, spec: { containers: [{ name: "c", image: "busybox:1.36", command: ["sh", "-c", "echo boom; exit 1"] }] } });
    c.advance(8_000);
    let p = c.get<Pod>("Pod", "default", "crashy");
    expect(p.status?.containerStatuses?.[0].restartCount).toBe(1);
    c.advance(10_000);
    p = c.get<Pod>("Pod", "default", "crashy");
    expect(p.status?.containerStatuses?.[0].state.waiting?.reason).toBe("CrashLoopBackOff");
    expect(p.status?.phase).toBe("Running");
    c.advance(40_000);
    p = c.get<Pod>("Pod", "default", "crashy");
    expect(p.status?.containerStatuses?.[0].restartCount).toBe(3);
    expect(c.logsFor(p, "c", true)?.map((l) => l.text)).toEqual(["boom"]);
  });

  test("completed pod with restartPolicy Never succeeds", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "once" }, spec: { restartPolicy: "Never", containers: [{ name: "c", image: "busybox", command: ["echo", "hi"] }] } });
    c.advance(10_000);
    const p = c.get<Pod>("Pod", "default", "once");
    expect(p.status?.phase).toBe("Succeeded");
    expect(c.logsFor(p, "c")?.map((l) => l.text)).toEqual(["hi"]);
  });

  test("unschedulable pod reports FailedScheduling", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "picky" }, spec: { nodeSelector: { disk: "ssd" }, containers: [{ name: "c", image: "nginx" }] } });
    c.advance(1_000);
    const p = c.get<Pod>("Pod", "default", "picky");
    expect(p.status?.phase).toBe("Pending");
    const ev = c.eventsFor(p).find((e) => e.reason === "FailedScheduling");
    expect(ev?.message).toStartWith("0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 node(s) didn't match Pod's node affinity/selector.");
  });

  test("validation errors read like the apiserver", () => {
    const c = new Cluster({ systemPods: false });
    expect(() => c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "Bad_Name" }, spec: { containers: [{ name: "c", image: "nginx" }] } })).toThrow(
      /^The Pod "Bad_Name" is invalid: metadata.name: Invalid value: "Bad_Name": a lowercase RFC 1123 subdomain/,
    );
    expect(() => c.create({ ...deployment("bad", "nginx"), spec: { ...deployment("bad", "nginx").spec, selector: { matchLabels: { app: "other" } } } })).toThrow(
      'The Deployment "bad" is invalid: spec.template.metadata.labels: Invalid value: {"app":"bad"}: `selector` does not match template `labels`',
    );
  });
});

describe("services and traffic", () => {
  test("ClusterIP and DNS load-balance to ready pods", () => {
    const c = new Cluster({ systemPods: false });
    c.create(deployment("hello", "nginxdemos/hello:plain-text"));
    c.create({ apiVersion: "v1", kind: "Service", metadata: { name: "hello" }, spec: { selector: { app: "hello" }, ports: [{ port: 80 }] } });
    c.advance(10_000);
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const r = request(c, "http://hello");
      expect(r.ok).toBe(true);
      seen.add(r.podName!);
    }
    expect(seen.size).toBe(3);
    expect(request(c, "hello.default.svc.cluster.local").ok).toBe(true);
    expect(request(c, "nope").error).toBe("curl: (6) Could not resolve host: nope");
  });

  test("NodePort reachable on every node IP", () => {
    const c = new Cluster({ systemPods: false });
    c.create(deployment("web", "nginx"));
    c.create({ apiVersion: "v1", kind: "Service", metadata: { name: "web" }, spec: { type: "NodePort", selector: { app: "web" }, ports: [{ port: 80, nodePort: 30080 }] } });
    c.advance(10_000);
    for (const ip of ["172.18.0.2", "172.18.0.3", "172.18.0.4"]) expect(request(c, `http://${ip}:30080`).body).toContain("Welcome to nginx!");
    expect(() => c.create({ apiVersion: "v1", kind: "Service", metadata: { name: "web2" }, spec: { type: "NodePort", selector: { app: "web" }, ports: [{ port: 80, nodePort: 30080 }] } })).toThrow(
      "spec.ports[0].nodePort: Invalid value: 30080: provided port is already allocated",
    );
  });

  test("no ready endpoints refuses the connection", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "v1", kind: "Service", metadata: { name: "empty" }, spec: { selector: { app: "none" }, ports: [{ port: 80 }] } });
    c.advance(1_000);
    expect(request(c, "empty").exitCode).toBe(7);
  });
});

describe("node failure", () => {
  test("NotReady after ~50s, eviction after 300s more, replacements elsewhere", () => {
    const c = new Cluster({ systemPods: false });
    c.create(deployment("web", "nginx", 4));
    c.advance(10_000);
    const onW2 = running(c, "web").filter((p) => p.spec?.nodeName === "worker-2");
    expect(onW2.length).toBe(2);
    killNode(c, "worker-2");
    c.advance(45_000);
    expect(c.nodeReady(c.get<Node>("Node", undefined, "worker-2"))).toBe(true);
    c.advance(10_000);
    const w2 = c.get<Node>("Node", undefined, "worker-2");
    expect(w2.status?.conditions.find((x) => x.type === "Ready")?.status).toBe("Unknown");
    expect(c.eventsFor(w2).some((e: KubeEvent) => e.reason === "NodeNotReady")).toBe(true);
    c.advance(300_000);
    const stuck = pods(c, "web").filter((p) => p.spec?.nodeName === "worker-2");
    expect(stuck.every((p) => p.metadata.deletionTimestamp !== undefined)).toBe(true);
    c.advance(15_000);
    expect(running(c, "web").filter((p) => p.spec?.nodeName === "worker-1").length).toBe(4);
    recoverNode(c, "worker-2");
    c.advance(5_000);
    expect(pods(c, "web").filter((p) => p.spec?.nodeName === "worker-2").length).toBe(0);
    expect(c.nodeReady(c.get<Node>("Node", undefined, "worker-2"))).toBe(true);
  });
});

describe("snapshots and namespaces", () => {
  test("snapshot restores an identical cluster", () => {
    const c = new Cluster({ systemPods: false });
    c.create(deployment("web", "nginx"));
    c.advance(5_000);
    const copy = new Cluster(c.snapshot());
    c.advance(5_000);
    copy.advance(5_000);
    expect(JSON.stringify(copy.snapshot())).toBe(JSON.stringify(c.snapshot()));
  });

  test("deleting a namespace removes its contents", () => {
    const c = new Cluster({ systemPods: false });
    c.create({ apiVersion: "v1", kind: "Namespace", metadata: { name: "team" } });
    c.create({ ...deployment("web", "nginx"), metadata: { name: "web", namespace: "team" } });
    c.advance(10_000);
    c.delete("Namespace", undefined, "team");
    c.advance(5_000);
    expect(c.raw("Namespace", undefined, "team")).toBeUndefined();
    expect(c.list<Pod>("Pod", "team").length).toBe(0);
  });
});
