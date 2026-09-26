"use client";

import type { Cluster, Deployment, Endpoints, KubeEvent, Node, Pod, ReplicaSet, Service } from "@/lib/engine";
import * as A from "@/lib/sim/actions";
import type { SimStore } from "@/lib/sim/useSimulation";
import { age, podCategory, podReady, podStatus, restarts } from "@/lib/sim/status";
import { Btn, CAT_COLOR, Dot, Heading, clock } from "../ui";
import type { Selection } from "./ClusterView";
import type { LogEntry } from "@/lib/sim/useSimulation";

type Sim = SimStore;

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1 text-[12.5px]">
      <span className="w-24 shrink-0 text-slate-400">{k}</span>
      <span className="min-w-0 break-all font-mono text-[12px] text-slate-800">{v}</span>
    </div>
  );
}

function EventList({ events, now }: { events: KubeEvent[]; now: number }) {
  if (!events.length) return <p className="text-[12.5px] text-slate-400">No events.</p>;
  return (
    <ol className="relative flex flex-col gap-2.5 border-l border-slate-200 pl-3">
      {events.slice(-12).map((e) => (
        <li key={e.metadata.uid} className="relative text-[12px] leading-snug">
          <span className="absolute -left-[16.5px] top-1.5 h-2 w-2 rounded-full border-2 border-white" style={{ background: e.type === "Warning" ? "#f59e0b" : "#94a3b8" }} />
          <div className="flex items-baseline gap-2">
            <span className={`font-medium ${e.type === "Warning" ? "text-amber-700" : "text-slate-800"}`}>{e.reason}</span>
            {e.count > 1 && <span className="text-[11px] text-slate-400">×{e.count}</span>}
            <span className="ml-auto font-mono text-[10.5px] text-slate-400">{age(now - e.lastTimestamp)}</span>
          </div>
          <div className="text-slate-500">{e.message}</div>
        </li>
      ))}
    </ol>
  );
}

function InspectHeader({ kind, name, color, status, actions }: { kind: string; name: string; color: string; status: string; actions?: React.ReactNode }) {
  return (
    <div className="border-b border-slate-100 p-4">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-400">{kind}</div>
      <div className="mt-1 break-all font-mono text-[14px] font-medium text-slate-900">{name}</div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11.5px] font-medium text-slate-700">
          <Dot color={color} />
          {status}
        </span>
        <div className="flex gap-1.5">{actions}</div>
      </div>
    </div>
  );
}

