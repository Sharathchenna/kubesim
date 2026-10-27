import { expect, test } from "bun:test";
import { Cluster, request, type Pod, type StatefulSet } from "@/lib/engine";
import { BLUEPRINTS } from "./blueprints";
import { SimStore } from "./useSimulation";

/** Requests (or errors) a tier's Pods answered in the last `ms` of simulated time. */
const served = (c: Cluster, prefix: string, key: "reqs" | "errs", ms = 10_000) =>
  c
    .list<Pod>("Pod", "default")
    .filter((p) => p.metadata.name.startsWith(prefix))
    .reduce((n, p) => n + Object.values(c.state.pods[p.metadata.uid]?.containers ?? {}).reduce((m, ct) => m + (ct[key] ?? []).filter((t) => c.now - t <= ms).length, 0), 0);

function stack() {
  const s = new SimStore();
  s.cluster = new Cluster();
  const r = s.apply(BLUEPRINTS.find((b) => b.id === "stack")!.yaml("shop"), "shop.yaml")!;
  expect(r.ok).toBe(true);
  s.cluster.advance(60_000);
  return s.cluster;
}

test("a request to the web tier goes through the API to Postgres and Redis", () => {
  const c = stack();
  const r = request(c, "http://shop-web");
  expect(r.status).toBe(200);
  // The load generator has been at it for a while, so every tier is serving, and (once Postgres
  // finished starting) without errors.
  for (const tier of ["shop-web", "shop-api", "shop-db", "shop-cache"]) expect(served(c, tier, "reqs")).toBeGreaterThan(0);
  expect(served(c, "shop-web", "errs")).toBe(0);
});

test("when the database goes, the errors travel back up the chain", () => {
  const c = stack();
  const db = c.get<StatefulSet>("StatefulSet", "default", "shop-db");
  c.replace({ ...db, spec: { ...db.spec!, replicas: 0 } });
  c.advance(40_000);
  const r = request(c, "http://shop-web");
  expect(r.status).toBe(503);
  expect(r.body).toContain("shop-api");
  expect(served(c, "shop-web", "errs")).toBeGreaterThan(0);
  expect(served(c, "shop-api", "errs")).toBeGreaterThan(0);
  // Health checks don't call the database, so the app Pods stay in their Services.
  expect(c.list<Pod>("Pod", "default").filter((p) => p.metadata.name.startsWith("shop-api")).every((p) => p.status?.conditions?.some((q) => q.type === "Ready" && q.status === "True"))).toBe(true);
});
