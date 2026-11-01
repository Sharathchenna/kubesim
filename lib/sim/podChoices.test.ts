// "What should this Pod run?": choices drawn from the running sandbox, each one kubectl command
// that does what it says, and each breakage one the sidebar's "What's wrong" then explains.

import { expect, test } from "bun:test";
import { Cluster, type Pod } from "@/lib/engine";
import { joinNode } from "./actions";
import { diagnose } from "./diagnose";
import { shopYaml } from "./incidents";
import { podChoices } from "./podChoices";
import { SimStore } from "./useSimulation";

function shop() {
  const s = new SimStore();
  s.cluster = new Cluster({ seed: 11, systemPods: true });
  s.apply(shopYaml(), "shop.yaml");
  s.cluster.advance(60_000);
  return s;
}
const pick = (s: SimStore, id: string, node?: string) => {
  const ch = podChoices(s.cluster!, node).find((x) => x.id === id);
  expect(ch, id).toBeDefined();
  const r = s.exec(ch!.cmd);
  expect(r?.ok, `${ch!.cmd}\n${r?.out}`).toBe(true);
  return ch!;
};
const newest = (c: Cluster) => c.list<Pod>("Pod", "default").sort((a, b) => b.metadata.creationTimestamp - a.metadata.creationTimestamp)[0];

test("the choices come from what's running: a replica of each workload, tools aimed at its Services", () => {
  const s = shop();
  const ids = podChoices(s.cluster!).map((x) => x.id);
  expect(ids).toContain("scale:deployment/default/shop-web");
  expect(ids).toContain("scale:statefulset/default/shop-db");
  expect(ids).toContain("load:shop-web");
  expect(ids.slice(-6)).toEqual(["typo", "crash", "oom", "big", "config", "unready"]);
  // On an empty sandbox there's nothing to scale, and the tools still work.
  const empty = new SimStore();
  empty.cluster = new Cluster({ seed: 3 });
  expect(podChoices(empty.cluster).some((x) => x.group === "More of what's running")).toBe(false);
});

test("the traffic's bottleneck comes first", () => {
  const s = shop();
  s.cluster!.state.load = { target: "default/shop-web", rps: 1000 };
  s.cluster!.advance(20_000);
  const first = podChoices(s.cluster!)[0];
  expect(first.hint).toContain("the traffic's bottleneck");
});

test("another replica on a new, empty Node: the scheduler puts it there", () => {
  const s = shop();
  const c = s.cluster!;
  s.run(joinNode);
  c.advance(20_000);
  const fresh = c.list("Node").at(-1)!.metadata.name;
  const ch = pick(s, "scale:deployment/default/shop-web", fresh);
  expect(ch.note).toContain(`which is ${fresh}`);
  c.advance(30_000);
  expect(c.list<Pod>("Pod", "default").some((p) => p.metadata.name.startsWith("shop-web-") && p.spec?.nodeName === fresh)).toBe(true);
});

test("a shell pinned to a Node lands there and can reach the shop", () => {
  const s = shop();
  const c = s.cluster!;
  const ch = pick(s, "debug", "worker-2");
  c.advance(20_000);
  expect(c.get<Pod>("Pod", "default", "debug").spec?.nodeName).toBe("worker-2");
  const tryIt = ch.note.match(/Try (kubectl .+)\.$/)![1];
  expect(s.exec(tryIt)?.out).toContain("shop-web");
});

test("each breakage ends up in the state it promises, and the sidebar explains it", () => {
  const cases: [string, string][] = [
    ["typo", "Can't pull its image"],
    ["crash", "Keeps crashing"],
    ["oom", "Runs out of memory"],
    ["big", "No Node will take it"],
    ["config", "Missing configuration"],
    ["unready", "Not ready, so it gets no traffic"],
  ];
  for (const [id, title] of cases) {
    const s = shop();
    const c = s.cluster!;
    pick(s, id, "worker-1");
    c.advance(60_000);
    const p = newest(c);
    const found = diagnose(c, "pod", "default", p.metadata.name).map((f) => f.title);
    expect(found, `${id}: ${p.metadata.name}`).toContain(title);
    if (id !== "big") expect(p.spec?.nodeName).toBe("worker-1");
  }
});
