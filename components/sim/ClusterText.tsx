"use client";

// A text alternative to the Cluster View: the same objects and states as a
// structured list, for screen readers and for anyone who prefers reading.

import type { Cluster, CronJob, DaemonSet, Deployment, Endpoints, Ingress, Job, Node, Pod, Service, StatefulSet } from "@/lib/engine";
import { SYSTEM_NAMESPACES } from "@/lib/engine/bootstrap";
import { podReady, podStatus, restarts } from "@/lib/sim/status";
import type { Selection } from "./ClusterView";

export function ClusterText({ c, namespace, showSystem, onSelect }: { c: Cluster; namespace: string; showSystem: boolean; onSelect: (s: Selection) => void }) {
  const ok = (ns?: string) => (namespace === "*" ? showSystem || !SYSTEM_NAMESPACES.has(ns ?? "") : ns === namespace);
  const pods = c.list<Pod>("Pod").filter((p) => ok(p.metadata.namespace));
  const nodes = c.list<Node>("Node");
  const pending = pods.filter((p) => !p.spec?.nodeName);
  const item = "rounded px-1 text-left underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500";
  const workloads = [
    ...c.list<Deployment>("Deployment").filter((d) => ok(d.metadata.namespace)).map((d) => ({ kind: "deployment" as const, o: d, text: `Deployment ${d.metadata.name}: ${d.status?.readyReplicas ?? 0} of ${d.spec?.replicas ?? 1} ready, image ${(d.spec?.template?.spec?.containers?.[0]?.image ?? "")}` })),
    ...c.list<StatefulSet>("StatefulSet").filter((d) => ok(d.metadata.namespace)).map((d) => ({ kind: "statefulset" as const, o: d, text: `StatefulSet ${d.metadata.name}: ${d.status?.readyReplicas ?? 0} of ${d.spec?.replicas ?? 1} ready` })),
    ...c.list<DaemonSet>("DaemonSet").filter((d) => ok(d.metadata.namespace)).map((d) => ({ kind: "daemonset" as const, o: d, text: `DaemonSet ${d.metadata.name}: ${d.status?.numberReady ?? 0} of ${d.status?.desiredNumberScheduled ?? 0} nodes ready` })),
    ...c.list<CronJob>("CronJob").filter((d) => ok(d.metadata.namespace)).map((d) => ({ kind: "cronjob" as const, o: d, text: `CronJob ${d.metadata.name}: schedule ${d.spec!.schedule}, ${d.status?.active?.length ?? 0} running` })),
    ...c.list<Job>("Job").filter((d) => ok(d.metadata.namespace)).map((d) => ({ kind: "job" as const, o: d, text: `Job ${d.metadata.name}: ${d.status?.succeeded ?? 0} of ${d.spec?.completions ?? 1} succeeded${d.status?.failed ? `, ${d.status.failed} failed` : ""}` })),
  ];
  const services = c.list<Service>("Service").filter((s) => ok(s.metadata.namespace) && s.metadata.name !== "kubernetes");
  const ingresses = c.list<Ingress>("Ingress").filter((s) => ok(s.metadata.namespace));
  const podLine = (p: Pod) => `${p.metadata.name}: ${podStatus(p)}, ${podReady(p)} ready${restarts(p) ? `, ${restarts(p)} restarts` : ""}`;
  const podItem = (p: Pod) => (
    <li key={p.metadata.uid}>
      <button className={item} onClick={() => onSelect({ kind: "pod", ns: p.metadata.namespace, name: p.metadata.name })}>
        {podLine(p)}
      </button>
    </li>
  );
  return (
    <div className="h-full overflow-y-auto p-4 text-[13px] leading-relaxed text-slate-700">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Cluster as text</h2>
      <section aria-labelledby="ct-nodes" className="mt-3">
        <h3 id="ct-nodes" className="font-semibold text-slate-900">
          Nodes ({nodes.length})
        </h3>
        <ul className="mt-1 flex flex-col gap-2">
          {nodes.map((n) => {
            const ready = c.nodeReady(n);
            const up = c.state.nodes[n.metadata.name]?.up;
            const on = pods.filter((p) => p.spec?.nodeName === n.metadata.name);
            return (
              <li key={n.metadata.uid}>
                <button className={`${item} font-medium`} onClick={() => onSelect({ kind: "node", name: n.metadata.name })}>
                  {n.metadata.name}: {up === false ? "powered off" : ready ? "Ready" : "NotReady"}
                  {n.spec?.unschedulable ? ", cordoned" : ""}, {on.length} Pods
                </button>
                {on.length > 0 && <ul className="ml-4 list-disc pl-3">{on.map(podItem)}</ul>}
              </li>
            );
          })}
        </ul>
      </section>
      {pending.length > 0 && (
        <section aria-labelledby="ct-pending" className="mt-4">
          <h3 id="ct-pending" className="font-semibold text-slate-900">
            Waiting to be scheduled ({pending.length})
          </h3>
          <ul className="ml-4 list-disc pl-3">{pending.map(podItem)}</ul>
        </section>
      )}
      {workloads.length > 0 && (
        <section aria-labelledby="ct-work" className="mt-4">
          <h3 id="ct-work" className="font-semibold text-slate-900">
            Workloads ({workloads.length})
          </h3>
          <ul className="ml-4 list-disc pl-3">
            {workloads.map((w) => (
              <li key={w.o.metadata.uid}>
                <button className={item} onClick={() => onSelect({ kind: w.kind, ns: w.o.metadata.namespace, name: w.o.metadata.name })}>
                  {w.text}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {services.length > 0 && (
        <section aria-labelledby="ct-svc" className="mt-4">
          <h3 id="ct-svc" className="font-semibold text-slate-900">
            Services ({services.length})
          </h3>
          <ul className="ml-4 list-disc pl-3">
            {services.map((s) => {
              const ep = c.raw("Endpoints", s.metadata.namespace, s.metadata.name) as unknown as Endpoints | undefined;
              const ready = (ep?.subsets ?? []).reduce((a, x) => a + (x.addresses?.length ?? 0), 0);
              return (
                <li key={s.metadata.uid}>
                  <button className={item} onClick={() => onSelect({ kind: "service", ns: s.metadata.namespace, name: s.metadata.name })}>
                    {s.metadata.name}: {s.spec?.clusterIP === "None" ? "headless" : `${s.spec?.type} ${s.spec?.clusterIP}`}, {ready} ready endpoint{ready === 1 ? "" : "s"}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {ingresses.length > 0 && (
        <section aria-labelledby="ct-ing" className="mt-4">
          <h3 id="ct-ing" className="font-semibold text-slate-900">
            Ingresses ({ingresses.length})
          </h3>
          <ul className="ml-4 list-disc pl-3">
            {ingresses.map((i) => (
              <li key={i.metadata.uid}>
                <button className={item} onClick={() => onSelect({ kind: "ingress", ns: i.metadata.namespace, name: i.metadata.name })}>
                  {i.metadata.name}: {(i.spec?.rules ?? []).flatMap((r) => (r.http?.paths ?? []).map((p) => `${r.host ?? "any host"}${p.path ?? "/"} to ${p.backend.service?.name}`)).join("; ")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
