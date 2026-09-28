"use client";

// A small, real Simulated Cluster on the home page: the Cluster View and a
// kubectl terminal, with a few commands to click. Not a recording.

import { useState } from "react";
import type { Cluster, Pod } from "@/lib/engine";
import { useSimulation } from "@/lib/sim/useSimulation";
import { ClusterView, type Selection } from "../sim/ClusterView";
import { Terminal } from "../sim/Terminal";

function setup(c: Cluster) {
  c.create({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "web", labels: { app: "web" } },
    spec: { replicas: 3, selector: { matchLabels: { app: "web" } }, template: { metadata: { labels: { app: "web" } }, spec: { containers: [{ name: "web", image: "nginxdemos/hello:plain-text" }] } } },
  });
  c.create({ apiVersion: "v1", kind: "Service", metadata: { name: "web" }, spec: { selector: { app: "web" }, ports: [{ port: 80 }] } });
}

export default function TryIt() {
  const sim = useSimulation({ setup, warmupMs: 15_000, seed: 3, onStart: (s) => s.exec("kubectl get pods") });
  const [sel, setSel] = useState<Selection>(null);
  const c = sim.cluster;
  if (!c) return <div className="grid h-full place-items-center text-[13px] text-slate-400">Starting a cluster…</div>;
  const victim = c.list<Pod>("Pod", "default").find((p) => p.metadata.labels?.app === "web" && !p.metadata.deletionTimestamp);
  const chips = [
    ["kubectl get pods -o wide", "List the Pods"],
    [victim ? `kubectl delete pod ${victim.metadata.name}` : "kubectl get pods", "Delete one"],
    ["kubectl scale deployment web --replicas=5", "Scale to 5"],
    ["curl http://web", "Send a request"],
  ];
  return (
    <div className="grid h-full min-h-0 md:grid-rows-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:grid-rows-1">
      <div className="relative hidden min-h-[300px] border-b border-slate-200/80 md:block lg:border-b-0 lg:border-r">
        <ClusterView cluster={c} packets={sim.packets} slots={sim.slots} now={sim.frameNow} selection={sel} onSelect={setSel} showSystem={false} namespace="*" inset={{ top: 8, bottom: 40 }} />
      </div>
      <div className="flex min-h-0 flex-col bg-white">
        <div className="flex flex-wrap gap-1.5 border-b border-slate-100 p-3">
          {chips.map(([cmd, label]) => (
            <button key={label} onClick={() => sim.exec(cmd)} title={cmd} className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono text-[11.5px] text-slate-700 transition hover:border-slate-300 hover:bg-white">
              {label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 md:h-[260px] md:flex-none lg:h-auto lg:flex-1 max-md:[&_pre]:overflow-x-auto max-md:[&_pre]:whitespace-pre max-md:[&_pre]:break-normal">
          <Terminal sim={sim} />
        </div>
      </div>
    </div>
  );
}
