import { expect, test } from "bun:test";
import { Cluster, type Pod } from "@/lib/engine";
import * as A from "./actions";
import { INCIDENTS, dailyIncident, shopProblem, shopYaml } from "./incidents";
import { SimStore } from "./useSimulation";

function healthyShop() {
  const s = new SimStore();
  s.cluster = new Cluster();
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

for (const inc of INCIDENTS) {
  test(`incident ${inc.slug}: breaks the shop, and its fix resolves it`, () => {
    const s = healthyShop();
    const c = s.cluster!;
    expect(shopProblem(c)).toBeNull();
    inc.break(c);
    c.advance(60_000);
    expect(shopProblem(c)).not.toBeNull();
    if (inc.slug === "node-down") {
      const node = c.get<Pod>("Pod", "default", "shop-db-0").spec!.nodeName!;
      s.run((cl) => A.chaosRecover(cl, node));
    } else {
      const cmds = [...inc.fix.matchAll(/```bash\n([\s\S]*?)\n```/g)].flatMap((m) => m[1].split("\n"));
      expect(cmds.length).toBeGreaterThan(0);
      for (const cmd of cmds) expect([cmd, s.exec(cmd)?.ok]).toEqual([cmd, true]);
    }
    expect(untilHealthy(c, 180_000)).not.toBeNull();
  });
}

test("the Daily Incident is the same all day and changes the next day", () => {
  const day = Date.UTC(2026, 10, 3, 1);
  expect(dailyIncident(day).incident.slug).toBe(dailyIncident(day + 20 * 3600_000).incident.slug);
  expect(dailyIncident(day).incident.slug).not.toBe(dailyIncident(day + 86_400_000).incident.slug);
  expect(dailyIncident(Date.UTC(2026, 9, 30, 12)).n).toBe(1);
});
