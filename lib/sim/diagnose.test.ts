// "What's wrong" in the Inspector: each finding names the problem a Learner would hit, and its fix,
// run as written, actually fixes it.

import { expect, test } from "bun:test";
import { Cluster, type Pod } from "@/lib/engine";
import { chaosKill, joinNode } from "./actions";
import { diagnose, type Finding, type Fix } from "./diagnose";
import { shopYaml } from "./incidents";
import type { ObjectKind } from "./objects";
import { SimStore } from "./useSimulation";

function sandbox() {
  const s = new SimStore();
  s.cluster = new Cluster({ seed: 7 });
  return s;
}
const titles = (fs: Finding[]) => fs.map((f) => f.title);
const find = (s: SimStore, kind: ObjectKind, name: string, title: string) => {
  const all = diagnose(s.cluster!, kind, kind === "node" ? undefined : "default", name);
  const f = all.find((x) => x.title === title);
  expect(f, `${kind} ${name}: wanted "${title}", got ${JSON.stringify(titles(all))}`).toBeDefined();
  return f!;
};
function apply(s: SimStore, fix: Fix) {
  if ("cmd" in fix) {
    const r = s.exec(fix.cmd);
    expect(r?.ok, `${fix.cmd}\n${r?.out}`).toBe(true);
  } else expect(s.run(fix.run)?.ok).toBe(true);
}
const ready = (c: Cluster, prefix: string) => c.list<Pod>("Pod", "default").filter((p) => p.metadata.name.startsWith(prefix) && p.status?.conditions?.some((x) => x.type === "Ready" && x.status === "True")).length;

test("a healthy Deployment has nothing wrong", () => {
  const s = sandbox();
  s.exec("kubectl create deployment web --image=nginx --replicas=2");
  s.cluster!.advance(30_000);
  expect(diagnose(s.cluster!, "deployment", "default", "web")).toEqual([]);
});

test("a bad image is one finding for all the Pods, and rolling back fixes it", () => {
  const s = sandbox();
  const c = s.cluster!;
  s.exec("kubectl create deployment web --image=nginx:1.27 --replicas=3");
  c.advance(30_000);
  s.exec("kubectl set image deployment/web nginx=nginx:does-not-exist");
  c.advance(30_000);
  const f = find(s, "deployment", "web", "Can't pull its image");
  expect(f.level).toBe("bad");
  expect(f.see?.kind).toBe("pod");
  expect(diagnose(c, "deployment", "default", "web").filter((x) => x.title === "Can't pull its image")).toHaveLength(1);
  apply(s, f.fixes![0]);
  c.advance(60_000);
  expect(diagnose(c, "deployment", "default", "web")).toEqual([]);
});

test("a crashing Pod says how it exits and points at its logs", () => {
  const s = sandbox();
  s.exec(`kubectl run crashy --image=busybox -- sh -c "echo starting; sleep 3; exit 1"`);
  s.cluster!.advance(60_000);
  const f = find(s, "pod", "crashy", "Keeps crashing");
  expect(f.detail).toMatch(/code 1/);
  expect(f.fixes?.some((x) => "cmd" in x && x.cmd === "kubectl logs crashy -c crashy --previous")).toBe(true);
});

test("a missing ConfigMap is named, and creating it with the keys the Pod reads lets it start", () => {
  const s = sandbox();
  const c = s.cluster!;
  s.apply(
    `apiVersion: apps/v1
kind: Deployment
metadata: {name: api}
spec:
  selector: {matchLabels: {app: api}}
  template:
    metadata: {labels: {app: api}}
    spec:
      containers:
      - name: api
        image: nginx
        env:
        - name: MODE
          valueFrom: {configMapKeyRef: {name: api-config, key: mode}}
`,
    "api.yaml",
  );
  c.advance(30_000);
  const f = find(s, "deployment", "api", "Missing configuration");
  expect(f.detail).toMatch(/ConfigMap api-config/);
  expect(f.fixes![0]).toEqual({ label: "Create ConfigMap api-config", cmd: "kubectl create configmap api-config --from-literal=mode=changeme" });
  apply(s, f.fixes![0]);
  c.advance(30_000);
  expect(ready(c, "api-")).toBe(1);
});

test("a Service whose selector matches nothing is pointed back at its Deployment", () => {
  const s = sandbox();
  const c = s.cluster!;
  s.exec("kubectl create deployment web --image=nginx --replicas=2");
  s.exec("kubectl expose deployment web --port=80");
  s.exec(`kubectl patch service web -p '{"spec":{"selector":{"app":"wbe"}}}'`);
  c.advance(10_000);
  const f = find(s, "service", "web", "It selects no Pods");
  apply(s, f.fixes![0]);
  c.advance(5_000);
  expect(diagnose(c, "service", "default", "web")).toEqual([]);
});

