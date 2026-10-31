"use client";

// A small, real Simulated Cluster on the home page: the Cluster View and a
// kubectl terminal, with a few commands to click. Not a recording.

import { useState } from "react";
import type { Cluster } from "@/lib/engine";
import { applyYaml } from "@/lib/kubectl/kubectl";
import { shopYaml } from "@/lib/sim/incidents";
import { useSimulation } from "@/lib/sim/useSimulation";
import { ClusterView, type Selection } from "../sim/ClusterView";
import { Terminal } from "../sim/Terminal";

/** The shop from the Incidents (web, API, Postgres, Redis, and customers sending traffic), healthy. */
function setup(c: Cluster) {
  applyYaml({ cluster: c, namespace: "default", files: {} }, shopYaml(), undefined, undefined, "shop.yaml");
}

export default function TryIt({ active = true }: { active?: boolean }) {
  const sim = useSimulation({ setup, warmupMs: 60_000, seed: 3, onStart: (s) => s.exec("kubectl get pods") }, active);
  const [sel, setSel] = useState<Selection>(null);
  const c = sim.cluster;
  if (!c) return <div className="grid h-full place-items-center text-[14px] text-ink-soft">Starting a cluster…</div>;
  const chips = [
    ["kubectl delete pod shop-db-0", "Kill the database"],
    ["kubectl rollout restart deployment shop-api", "Restart the API"],
    ["kubectl scale deployment shop-web --replicas=5", "Scale the website"],
    ["kubectl get pods -o wide", "List the Pods"],
  ];
  // The shop is wide: the diagram gets the whole width, with the commands and terminal in a strip below it.
  // Phones keep the same picture, smaller, with the commands in one scrolling row.
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_212px] md:grid-rows-[minmax(0,1fr)_230px]">
      <div className="relative min-h-0 border-b border-ink/10">
        <ClusterView cluster={c} packets={sim.packets} slots={sim.slots} now={sim.frameNow} selection={sel} onSelect={setSel} showSystem={false} namespace="*" inset={{ top: 8, bottom: 40 }} captureWheel={false} />
      </div>
      <div className="flex min-h-0 flex-col bg-paper md:grid md:grid-cols-[230px_minmax(0,1fr)]">
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-ink/10 p-3 md:flex-col md:flex-wrap md:content-start md:overflow-visible md:border-b-0 md:border-r">
          {chips.map(([cmd, label]) => (
            <button key={label} onClick={() => sim.exec(cmd)} title={cmd} className="shrink-0 whitespace-nowrap rounded-lg border border-ink/15 bg-paper px-2.5 py-1 text-left text-[12.5px] font-medium text-ink transition-colors hover:border-signal/50 hover:text-signal">
              {label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 max-md:[&_pre]:overflow-x-auto max-md:[&_pre]:whitespace-pre max-md:[&_pre]:break-normal">
          <Terminal sim={sim} />
        </div>
      </div>
    </div>
  );
}