export function Inspector({ sim, c, sel, onSelect }: { sim: Sim; c: Cluster; sel: Selection; onSelect: (s: Selection) => void }) {
  if (!sel) {
    return (
      <div className="flex flex-col items-center p-10 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-400">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6}>
            <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z M12 12l8-4.5 M12 12v9 M12 12L4 7.5" strokeLinejoin="round" />
          </svg>
        </div>
        <p className="mt-3 text-[13px] font-medium text-slate-700">Nothing selected</p>
        <p className="mt-1 text-[12.5px] text-slate-400">Click a Pod, Node or Service on the canvas to inspect it.</p>
      </div>
    );
  }
  if (sel.kind === "deployment" || sel.kind === "replicaset") return <WorkloadInspector sim={sim} c={c} sel={sel} onSelect={onSelect} />;
  const obj = c.raw(sel.kind === "pod" ? "Pod" : sel.kind === "node" ? "Node" : "Service", sel.ns ?? "default", sel.name);
  if (!obj) return <p className="p-6 text-[13px] text-slate-400">{sel.name} no longer exists.</p>;

  if (sel.kind === "pod") {
    const p = obj as unknown as Pod;
    const cname = p.spec!.containers[0].name;
    const logs = c.logsFor(p, cname) ?? [];
    const prev = restarts(p) > 0 ? c.logsFor(p, cname, true) : undefined;
    const owner = p.metadata.ownerReferences?.find((o) => o.controller);
    const cs = p.status?.containerStatuses?.[0];
    return (
      <div>
        <InspectHeader kind="Pod" name={p.metadata.name} color={CAT_COLOR[podCategory(p)]} status={podStatus(p)} actions={<Btn tone="danger" onClick={() => sim.run((cl) => A.deletePod(cl, p.metadata.name, p.metadata.namespace))}>Delete</Btn>} />
        <div className="p-4">
          <KV k="Namespace" v={p.metadata.namespace} />
          <KV k="Ready" v={podReady(p)} />
          <KV k="Restarts" v={restarts(p)} />
          <KV k="Node" v={p.spec?.nodeName ? <button className="text-blue-600 hover:underline" onClick={() => onSelect({ kind: "node", name: p.spec!.nodeName! })}>{p.spec.nodeName}</button> : "—"} />
          <KV k="Pod IP" v={p.status?.podIP ?? "—"} />
          <KV k="Image" v={p.spec!.containers[0].image} />
          <KV k="Controlled by" v={owner ? `${owner.kind}/${owner.name}` : "—"} />
          <KV k="Age" v={age(c.now - p.metadata.creationTimestamp)} />
          {cs?.state.waiting?.message && <p className="mt-2 rounded-lg border border-red-100 bg-red-50 p-2 font-mono text-[11px] leading-snug text-red-700">{cs.state.waiting.message}</p>}
        </div>
        <div className="border-t border-slate-100 p-4">
          <Heading>Logs · {cname}</Heading>
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-2.5 font-mono text-[11px] leading-relaxed text-slate-700">
            {prev?.length ? `── previous run ──\n${prev.map((l) => l.text).join("\n")}\n── current ──\n` : ""}
            {logs.map((l) => l.text).join("\n") || "(no output yet)"}
          </pre>
        </div>
        <div className="border-t border-slate-100 p-4">
          <Heading>Events</Heading>
          <EventList events={c.eventsFor(p)} now={c.now} />
        </div>
      </div>
    );
  }

  if (sel.kind === "node") {
    const n = obj as unknown as Node;
    const pods = c.list<Pod>("Pod").filter((p) => p.spec?.nodeName === n.metadata.name);
    const nm = n.metadata.name;
    const up = c.state.nodes[nm]?.up;
    const ready = c.nodeReady(n);
    return (
      <div>
        <InspectHeader
          kind="Node"
          name={nm}
          color={ready ? (up ? "#16a34a" : "#dc2626") : "#f59e0b"}
          status={ready ? (up ? (n.spec?.unschedulable ? "Ready, cordoned" : "Ready") : "No heartbeat") : "NotReady"}
          actions={
            <>
              {up ? <Btn tone="danger" onClick={() => sim.run((cl) => A.chaosKill(cl, nm))}>Power off</Btn> : <Btn tone="primary" onClick={() => sim.run((cl) => A.chaosRecover(cl, nm))}>Power on</Btn>}
              <Btn onClick={() => sim.run((cl) => A.drain(cl, nm))}>Drain</Btn>
            </>
          }
        />
        <div className="p-4">
          <KV k="Internal IP" v={n.status?.addresses[0].address} />
          <KV k="Pod CIDR" v={n.spec?.podCIDR} />
          <KV k="Kubelet" v={up ? "posting status" : "stopped"} />
          <KV k="Taints" v={<span className="whitespace-pre-line">{(n.spec?.taints ?? []).map((t) => `${t.key}:${t.effect}`).join("\n") || "—"}</span>} />
        </div>
        <div className="border-t border-slate-100 p-4">
          <Heading>Conditions</Heading>
          {n.status?.conditions.map((cd) => (
            <div key={cd.type} className="flex items-center justify-between py-1 text-[12.5px]">
              <span className="text-slate-600">{cd.type}</span>
              <span className={`font-mono text-[11.5px] ${cd.type === "Ready" ? (cd.status === "True" ? "text-green-700" : "text-amber-700") : "text-slate-500"}`}>{cd.status}</span>
            </div>
          ))}
        </div>
        <div className="border-t border-slate-100 p-4">
          <Heading>Pods · {pods.length}</Heading>
          {pods.map((p) => (
            <button key={p.metadata.uid} onClick={() => onSelect({ kind: "pod", ns: p.metadata.namespace, name: p.metadata.name })} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-slate-50">
              <Dot color={CAT_COLOR[podCategory(p)]} />
              <span className="truncate font-mono text-[11.5px] text-slate-700">{p.metadata.name}</span>
              <span className="ml-auto shrink-0 text-[11px] text-slate-400">{podStatus(p)}</span>
            </button>
          ))}
        </div>
        <div className="border-t border-slate-100 p-4">
          <Heading>Events</Heading>
          <EventList events={c.eventsFor(n)} now={c.now} />
        </div>
      </div>
    );
  }

  const s = obj as unknown as Service;
  const ep = c.raw("Endpoints", s.metadata.namespace, s.metadata.name) as unknown as Endpoints | undefined;
  const ready = (ep?.subsets ?? []).flatMap((x) => (x.addresses ?? []).map((a) => `${a.ip}:${x.ports?.[0]?.port}`));
  const notReady = (ep?.subsets ?? []).flatMap((x) => (x.notReadyAddresses ?? []).map((a) => a.ip));
  return (
    <div>
      <InspectHeader
        kind="Service"
        name={s.metadata.name}
        color={ready.length ? "#2563eb" : "#dc2626"}
        status={`${s.spec?.type} · ${ready.length} endpoints`}
        actions={
          <>
            <Btn onClick={() => sim.curl(`http://${s.metadata.name}${s.metadata.namespace !== "default" ? "." + s.metadata.namespace : ""}`, 10)}>curl ×10</Btn>
            <Btn tone="danger" onClick={() => sim.run((cl) => A.deleteService(cl, s.metadata.name))}>Delete</Btn>
          </>
        }
      />
      <div className="p-4">
        <KV k="Cluster IP" v={s.spec?.clusterIP} />
        <KV k="Ports" v={(s.spec?.ports ?? []).map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol} → ${p.targetPort}`).join(", ")} />
        <KV k="Selector" v={Object.entries(s.spec?.selector ?? {}).map(([k, v]) => `${k}=${v}`).join(",")} />
        <KV k="DNS" v={`${s.metadata.name}.${s.metadata.namespace}.svc.cluster.local`} />
        <KV k="Endpoints" v={ready.join(", ") || <span className="text-red-600">none</span>} />
        {notReady.length > 0 && <KV k="Not ready" v={<span className="text-amber-700">{notReady.join(", ")}</span>} />}
      </div>
    </div>
  );
}


export function CommandLog({ log }: { log: LogEntry[] }) {
  if (!log.length) return <p className="py-2 text-[12.5px] text-slate-400">Every action runs the real kubectl command shown here, so you learn the CLI as you click.</p>;
  return (
    <div className="flex flex-col gap-3 py-1">
      {log.map((l) => (
        <div key={l.id} className="font-mono text-[11.5px] leading-relaxed">
          <div className="flex gap-3">
            <span className="w-10 shrink-0 text-slate-300">{clock(l.at)}</span>
            <span>
              <span className="text-slate-400">$ </span>
              <span className="text-slate-900">{l.cmd}</span>
            </span>
          </div>
          <pre className={`whitespace-pre-wrap pl-[52px] ${l.ok ? "text-slate-500" : "text-red-600"}`}>{l.out}</pre>
        </div>
      ))}
    </div>
  );
}

export function ResourceTable({ c }: { c: Cluster }) {
  const pods = c.list<Pod>("Pod", "default");
  const rss = c.list<ReplicaSet>("ReplicaSet", "default");
  const th = "pb-1.5 pr-4 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-slate-400";
  return (
    <div className="py-1">
      <table className="w-full font-mono text-[11.5px]">
        <thead>
          <tr>
            {["Pod", "Ready", "Status", "Restarts", "Age", "IP", "Node"].map((h) => (
              <th key={h} className={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-slate-700">
          {pods.map((p) => (
            <tr key={p.metadata.uid} className="border-t border-slate-100">
              <td className="py-1 pr-4">{p.metadata.name}</td>
              <td className="pr-4">{podReady(p)}</td>
              <td className="pr-4">
                <span className="inline-flex items-center gap-1.5">
                  <Dot color={CAT_COLOR[podCategory(p)]} />
                  {podStatus(p)}
                </span>
              </td>
              <td className="pr-4">{restarts(p)}</td>
              <td className="pr-4">{age(c.now - p.metadata.creationTimestamp)}</td>
              <td className="pr-4 text-slate-500">{p.status?.podIP ?? "—"}</td>
              <td className="text-slate-500">{p.spec?.nodeName ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {pods.length === 0 && <div className="py-2 text-[12.5px] text-slate-400">No resources found in default namespace.</div>}
      {rss.length > 0 && (
        <table className="mt-4 w-full font-mono text-[11.5px]">
          <thead>
            <tr>
              {["ReplicaSet", "Desired", "Current", "Ready"].map((h) => (
                <th key={h} className={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-slate-700">
            {rss.map((r) => (
              <tr key={r.metadata.uid} className="border-t border-slate-100">
                <td className="py-1 pr-4">{r.metadata.name}</td>
                <td className="pr-4">{r.spec?.replicas}</td>
                <td className="pr-4">{r.status?.replicas ?? 0}</td>
                <td>{r.status?.readyReplicas ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function EventsTable({ events, now }: { events: KubeEvent[]; now: number }) {
  if (!events.length) return <p className="py-2 text-[12.5px] text-slate-400">No events yet.</p>;
  return (
    <div className="flex flex-col py-1 font-mono text-[11.5px]">
      {events.slice(0, 150).map((e) => (
        <div key={e.metadata.uid} className="flex gap-3 border-t border-slate-100 py-1 first:border-0">
          <span className="w-10 shrink-0 text-slate-400">{age(now - e.lastTimestamp)}</span>
          <span className={`w-40 shrink-0 ${e.type === "Warning" ? "text-amber-700" : "text-slate-800"}`}>{e.reason}</span>
          <span className="w-56 shrink-0 truncate text-slate-500">
            {e.involvedObject.kind.toLowerCase()}/{e.involvedObject.name}
          </span>
          <span className="min-w-0 text-slate-600">
            {e.message}
            {e.count > 1 && <span className="text-slate-400"> ×{e.count}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}


function WorkloadInspector({ sim, c, sel, onSelect }: { sim: Sim; c: Cluster; sel: NonNullable<Selection>; onSelect: (s: Selection) => void }) {
  const ns = sel.ns ?? "default";
  if (sel.kind === "deployment") {
    const d = c.raw("Deployment", ns, sel.name) as unknown as Deployment | undefined;
    if (!d) return <p className="p-6 text-[13px] text-slate-400">{sel.name} no longer exists.</p>;
    const want = d.spec?.replicas ?? 1;
    const st = d.status ?? {};
    const rss = c.list<ReplicaSet>("ReplicaSet", ns).filter((r) => r.metadata.ownerReferences?.some((o) => o.uid === d.metadata.uid));
    const rev = (r: ReplicaSet) => Number(r.metadata.annotations?.["deployment.kubernetes.io/revision"] ?? 0);
    const ru = d.spec?.strategy?.rollingUpdate;
    return (
      <div>
        <InspectHeader kind="Deployment" name={d.metadata.name} color={(st.availableReplicas ?? 0) === want ? "#16a34a" : "#f59e0b"} status={`${st.readyReplicas ?? 0}/${want} ready`} actions={<><Btn onClick={() => sim.run((cl) => A.scale(cl, d.metadata.name, want + 1))}>Scale +1</Btn><Btn onClick={() => sim.run((cl) => A.rolloutUndo(cl, d.metadata.name))}>Undo</Btn></>} />
        <div className="p-4">
          <p className="mb-3 rounded-lg bg-slate-50 p-2.5 text-[12px] leading-relaxed text-slate-600">A Deployment keeps <b>{want}</b> copies of a Pod template running. When the template changes, it creates a new ReplicaSet and shifts Pods over one step at a time.</p>
          <KV k="Image" v={d.spec!.template.spec.containers[0].image} />
          <KV k="Selector" v={Object.entries(d.spec!.selector.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`).join(",")} />
          <KV k="Strategy" v={`${d.spec?.strategy?.type}${ru ? ` (surge ${ru.maxSurge}, unavailable ${ru.maxUnavailable})` : ""}`} />
          <KV k="Updated" v={`${st.updatedReplicas ?? 0} of ${want}`} />
          <KV k="Available" v={`${st.availableReplicas ?? 0} of ${want}`} />
          <KV k="Revision" v={d.metadata.annotations?.["deployment.kubernetes.io/revision"] ?? "—"} />
        </div>
        <div className="border-t border-slate-100 p-4">
          <Heading>ReplicaSets (revision history)</Heading>
          {rss.sort((a, b) => rev(b) - rev(a)).map((r) => (
            <button key={r.metadata.uid} onClick={() => onSelect({ kind: "replicaset", ns, name: r.metadata.name })} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-slate-50">
              <span className="rounded bg-slate-100 px-1.5 font-mono text-[10.5px] text-slate-600">rev {rev(r)}</span>
              <span className="truncate font-mono text-[11.5px] text-slate-700">{r.metadata.name}</span>
              <span className="ml-auto shrink-0 font-mono text-[11px] text-slate-500">{r.status?.readyReplicas ?? 0}/{r.spec?.replicas}</span>
            </button>
          ))}
        </div>
        <div className="border-t border-slate-100 p-4">
          <Heading>Events</Heading>
          <EventList events={c.eventsFor(d)} now={c.now} />
        </div>
      </div>
    );
  }
  const r = c.raw("ReplicaSet", ns, sel.name) as unknown as ReplicaSet | undefined;
  if (!r) return <p className="p-6 text-[13px] text-slate-400">{sel.name} no longer exists.</p>;
  const pods = c.list<Pod>("Pod", ns).filter((p) => p.metadata.ownerReferences?.some((o) => o.uid === r.metadata.uid));
  const owner = r.metadata.ownerReferences?.find((o) => o.controller);
  return (
    <div>
      <InspectHeader kind="ReplicaSet" name={r.metadata.name} color={(r.status?.readyReplicas ?? 0) === (r.spec?.replicas ?? 0) ? "#16a34a" : "#f59e0b"} status={`${r.status?.readyReplicas ?? 0}/${r.spec?.replicas} ready`} />
      <div className="p-4">
        <p className="mb-3 rounded-lg bg-slate-50 p-2.5 text-[12px] leading-relaxed text-slate-600">A ReplicaSet counts Pods matching its selector and creates or deletes Pods until the count equals <b>{r.spec?.replicas}</b>. That&apos;s what makes Pods self-heal.</p>
        <KV k="Owner" v={owner ? <button className="text-blue-600 hover:underline" onClick={() => onSelect({ kind: "deployment", ns, name: owner.name })}>{owner.kind}/{owner.name}</button> : "—"} />
        <KV k="Selector" v={Object.entries(r.spec!.selector.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`).join(",")} />
        <KV k="Image" v={r.spec!.template.spec.containers[0].image} />
        <KV k="Revision" v={r.metadata.annotations?.["deployment.kubernetes.io/revision"] ?? "—"} />
      </div>
      <div className="border-t border-slate-100 p-4">
        <Heading>Pods · {pods.length}</Heading>
        {pods.map((p) => (
          <button key={p.metadata.uid} onClick={() => onSelect({ kind: "pod", ns, name: p.metadata.name })} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-slate-50">
            <Dot color={CAT_COLOR[podCategory(p)]} />
            <span className="truncate font-mono text-[11.5px] text-slate-700">{p.metadata.name}</span>
            <span className="ml-auto shrink-0 text-[11px] text-slate-400">{podStatus(p)}</span>
          </button>
        ))}
      </div>
      <div className="border-t border-slate-100 p-4">
        <Heading>Events</Heading>
        <EventList events={c.eventsFor(r)} now={c.now} />
      </div>
    </div>
  );
}
