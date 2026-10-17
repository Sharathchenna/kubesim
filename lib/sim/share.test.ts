// Shareable links and the simulation loop's resilience: a bad link or an
// engine error must never take the page down.
import { describe, expect, test } from "bun:test";
import { Cluster } from "@/lib/engine";
import { decodeCluster, encodeCluster, tokenFromHash } from "./share";
import { SimStore } from "./useSimulation";

async function deflate(text: string): Promise<string> {
  const res = new Response(new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream("deflate-raw")));
  const bytes = new Uint8Array(await res.arrayBuffer());
  return "1." + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("share links", () => {
  test("round trip", async () => {
    const c = new Cluster({ seed: 1 });
    c.create({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "cfg" }, data: { greeting: "héllo ✓" } } as never);
    const back = await decodeCluster(await encodeCluster(c.snapshot()));
    expect(new Cluster(back).raw("ConfigMap", "default", "cfg")?.data).toEqual({ greeting: "héllo ✓" });
  });

  test("damaged, foreign and oversized links are refused with a message", async () => {
    await expect(decodeCluster("2.abc")).rejects.toThrow("different version");
    await expect(decodeCluster("1.not-deflate")).rejects.toThrow("damaged");
    await expect(decodeCluster(await deflate(JSON.stringify({ objects: {}, config: {} })))).rejects.toThrow("doesn't contain a cluster");
    await expect(decodeCluster(await deflate(" ".repeat(40 * 1024 * 1024)))).rejects.toThrow("too large");
  });
});

describe("simulation loop", () => {
  test("an engine error pauses the simulation and reports it instead of freezing", () => {
    const frames: FrameRequestCallback[] = [];
    Object.assign(globalThis, { requestAnimationFrame: (f: FrameRequestCallback) => frames.push(f), cancelAnimationFrame: () => {} });
    const sim = new SimStore({ systemPods: false });
    sim.start();
    const quiet = console.error;
    console.error = () => {};
    sim.cluster!.tick = () => {
      throw new Error("boom");
    };
    frames.shift()!(performance.now() + 16);
    console.error = quiet;
    expect(sim.crashed).toBe("boom");
    expect(sim.paused).toBe(true);
    // The loop keeps running, and Start over recovers.
    expect(frames.length).toBe(1);
    sim.reset();
    expect(sim.crashed).toBeUndefined();
    frames.shift()!(performance.now() + 32);
    expect(sim.crashed).toBeUndefined();
  });

  test("loading a snapshot that can't run is refused and keeps the current cluster", () => {
    Object.assign(globalThis, { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });
    const sim = new SimStore({ systemPods: false });
    sim.start();
    const before = sim.cluster;
    const bad = { ...sim.snapshot()!, objects: null } as never;
    expect(() => sim.load(bad)).toThrow("doesn't run in this version");
    expect(sim.cluster).toBe(before);
  });
});

describe("untrusted links", () => {
  const snap = () => {
    const c = new Cluster({ seed: 1, systemPods: false });
    return JSON.parse(JSON.stringify(c.snapshot()));
  };
  test("prototype keys are refused", async () => {
    const s = snap();
    const text = JSON.stringify(s).replace('"objects":{', '"objects":{"__proto__":{"kind":"X","metadata":{"name":"y"}},');
    await expect(decodeCluster(await deflate(text))).rejects.toThrow("doesn't contain a cluster");
    const t2 = JSON.stringify(s).replace('"config":{', '"config":{"constructor":{"prototype":{"polluted":1}},');
    await expect(decodeCluster(await deflate(t2))).rejects.toThrow("doesn't contain a cluster");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  test("objects must sit under their own key and have a name", async () => {
    const s = snap();
    s.objects["ConfigMap/default/a"] = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "b", namespace: "default", uid: "u" } };
    await expect(decodeCluster(await deflate(JSON.stringify(s)))).rejects.toThrow("doesn't contain a cluster");
    const s2 = snap();
    s2.objects["ConfigMap/default/"] = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "", namespace: "default" } };
    await expect(decodeCluster(await deflate(JSON.stringify(s2)))).rejects.toThrow("doesn't contain a cluster");
  });
  test("too many Pods is refused as too large", async () => {
    const s = snap();
    for (let i = 0; i < 700; i++) s.pods[`p${i}`] = { containers: {}, sandboxAt: 0 };
    await expect(decodeCluster(await deflate(JSON.stringify(s)))).rejects.toThrow("too large");
  });
  test("malformed percent-encoding in the hash doesn't throw", () => {
    expect(tokenFromHash("#cluster=%E0%A4%A")).toBe("");
    expect(tokenFromHash("#other=1")).toBeUndefined();
    expect(tokenFromHash("#cluster=1.abc")).toBe("1.abc");
  });
});

describe("shared clusters and the Learner's own save", () => {
  function memoryStorage() {
    const m = new Map<string, string>();
    Object.assign(globalThis, {
      localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), key: () => null, length: 0, clear: () => m.clear() },
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => {},
    });
    return m;
  }
  test("loading a link keeps a backup of the saved cluster, and restoring brings it back", () => {
    const m = memoryStorage();
    const mine = new SimStore({ persistKey: "k", systemPods: false });
    mine.start();
    mine.exec("kubectl create deployment mine --image=nginx");
    mine.persist(true);
    const other = new Cluster({ seed: 2, systemPods: false });
    other.create({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "theirs" }, data: {} } as never);
    mine.load(other.snapshot());
    expect(mine.cluster!.raw("ConfigMap", "default", "theirs")).toBeTruthy();
    // Not saved over the Learner's cluster yet: it's on probation.
    mine.persist(true);
    expect(m.get("k")).toContain('"mine"');
    expect(mine.hasBackup()).toBe(true);
    expect(mine.restoreBackup()).toBe(true);
    expect(mine.cluster!.raw("Deployment", "default", "mine")).toBeTruthy();
    expect(mine.hasBackup()).toBe(false);
    mine.stop();
  });
});
