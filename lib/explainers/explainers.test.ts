// Plays every Explainer's beats on a headless SimStore and checks that the
// scenarios actually do what their captions say.
import { describe, expect, test } from "bun:test";
import type { Deployment, Pod } from "@/lib/engine";
import { SimStore } from "@/lib/sim/useSimulation";
import { EXPLAINERS, type Explainer } from "./explainers";

function play(ex: Explainer, until?: number) {
  const sim = new SimStore({ setup: (c) => ex.setup(c, ex.param?.default ?? 0), warmupMs: ex.warmupMs, seed: 7 });
  (sim as unknown as { boot(): void }).boot();
  const c = sim.cluster!;
  const start = c.now;
  const beats = ex.beats(ex.param?.default ?? 0);
  const end = until ?? beats[beats.length - 1].at + 6000;
  const at = (ms: number) => c.advance(start + ms - c.now);
  const hooks: Record<number, () => void> = {};
  for (const b of beats) {
    if (b.at > end) break;
    at(b.at);
    b.run?.(sim);
    hooks[b.at]?.();
  }
  at(end);
  return sim;
}

const termOut = (sim: SimStore) => sim.term.map((t) => `${t.cmd ?? ""}\n${t.out}`).join("\n");

describe("explainers play as captioned", () => {
  for (const ex of EXPLAINERS) {
    test(`${ex.id} runs without errors`, () => {
      const sim = play(ex);
      const failed = sim.term.filter((t) => !t.ok && !/^kubectl run \S+ --rm/.test(t.cmd ?? ""));
      expect(failed.map((t) => `${t.cmd}: ${t.out}`)).toEqual([]);
    });
  }

  test("readiness-vs-liveness: one Pod leaves the Service, the liveness Pod restarts", () => {
    const ex = EXPLAINERS.find((e) => e.id === "readiness-vs-liveness")!;
    const mid = play(ex, 12_000);
    const web = mid.cluster!.list<Pod>("Pod", "default").filter((p) => p.metadata.labels?.app === "web");
    expect(web.filter((p) => p.status?.conditions?.some((q) => q.type === "Ready" && q.status === "False")).length).toBe(1);
    expect(web.every((p) => (p.status?.containerStatuses?.[0].restartCount ?? 0) === 0)).toBe(true);
    const end = play(ex);
    const live = end.cluster!.get<Pod>("Pod", "default", "liveness-http");
    expect(live.status?.containerStatuses?.[0].restartCount).toBeGreaterThanOrEqual(1);
    expect(end.cluster!.list<Pod>("Pod", "default").filter((p) => p.metadata.labels?.app === "web" && p.status?.conditions?.some((q) => q.type === "Ready" && q.status === "True")).length).toBe(3);
  });

  test("autoscaling: scales up under load and back to 1 by the end", () => {
    const ex = EXPLAINERS.find((e) => e.id === "autoscaling")!;
    const up = play(ex, 150_000);
    expect(up.cluster!.get<Deployment>("Deployment", "default", "php-apache").spec!.replicas).toBeGreaterThanOrEqual(4);
    const held = play(ex, 240_000);
    expect(held.cluster!.get<Deployment>("Deployment", "default", "php-apache").spec!.replicas).toBeGreaterThanOrEqual(4);
    const end = play(ex);
    expect(end.cluster!.get<Deployment>("Deployment", "default", "php-apache").spec!.replicas).toBe(1);
  });

  test("statefulset-ordering: web-0 comes back with its data", () => {
    const sim = play(EXPLAINERS.find((e) => e.id === "statefulset-ordering")!);
    expect(sim.cluster!.list<Pod>("Pod", "default").map((p) => p.metadata.name).sort()).toEqual(["web-0", "web-1"]);
    expect(termOut(sim)).toContain("I am web-0");
  });

  test("ingress-routing: apple, banana, 404 and 503", () => {
    const out = termOut(play(EXPLAINERS.find((e) => e.id === "ingress-routing")!));
    for (const s of ["\napple", "\nbanana", "404 Not Found", "503 Service Temporarily Unavailable"]) expect(out).toContain(s);
  });

  test("network-policy: after the allow rule only frontend gets through", () => {
    const ex = EXPLAINERS.find((e) => e.id === "network-policy")!;
    const sim = play(ex, 20_000);
    const c = sim.cluster!;
    const uid = (n: string) => c.get<Pod>("Pod", "default", n).metadata.uid;
    const seen: Record<string, { ok: number; blocked: number }> = {};
    c.subscribe((s) => {
      if (s.type !== "traffic" || !s.fromUid) return;
      const r = (seen[s.fromUid] ??= { ok: 0, blocked: 0 });
      if (s.blocked) r.blocked++;
      else if (s.ok) r.ok++;
    });
    c.advance(10_000);
    expect(seen[uid("frontend")].ok).toBeGreaterThan(0);
    expect(seen[uid("frontend")].blocked).toBe(0);
    expect(seen[uid("other")].blocked).toBeGreaterThan(0);
    expect(seen[uid("other")].ok ?? 0).toBe(0);
  });
});
