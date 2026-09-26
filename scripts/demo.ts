// Terminal demo of the Simulated Cluster: `bun scripts/demo.ts` (add --fast to skip pauses).
// Streams cluster Events as they happen and prints pod tables at each stage.

import { Cluster, killNode, request, type Deployment, type KubeEvent, type Pod } from "../lib/engine";

const FAST = process.argv.includes("--fast");
const c = new Cluster();
const t = () => `[t+${(c.now / 1000).toFixed(1).padStart(6)}s]`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, FAST ? 0 : ms));

c.subscribe((s) => {
  if (s.type !== "event") return;
  const e: KubeEvent = s.event;
  if (e.metadata.namespace === "kube-system" || e.count > 1) return;
  const color = e.type === "Warning" ? "\x1b[33m" : "\x1b[36m";
  console.log(`${dim(t())} ${color}${e.reason.padEnd(18)}\x1b[0m ${e.involvedObject.kind.toLowerCase()}/${e.involvedObject.name}: ${e.message}`);
});

function podTable() {
  const rows = c.list<Pod>("Pod", "default").map((p) => {
    const cs = p.status?.containerStatuses ?? [];
    const st = p.metadata.deletionTimestamp ? "Terminating" : (cs[0]?.state.waiting?.reason ?? cs[0]?.state.terminated?.reason ?? p.status?.phase ?? "Pending");
    return [p.metadata.name, `${cs.filter((x) => x.ready).length}/${p.spec!.containers.length}`, st, String(cs[0]?.restartCount ?? 0), p.spec?.nodeName ?? "<none>"];
  });
  const all = [["NAME", "READY", "STATUS", "RESTARTS", "NODE"], ...rows];
  const w = all[0].map((_, i) => Math.max(...all.map((r) => r[i].length)) + 3);
  console.log(all.map((r) => "  " + r.map((x, i) => x.padEnd(w[i])).join("")).join("\n"));
}

/** Runs sim time in small slices so events stream out gradually. */
async function run(simMs: number, speed = 10) {
  for (let done = 0; done < simMs; done += 500) {
    c.tick(500);
    await sleep(500 / speed);
  }
}

async function stage(title: string, cmd: string, fn: () => void, simMs: number, speed?: number) {
  console.log(`\n${bold("━━ " + title)}\n${bold("$")} ${cmd}`);
  fn();
  await run(simMs, speed);
  console.log(dim("\n$ kubectl get pods -o wide"));
  podTable();
  await sleep(1200);
}

const deploy = (image: string) => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web" },
  spec: { replicas: 3, selector: { matchLabels: { app: "web" } }, template: { metadata: { labels: { app: "web" } }, spec: { containers: [{ name: "web", image }] } } },
});

console.log(bold("Simulated cluster booted:"), c.list("Node").map((n) => n.metadata.name).join(", "));

await stage("1. Create a Deployment", "kubectl create deployment web --image=nginxdemos/hello:plain-text --replicas=3", () => c.create(deploy("nginxdemos/hello:plain-text")), 8000);

await stage("2. Expose it and send traffic", "kubectl expose deployment web --port=80 && curl http://web (x6)", () => {
  c.create({ apiVersion: "v1", kind: "Service", metadata: { name: "web" }, spec: { selector: { app: "web" }, ports: [{ port: 80 }] } });
  c.advance(200);
  for (let i = 0; i < 6; i++) console.log(`  curl web -> answered by ${request(c, "http://web").podName}`);
}, 1000);

await stage("3. Self-healing: delete a Pod", "kubectl delete pod <first>", () => {
  c.delete("Pod", "default", c.list<Pod>("Pod", "default")[0].metadata.name);
}, 6000);

await stage("4. Rolling update", "kubectl set image deployment/web web=nginx:1.27", () => {
  const d = c.get<Deployment>("Deployment", "default", "web");
  c.replace({ ...d, spec: { ...d.spec!, template: { ...d.spec!.template, spec: { containers: [{ name: "web", image: "nginx:1.27" }] } } } });
}, 20000);

await stage("5. Chaos: worker-2 loses power (sim runs at 60x)", "chaos kill-node worker-2", () => killNode(c, "worker-2"), 380_000, 600);

console.log(`\n${bold("Done.")} Replacement Pods now run on worker-1; the old ones stay Terminating until worker-2 returns.`);