test("a wrong targetPort is caught against the ports the Pods declare", () => {
  const s = sandbox();
  const c = s.cluster!;
  s.exec("kubectl create deployment web --image=nginx --port=80");
  s.exec("kubectl expose deployment web --port=80 --target-port=8080");
  c.advance(20_000);
  const f = find(s, "service", "web", "Wrong targetPort");
  apply(s, f.fixes![0]);
  c.advance(5_000);
  expect(titles(diagnose(c, "service", "default", "web"))).not.toContain("Wrong targetPort");
});

test("a Pod too big for any Node waits Pending, and adding Nodes makes room", () => {
  const s = sandbox();
  const c = s.cluster!;
  s.exec("kubectl create deployment big --image=nginx --replicas=3");
  s.exec("kubectl set resources deployment big --requests=cpu=3");
  c.advance(30_000);
  const f = find(s, "deployment", "big", "No Node will take it");
  expect(f.detail).toMatch(/enough free cpu/);
  const add = f.fixes!.find((x) => x.label === "Add a Node")!;
  apply(s, add);
  apply(s, add);
  c.advance(60_000);
  expect(titles(diagnose(c, "deployment", "default", "big"))).not.toContain("No Node will take it");
});

test("a failed Node is recovered, a cordoned one uncordoned", () => {
  const s = sandbox();
  const c = s.cluster!;
  s.exec("kubectl cordon worker-1");
  apply(s, find(s, "node", "worker-1", "Cordoned").fixes![0]);
  expect(titles(diagnose(c, "node", undefined, "worker-1"))).not.toContain("Cordoned");
  s.run((cl) => chaosKill(cl, "worker-2"));
  apply(s, find(s, "node", "worker-2", "Not responding").fixes![0]);
  expect(titles(diagnose(c, "node", undefined, "worker-2"))).not.toContain("Not responding");
});

test("an empty new worker says Pods don't move, and a rollout restart spreads them onto it", () => {
  const s = sandbox();
  const c = s.cluster!;
  s.exec("kubectl create deployment web --image=nginx --replicas=6");
  c.advance(30_000);
  s.run(joinNode);
  c.advance(20_000);
  const fresh = c.list("Node").at(-1)!.metadata.name;
  const f = find(s, "node", fresh, "Nothing runs here yet");
  expect(f.level).toBe("info");
  apply(s, f.fixes![0]);
  c.advance(60_000);
  expect(c.list<Pod>("Pod", "default").some((p) => p.spec?.nodeName === fresh)).toBe(true);
  expect(titles(diagnose(c, "node", undefined, fresh))).not.toContain("Nothing runs here yet");
});

test("under launch-day traffic the shop's bottleneck is named, from the workload and from its Pods", () => {
  const s = new SimStore();
  s.cluster = new Cluster({ seed: 11, systemPods: true });
  const c = s.cluster;
  s.apply(shopYaml(), "shop.yaml");
  c.advance(60_000);
  c.state.load = { target: "default/shop-web", rps: 1000 };
  c.advance(20_000);
  const name = c.state.loadStats!.bottleneck!.name;
  const f = find(s, "deployment", name, "It's what's slowing the traffic");
  expect(f.fixes!.map((x) => x.label)).toEqual([expect.stringMatching(/^Scale to \d+$/), "Let an HPA scale it"]);
  const pod = c.list<Pod>("Pod", "default").find((p) => p.metadata.name.startsWith(`${name}-`))!;
  expect(titles(diagnose(c, "pod", "default", pod.metadata.name))).toContain("At its CPU limit");
  s.exec("kubectl autoscale deployment shop-web --cpu=70% --min=3 --max=30");
  s.exec("kubectl autoscale deployment shop-api --cpu=70% --min=2 --max=30");
  c.advance(180_000);
  expect(titles(diagnose(c, "deployment", "default", "shop-web"))).not.toContain("It's what's slowing the traffic");
  expect(titles(diagnose(c, "deployment", "default", "shop-api"))).not.toContain("It's what's slowing the traffic");
});

test("an HPA on Pods with no CPU request says so, and requesting CPU lets it measure", () => {
  const s = sandbox();
  const c = s.cluster!;
  s.exec("kubectl create deployment web --image=nginx");
  s.exec("kubectl autoscale deployment web --cpu=50% --min=1 --max=4");
  c.advance(60_000);
  apply(s, find(s, "hpa", "web", "No CPU requests to measure against").fixes![0]);
  c.advance(90_000);
  expect(titles(diagnose(c, "hpa", "default", "web"))).not.toContain("No CPU requests to measure against");
});
