// The traffic control's load model (lib/engine/controllers/load.ts), on the shop: throttled at its CPU
// limits under load, fixed by scaling out or an HPA, and quiet again when the traffic stops.

import { expect, test } from "bun:test";
import { Cluster, type Pod } from "@/lib/engine";
import { fairShares } from "@/lib/engine/controllers/load";
import { joinNode } from "./actions";
import { decodeCluster, encodeCluster } from "./share";
import { shopYaml } from "./incidents";
import { SimStore } from "./useSimulation";

function shop() {
  const s = new SimStore();
  s.cluster = new Cluster({ seed: 11, systemPods: true });
  s.apply(shopYaml(), "shop.yaml");
  s.cluster.advance(60_000);
  return s;
}
const errRate = (c: Cluster) => 1 - c.state.loadStats!.ok / c.state.loadStats!.offered;

test("the shop is throttled at its CPU limits on launch day, and kubectl top shows it", () => {
  const s = shop();
  const c = s.cluster!;
  c.state.load = { target: "default/shop-web", rps: 1000 };
  c.advance(20_000);
  expect(errRate(c)).toBeGreaterThan(0.5);
  expect(c.state.loadStats!.p95).toBeGreaterThanOrEqual(1000);
  expect(c.state.loadStats!.bottleneck?.why).toBe("cpu-limit");
  const top = s.exec("kubectl top pods");
  expect(top).toBeTruthy();
  expect(s.term.at(-1)?.out ?? "").toMatch(/shop-web-\S+\s+250m/);
});

test("a quiet day is served in full, fast", () => {
  const c = shop().cluster!;
  c.state.load = { target: "default/shop-web", rps: 10 };
  c.advance(10_000);
  expect(errRate(c)).toBeLessThan(0.001);
  expect(c.state.loadStats!.p95).toBeLessThan(300);
});

test("scaling out carries 1,000 req/s", () => {
  const s = shop();
  const c = s.cluster!;
  c.state.load = { target: "default/shop-web", rps: 1000 };
  s.exec("kubectl scale deployment shop-web --replicas=14");
  s.exec("kubectl scale deployment shop-api --replicas=14");
  c.advance(60_000);
  expect(errRate(c)).toBeLessThan(0.01);
});

test("an HPA on each tier scales the shop out to meet the load", () => {
  const s = shop();
  const c = s.cluster!;
  c.state.load = { target: "default/shop-web", rps: 1000 };
  s.exec("kubectl autoscale deployment shop-web --cpu=70% --min=3 --max=30");
  s.exec("kubectl autoscale deployment shop-api --cpu=70% --min=2 --max=30");
  c.advance(180_000);
  expect(errRate(c)).toBeLessThan(0.01);
  const web = c.list<Pod>("Pod", "default").filter((p) => p.metadata.name.startsWith("shop-web-") && p.status?.phase === "Running");
  expect(web.length).toBeGreaterThan(10);
});

test("a dependency with no ready Pods is named as the reason, ahead of throttling", () => {
  const s = shop();
  const c = s.cluster!;
  s.exec("kubectl scale deployment shop-api --replicas=0");
  c.state.load = { target: "default/shop-web", rps: 500 };
  c.advance(10_000);
  expect(c.state.loadStats!.ok).toBe(0);
  expect(c.state.loadStats!.bottleneck).toEqual({ name: "shop-api", why: "no-endpoints" });
});

test("switching the traffic off stops the CPU it was burning", () => {
  const s = shop();
  const c = s.cluster!;
  c.state.load = { target: "default/shop-web", rps: 1000 };
  c.advance(20_000);
  delete c.state.load;
  c.advance(20_000);
  expect(c.state.loadStats).toBeUndefined();
  s.exec("kubectl top pods");
  expect(s.term.at(-1)?.out ?? "").not.toMatch(/shop-web-\S+\s+250m/);
});

test("a share link keeps where cards were moved and the traffic setting", async () => {
  const c = shop().cluster!;
  c.state.layout = { "Deployment/default/shop-web": { x: -400, y: 20 } };
  c.state.load = { target: "default/shop-web", rps: 200 };
  c.advance(2000);
  const back = await decodeCluster(await encodeCluster(c.snapshot()));
  expect(back.layout).toEqual({ "Deployment/default/shop-web": { x: -400, y: 20 } });
  expect(back.load).toEqual({ target: "default/shop-web", rps: 200 });
  expect(back.loadStats).toBeUndefined();
});

test("a busy Node's CPU is shared by weight, and what one container can't use goes to the others", () => {
  // Three containers on 1,000m: two capped at 250m by their limits, one uncapped wanting 900m.
  const got = fairShares([{ want: 250, weight: 200 }, { want: 250, weight: 200 }, { want: 900, weight: 100 }], 1000);
  expect(got.map(Math.round)).toEqual([250, 250, 500]);
  // Everyone wants more than there is: pure weights.
  expect(fairShares([{ want: 1000, weight: 1 }, { want: 1000, weight: 3 }], 400).map(Math.round)).toEqual([100, 300]);
});

test("Viral (2,000 req/s) is solvable: a bigger database request, HPAs and two more Nodes", () => {
  const s = shop();
  const c = s.cluster!;
  joinNode(c);
  joinNode(c);
  c.advance(5000);
  s.exec("kubectl set resources statefulset shop-db --requests=cpu=2");
  c.advance(60_000);
  c.state.load = { target: "default/shop-web", rps: 2000 };
  s.exec("kubectl autoscale deployment shop-web --cpu=70% --min=3 --max=40");
  s.exec("kubectl autoscale deployment shop-api --cpu=70% --min=2 --max=40");
  c.advance(180_000);
  expect(errRate(c)).toBeLessThan(0.01);
});

test("a database with no Pods at all is named, though its headless Service no longer resolves", () => {
  const s = shop();
  const c = s.cluster!;
  s.exec("kubectl scale statefulset shop-db --replicas=0");
  c.state.load = { target: "default/shop-web", rps: 100 };
  c.advance(20_000);
  expect(c.state.loadStats!.ok).toBe(0);
  expect(c.state.loadStats!.bottleneck).toEqual({ name: "shop-db", why: "no-endpoints" });
});
