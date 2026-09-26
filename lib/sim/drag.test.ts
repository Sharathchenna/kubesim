import { expect, test } from "bun:test";
import { Cluster, type Pod, type Service } from "@/lib/engine";
import { canDrop, parseTarget, performDrop } from "./drag";
import { SimStore } from "./useSimulation";

function store() {
  const s = new SimStore();
  s.cluster = new Cluster({ systemPods: false });
  return s;
}

test("targets parse and validate", () => {
  expect(parseTarget("node:worker-1")).toEqual({ type: "node", name: "worker-1" });
  expect(parseTarget("deployment:default/web")).toEqual({ type: "deployment", ns: "default", name: "web" });
  expect(canDrop({ kind: "palette", what: "service", label: "" }, parseTarget("canvas"))).toBe(false);
  expect(canDrop({ kind: "palette", what: "service", label: "" }, parseTarget("deployment:default/web"))).toBe(true);
  expect(canDrop({ kind: "object", type: "pod", ns: "default", name: "x", label: "" }, parseTarget("trash"))).toBe(true);
});

test("drag to build: deployment, service, pinned pod, delete", () => {
  const s = store();
  const c = s.cluster!;
  expect(performDrop(s, { kind: "palette", what: "deployment", image: "nginxdemos/hello:plain-text", label: "" }, { type: "canvas" }).ok).toBe(true);
  expect(c.raw("Deployment", "default", "hello")).toBeTruthy();
  expect(s.term.at(-1)?.cmd).toBe("kubectl create deployment hello --image=nginxdemos/hello:plain-text --replicas=3");
  // a second one gets a unique name
  performDrop(s, { kind: "palette", what: "deployment", image: "nginxdemos/hello:plain-text", label: "" }, { type: "canvas" });
  expect(c.raw("Deployment", "default", "hello-2")).toBeTruthy();
  expect(performDrop(s, { kind: "palette", what: "service", label: "" }, { type: "deployment", ns: "default", name: "hello" }).ok).toBe(true);
  expect(c.get<Service>("Service", "default", "hello").spec?.selector).toEqual({ app: "hello" });
  performDrop(s, { kind: "palette", what: "pod", image: "nginx", label: "" }, { type: "node", name: "worker-2" });
  c.advance(5000);
  expect(c.get<Pod>("Pod", "default", "nginx").spec?.nodeName).toBe("worker-2");
  // re-point the service at the other deployment
  performDrop(s, { kind: "object", type: "service", ns: "default", name: "hello", label: "" }, { type: "deployment", ns: "default", name: "hello-2" });
  expect(c.get<Service>("Service", "default", "hello").spec?.selector).toEqual({ app: "hello-2" });
  // bare pod moved to another node is re-created pinned there
  performDrop(s, { kind: "object", type: "pod", ns: "default", name: "nginx", label: "" }, { type: "node", name: "worker-1" });
  c.advance(3000);
  expect(c.get<Pod>("Pod", "default", "nginx").spec?.nodeName).toBe("worker-1");
  expect(performDrop(s, { kind: "object", type: "deployment", ns: "default", name: "hello-2", label: "" }, { type: "trash" }).ok).toBe(true);
  expect(c.raw("Deployment", "default", "hello-2")).toBeUndefined();
  // invalid drops explain themselves
  const bad = performDrop(s, { kind: "palette", what: "service", label: "" }, { type: "canvas" });
  expect(bad.ok).toBe(false);
  expect(bad.note).toContain("Deployment");
});
