// Shareable links and the simulation loop's resilience: a bad link or an
// engine error must never take the page down.
import { describe, expect, test } from "bun:test";
import { Cluster } from "@/lib/engine";
import { decodeCluster, encodeCluster } from "./share";
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
