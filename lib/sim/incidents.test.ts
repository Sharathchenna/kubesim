import { expect, test } from "bun:test";
import { Cluster, type Pod } from "@/lib/engine";
import * as A from "./actions";
import { INCIDENTS, dailyIncident, shopProblem, shopTraffic, shopYaml, type Incident } from "./incidents";
import { SimStore } from "./useSimulation";

/** The healthy shop, as the Incident player builds it: seed 11, or 1000 + the day for the Daily Incident. */
function healthyShop(seed = 11) {
  const s = new SimStore();
  s.cluster = new Cluster({ seed, systemPods: true });
  s.apply(shopYaml(), "shop.yaml");
  s.cluster.advance(60_000);
  return s;
}

/** Advances in steps until the shop is healthy (or the time runs out); returns how long it took. */
function untilHealthy(c: Cluster, maxMs: number): number | null {
  for (let t = 0; t <= maxMs; t += 1000) {
    if (shopProblem(c) === null) return t;
    c.advance(1000);
  }
  return null;
}

/** Breaks the shop and checks that customers notice: requests fail, or none get through. */
function broken(inc: Incident, seed?: number) {
  const s = healthyShop(seed);
  const c = s.cluster!;
  expect(shopProblem(c)).toBeNull();
  inc.break(c);
  c.advance(60_000);
  expect(shopProblem(c)).not.toBeNull();
  const t = shopTraffic(c);
  expect(t.rps === 0 || t.err > 0.5).toBe(true);
  return s;
}

const blocks = (inc: Incident, lang: string) => [...inc.fix.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)\\n```", "g"))].map((m) => m[1]);

for (const inc of INCIDENTS) {
  for (const seed of [11, 1001]) {
    test(`incident ${inc.slug} (seed ${seed}): breaks the shop, and its fix resolves it`, () => {
      const s = broken(inc, seed);
      const c = s.cluster!;
      if (inc.slug === "node-down") {
        const node = c.get<Pod>("Pod", "default", "shop-db-0").spec!.nodeName!;
        s.run((cl) => A.chaosRecover(cl, node));
      } else {
        const cmds = blocks(inc, "bash").flatMap((b) => b.split("\n"));
        expect(cmds.length).toBeGreaterThan(0);
        for (const cmd of cmds) expect([cmd, s.exec(cmd)?.ok]).toEqual([cmd, true]);
      }
      expect(untilHealthy(c, 180_000)).not.toBeNull();
    });
  }
  // The "or, better" manifests in a fix work on their own, too.
  for (const yaml of blocks(inc, "yaml")) {
    test(`incident ${inc.slug}: the manifest in its fix resolves it`, () => {
      const s = broken(inc);
      expect(s.apply(yaml, "fix.yaml")?.ok).toBe(true);
      expect(untilHealthy(s.cluster!, 180_000)).not.toBeNull();
    });
  }
}

test("every incident has its own slug and a full write-up", () => {
  expect(new Set(INCIDENTS.map((i) => i.slug)).size).toBe(INCIDENTS.length);
  for (const i of INCIDENTS) for (const f of [i.title, i.page, i.brief, i.fix, i.debrief]) expect(f.length).toBeGreaterThan(0);
  for (const i of INCIDENTS) expect(i.hints.length).toBeGreaterThanOrEqual(3);
});

test("the Daily Incident is the same all day and changes the next day", () => {
  const day = Date.UTC(2026, 10, 3, 1);
  expect(dailyIncident(day).incident.slug).toBe(dailyIncident(day + 20 * 3600_000).incident.slug);
  expect(dailyIncident(day).incident.slug).not.toBe(dailyIncident(day + 86_400_000).incident.slug);
  expect(dailyIncident(Date.UTC(2026, 9, 30, 12)).n).toBe(1);
});

test("the Daily Incident goes through every incident before repeating", () => {
  const seen = new Set<string>();
  for (let d = 0; d < INCIDENTS.length; d++) seen.add(dailyIncident(Date.UTC(2026, 9, 30, 12) + d * 86_400_000).incident.slug);
  expect(seen.size).toBe(INCIDENTS.length);
});
