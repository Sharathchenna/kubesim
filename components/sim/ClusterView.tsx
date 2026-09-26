"use client";

// 2D Cluster View built for learning. It shows the whole ownership chain:
//   Deployment → ReplicaSet → Pods (placed on their Node) ← Service
// with the scheduler queue on the left and traffic flowing along Service edges.

import { useState } from "react";
import type { Cluster, Deployment, Endpoints, Node, Pod, ReplicaSet, Service } from "@/lib/engine";
import { fnv32a } from "@/lib/engine/util";
import { PACKET_MS, type Packet } from "@/lib/sim/useSimulation";
import { isRollingOut, podCategory, podStatus, restarts, type PodCategory } from "@/lib/sim/status";
import { PanZoom, type Bounds, type Inset } from "./PanZoom";
import { useDrag } from "./DragLayer";
import type { DragItem } from "@/lib/sim/drag";

export type Selection = { kind: "pod" | "node" | "service" | "deployment" | "replicaset"; ns?: string; name: string } | null;

const NODE_W = 312;
const NODE_GAP = 36;
const HEAD = 62;
const PAD = 14;
const CHIP_W = 88;
const CHIP_H = 48;
const CHIP_GAP = 8;
const COLS = 3;
const DEP_H = 58;
const RS_H = 50;
const RS_W = 176;
const Y_DEP = 0;
const Y_RS = 104;
const Y_NODES = 236;
const SVC_W = 218;
const SVC_H = 64;
const QUEUE_W = 128;

const HUES = [221, 162, 262, 24, 330, 190, 142, 45];
export const hueFor = (name: string) => HUES[fnv32a(name) % HUES.length];
const ownerName = (p: Pod) => p.metadata.ownerReferences?.find((o) => o.controller)?.name;

const CAT: Record<PodCategory, { dot: string; text: string; label?: string }> = {
  ok: { dot: "#16a34a", text: "#15803d" },
  starting: { dot: "#f59e0b", text: "#b45309" },
  bad: { dot: "#dc2626", text: "#b91c1c" },
  done: { dot: "#64748b", text: "#475569" },
  gone: { dot: "#94a3b8", text: "#64748b" },
  stale: { dot: "#94a3b8", text: "#64748b", label: "Unknown" },
};

type Pt = { x: number; y: number };

const curve = (a: Pt, b: Pt) => {
  const dy = Math.max(40, Math.abs(b.y - a.y) * 0.45);
  const s = Math.sign(b.y - a.y) || 1;
  return { d: `M${a.x},${a.y} C${a.x},${a.y + dy * s} ${b.x},${b.y - dy * s} ${b.x},${b.y}`, c1: { x: a.x, y: a.y + dy * s }, c2: { x: b.x, y: b.y - dy * s } };
};
const onCubic = (a: Pt, c1: Pt, c2: Pt, b: Pt, t: number): Pt => {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
};

interface Props {
  cluster: Cluster;
  packets: Packet[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  showSystem: boolean;
  slots: Map<string, Map<string, number>>;
  now: number;
  namespace?: string;
  inset?: Inset;
}

export function ClusterView({ cluster: c, packets, selection, onSelect, showSystem, slots, now, namespace, inset }: Props) {
  const [k, setK] = useState(1);
  const drag = useDrag();
  /** Drag + drop wiring for an object: its drop key, optional drag source, and highlight. */
  const dnd = (key: string, item?: DragItem) => ({
    "data-drop": key,
    ...(drag && item ? { onPointerDown: (e: React.PointerEvent) => drag.begin(item, e) } : {}),
  });
  const hl = (key: string) => drag?.over === key;
  const dragged = (type: string, ns: string | undefined, name: string) => drag?.dragging?.kind === "object" && drag.dragging.type === type && drag.dragging.name === name && drag.dragging.ns === (ns ?? "default");
  /** Font size that never renders below ~10.5 px on screen. */
  const fz = (px: number) => Math.max(px, 10.5 / k);
  const compact = k < 0.8;
  const allNs = !namespace || namespace === "*";
  const nsOk = (ns?: string) => (allNs ? showSystem || ns !== "kube-system" : ns === namespace);
  const nsPrefix = (ns?: string) => (allNs && ns && ns !== "default" ? `${ns}/` : "");
  /** Keyboard + screen-reader props for a selectable object. */
  const act = (sel: Selection, label: string) => ({
    role: "button",
    tabIndex: 0,
    "aria-label": label,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(sel);
      }
    },
  });
  const nodes = c.list<Node>("Node");
  const cp = nodes.find((n) => n.metadata.labels?.["node-role.kubernetes.io/control-plane"] !== undefined);
  const ordered = cp ? [cp, ...nodes.filter((n) => n !== cp)] : nodes;
  const pods = c.list<Pod>("Pod").filter((p) => nsOk(p.metadata.namespace));
  const services = c.list<Service>("Service").filter((s) => nsOk(s.metadata.namespace) && s.metadata.name !== "kubernetes");
  const deps = c.list<Deployment>("Deployment").filter((d) => nsOk(d.metadata.namespace));
  const rsAll = c.list<ReplicaSet>("ReplicaSet").filter((r) => nsOk(r.metadata.namespace));

  // ---- node + pod layout
  const perRow = 4;
  const podPos = new Map<string, Pt & { pod: Pod }>();
  const nodeBoxes: { node: Node; x: number; y: number; h: number }[] = [];
  const nodePods = new Map<string, Pod[]>();
  const pending: Pod[] = [];
  for (const p of pods) {
    const n = p.spec?.nodeName;
    if (n && nodes.some((x) => x.metadata.name === n)) (nodePods.get(n) ?? nodePods.set(n, []).get(n)!).push(p);
    else pending.push(p);
  }
  let rowY = Y_NODES;
  for (let r = 0; r < Math.ceil(ordered.length / perRow); r++) {
    const row = ordered.slice(r * perRow, r * perRow + perRow);
    let rowH = 0;
    const boxes = row.map((node, i) => {
      const name = node.metadata.name;
      const list = nodePods.get(name) ?? [];
      let m = slots.get(name);
      if (!m) slots.set(name, (m = new Map()));
      const alive = new Set(list.map((p) => p.metadata.uid));
      for (const uid of [...m.keys()]) if (!alive.has(uid)) m.delete(uid);
      for (const p of list) {
        if (m.has(p.metadata.uid)) continue;
        const used = new Set(m.values());
        let k = 0;
        while (used.has(k)) k++;
        m.set(p.metadata.uid, k);
      }
      const maxSlot = Math.max(-1, ...m.values());
      const showCp = node === cp && !showSystem;
      const rows = Math.max(showCp ? 2 : 2, Math.ceil((maxSlot + 1) / COLS));
      const h = HEAD + PAD + rows * (CHIP_H + CHIP_GAP) - CHIP_GAP + PAD + (showCp ? 0 : 0);
      rowH = Math.max(rowH, h);
      const x = i * (NODE_W + NODE_GAP);
      for (const p of list) {
        const k = m.get(p.metadata.uid)!;
        podPos.set(p.metadata.uid, { x: x + PAD + (k % COLS) * (CHIP_W + CHIP_GAP), y: rowY + HEAD + PAD + Math.floor(k / COLS) * (CHIP_H + CHIP_GAP), pod: p });
      }
      return { node, x, y: rowY, h };
    });
    nodeBoxes.push(...boxes);
    rowY += rowH + NODE_GAP;
  }
  const nodesW = Math.min(ordered.length, perRow) * (NODE_W + NODE_GAP) - NODE_GAP;
  const nodesBottom = rowY - NODE_GAP;
  const qx = -QUEUE_W - NODE_GAP;
  pending.forEach((p, i) => podPos.set(p.metadata.uid, { x: qx + (QUEUE_W - CHIP_W) / 2, y: Y_NODES + 52 + i * (CHIP_H + CHIP_GAP), pod: p }));
  const queueH = Math.max(160, 52 + pending.length * (CHIP_H + CHIP_GAP) + 8);

  // ---- workloads band
  type RsBox = { rs: ReplicaSet; x: number; y: number };
  const depBoxes: { d: Deployment; x: number; w: number; rs: RsBox[] }[] = [];
  const rsBox = new Map<string, RsBox>();
  {
    const groups = deps.map((d) => ({
      d,
      rs: rsAll
        .filter((r) => r.metadata.ownerReferences?.some((o) => o.uid === d.metadata.uid))
        .filter((r) => (r.spec?.replicas ?? 0) > 0 || (r.status?.replicas ?? 0) > 0 || r.metadata.annotations?.["deployment.kubernetes.io/revision"] === d.metadata.annotations?.["deployment.kubernetes.io/revision"])
        .sort((a, b) => a.metadata.creationTimestamp - b.metadata.creationTimestamp),
    }));
    // Bare ReplicaSets get their own column.
    const orphanRs = rsAll.filter((r) => !r.metadata.ownerReferences?.length);
    const widths = groups.map((g) => Math.max(280, g.rs.length * (RS_W + 12) - 12));
    const total = widths.reduce((a, b) => a + b, 0) + Math.max(0, widths.length - 1) * 28;
    let x = Math.max(0, (nodesW - total) / 2);
    groups.forEach((g, i) => {
      const w = widths[i];
      const rsStart = x + (w - (g.rs.length * (RS_W + 12) - 12)) / 2;
      const boxes = g.rs.map((rs, j) => ({ rs, x: rsStart + j * (RS_W + 12), y: Y_RS }));
      for (const b of boxes) rsBox.set(b.rs.metadata.uid, b);
      depBoxes.push({ d: g.d, x, w, rs: boxes });
      x += w + 28;
    });
    orphanRs.forEach((rs, j) => rsBox.set(rs.metadata.uid, { rs, x: x + j * (RS_W + 12), y: Y_RS }));
  }

  // ---- services
  const svcY = nodesBottom + 110;
  const svcTotal = services.length * (SVC_W + 24) - 24;
  const svcBoxes = services.map((s, i) => ({ s, x: Math.max(0, (nodesW - svcTotal) / 2) + i * (SVC_W + 24), y: svcY }));

  // ---- relationships for highlighting
  const selPod = selection?.kind === "pod" ? pods.find((p) => p.metadata.name === selection.name && p.metadata.namespace === (selection.ns ?? "default")) : undefined;
  const selRsUid = selection?.kind === "replicaset" ? rsAll.find((r) => r.metadata.name === selection.name)?.metadata.uid : selPod?.metadata.ownerReferences?.find((o) => o.controller)?.uid;
  const selDep = selection?.kind === "deployment" ? deps.find((d) => d.metadata.name === selection.name) : selRsUid ? deps.find((d) => rsAll.find((r) => r.metadata.uid === selRsUid)?.metadata.ownerReferences?.some((o) => o.uid === d.metadata.uid)) : undefined;
  const selSvc = selection?.kind === "service" ? services.find((s) => s.metadata.name === selection.name) : undefined;
  const hot = (kind: string, uid: string) =>
    !!selection &&
    ((kind === "dep" && selDep?.metadata.uid === uid) ||
      (kind === "rs" && (selRsUid === uid || (!!selDep && rsAll.find((r) => r.metadata.uid === uid)?.metadata.ownerReferences?.some((o) => o.uid === selDep.metadata.uid)))) ||
      (kind === "svc" && selSvc?.metadata.uid === uid));

  const isSel = (kind: string, name: string, ns?: string) => selection?.kind === kind && selection.name === name && (selection.ns ?? "default") === (ns ?? "default");
  const click = (s: Selection) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (drag?.justDropped()) return;
    onSelect(s);
  };

  const podTop = (uid: string): Pt | undefined => {
    const p = podPos.get(uid);
    return p ? { x: p.x + CHIP_W / 2, y: p.y } : undefined;
  };
  const podBottom = (uid: string): Pt | undefined => {
    const p = podPos.get(uid);
    return p ? { x: p.x + CHIP_W / 2, y: p.y + CHIP_H } : undefined;
  };

  // service edge geometry, reused for packets
  const svcEdges = new Map<string, { a: Pt; b: Pt; c1: Pt; c2: Pt; d: string; ready: boolean; svcUid: string; podUid: string }>();
  for (const { s, x, y } of svcBoxes) {
    const ep = c.raw("Endpoints", s.metadata.namespace, s.metadata.name) as unknown as Endpoints | undefined;
    const addrs = (ep?.subsets ?? []).flatMap((sub) => [...(sub.addresses ?? []).map((a) => ({ a, ready: true })), ...(sub.notReadyAddresses ?? []).map((a) => ({ a, ready: false }))]);
    for (const { a, ready } of addrs) {
      const uid = a.targetRef?.uid ?? "";
      const b = podBottom(uid);
      if (!b) continue;
      const from = { x: x + SVC_W / 2, y };
      const cv = curve(from, b);
      svcEdges.set(`${s.metadata.uid}/${uid}`, { a: from, b, ...cv, ready, svcUid: s.metadata.uid, podUid: uid });
    }
  }

  const minX = Math.min(qx, 0) - 40;
  const maxX = Math.max(nodesW, ...depBoxes.map((d) => d.x + d.w), ...svcBoxes.map((s) => s.x + SVC_W)) + 40;
  const maxY = (services.length ? svcY + SVC_H : nodesBottom) + 40;
  const top = (deps.length || rsBox.size ? Y_DEP : Y_NODES) - 40;
  const bounds: Bounds = { x: minX, y: top, w: maxX - minX, h: maxY - top };

  return (
    <PanZoom bounds={bounds} fitKey={`${ordered.length}:${deps.length}:${services.length}`} onBackgroundClick={() => onSelect(null)} inset={inset} onZoom={setK}>
      <defs>
        <filter id="cv-shadow" x="-10%" y="-10%" width="120%" height="140%">
          <feDropShadow dx="0" dy="1" stdDeviation="1" floodColor="#0f172a" floodOpacity="0.05" />
          <feDropShadow dx="0" dy="6" stdDeviation="8" floodColor="#0f172a" floodOpacity="0.05" />
        </filter>
        <pattern id="cv-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="3" height="8" fill="#f59e0b" opacity="0.12" />
        </pattern>
      </defs>

      {/* section labels */}
      <g className="fill-slate-400" style={{ fontSize: fz(11), fontWeight: 600, letterSpacing: "0.08em" }}>
        {deps.length > 0 && <text x={minX + 40} y={Y_DEP - 14}>WORKLOADS</text>}
        <text x={minX + 40} y={Y_NODES - 14}>NODES</text>
        {services.length > 0 && <text x={minX + 40} y={svcY - 14}>SERVICES</text>}
      </g>

      {/* ------------ edges (behind cards) */}
      <g fill="none" pointerEvents="none">
        {depBoxes.flatMap(({ d, x, w, rs }) =>
          rs.map((b) => {
            const cv = curve({ x: x + w / 2, y: Y_DEP + DEP_H }, { x: b.x + RS_W / 2, y: b.y });
            const h = hot("dep", d.metadata.uid);
            return <path key={`d${b.rs.metadata.uid}`} d={cv.d} stroke={h ? "#0f172a" : "#cbd5e1"} strokeWidth={h ? 1.6 : 1.2} />;
          }),
        )}
        {pods.map((p) => {
          const rsUid = p.metadata.ownerReferences?.find((o) => o.controller && o.kind === "ReplicaSet")?.uid;
          const b = rsUid ? rsBox.get(rsUid) : undefined;
          const t = podTop(p.metadata.uid);
          if (!b || !t) return null;
          const cv = curve({ x: b.x + RS_W / 2, y: b.y + RS_H }, t);
          const h = hot("rs", rsUid!) || selPod?.metadata.uid === p.metadata.uid;
          const hue = hueFor(b.rs.metadata.name);
          return <path key={`r${p.metadata.uid}`} d={cv.d} stroke={`hsl(${hue} 60% ${h ? 45 : 70}%)`} strokeOpacity={h ? 0.9 : 0.45} strokeWidth={h ? 1.6 : 1} className="cv-edge" />;
        })}
        {[...svcEdges.values()].map((e) => {
          const h = hot("svc", e.svcUid) || selPod?.metadata.uid === e.podUid;
          return <path key={`s${e.svcUid}${e.podUid}`} d={e.d} stroke={e.ready ? (h ? "#2563eb" : "#93b4f0") : "#f0a8a0"} strokeWidth={h ? 1.8 : 1.2} strokeDasharray={e.ready ? undefined : "4 4"} className="cv-edge" />;
        })}
      </g>

      {/* ------------ deployments + replicasets */}
      {depBoxes.map(({ d, x, w }) => {
        const want = d.spec?.replicas ?? 1;
        const ready = d.status?.readyReplicas ?? 0;
        const rolling = isRollingOut(c, d);
        const sel = isSel("deployment", d.metadata.name, d.metadata.namespace) || hot("dep", d.metadata.uid);
        return (
          <g key={d.metadata.uid} className="cv-fade cursor-pointer" opacity={dragged("deployment", d.metadata.namespace, d.metadata.name) ? 0.45 : 1} {...dnd(`deployment:${d.metadata.namespace}/${d.metadata.name}`, { kind: "object", type: "deployment", ns: d.metadata.namespace ?? "default", name: d.metadata.name, label: `Deployment ${d.metadata.name}` })} onClick={click({ kind: "deployment", ns: d.metadata.namespace, name: d.metadata.name })} {...act({ kind: "deployment", ns: d.metadata.namespace, name: d.metadata.name }, `Deployment ${d.metadata.name}, ${ready} of ${want} ready${rolling ? ", rolling out" : ""}`)}>
            <rect x={x} y={Y_DEP} width={w} height={DEP_H} rx={12} fill="#fff" stroke={sel ? "#0f172a" : "#e2e8f0"} strokeWidth={sel ? 1.5 : 1} filter="url(#cv-shadow)" />
            {hl(`deployment:${d.metadata.namespace}/${d.metadata.name}`) && <rect x={x - 3} y={Y_DEP - 3} width={w + 6} height={DEP_H + 6} rx={14} fill="#2563eb" fillOpacity={0.06} stroke="#2563eb" strokeWidth={2} strokeDasharray="6 4" />}
            <Icon kind="deploy" x={x + 14} y={Y_DEP + 15} />
            <text x={x + 46} y={Y_DEP + 25} className="fill-slate-900" style={{ fontSize: fz(13.5), fontWeight: 600 }}>
              {clip(nsPrefix(d.metadata.namespace) + d.metadata.name, Math.floor((w - 190) / (fz(13.5) * 0.58)))}
            </text>
            <text x={x + 46} y={Y_DEP + 43} className="fill-slate-400" style={{ fontSize: fz(11) }}>
              {clip(`Deployment · ${d.spec!.template.spec.containers[0].image}`, Math.floor((w - 60) / (fz(11) * 0.55)))}
            </text>
            <Pill x={x + w - 12} y={Y_DEP + 10} anchor="end" color={ready === want && !rolling ? "#16a34a" : "#f59e0b"} text={rolling ? `rolling out · ${ready}/${want}` : `${ready}/${want} ready`} />
          </g>
        );
      })}
      {[...rsBox.values()].map(({ rs, x, y }) => {
        const hue = hueFor(rs.metadata.name);
        const want = rs.spec?.replicas ?? 0;
        const retired = want === 0;
        const rev = rs.metadata.annotations?.["deployment.kubernetes.io/revision"];
        const sel = isSel("replicaset", rs.metadata.name, rs.metadata.namespace) || hot("rs", rs.metadata.uid);
        return (
          <g key={rs.metadata.uid} className="cv-fade cursor-pointer" opacity={retired ? 0.55 : 1} style={{ transform: `translate(${x}px, ${y}px)`, transition: "transform .6s cubic-bezier(.22,1,.36,1)" }} onClick={click({ kind: "replicaset", ns: rs.metadata.namespace, name: rs.metadata.name })} {...act({ kind: "replicaset", ns: rs.metadata.namespace, name: rs.metadata.name }, `ReplicaSet ${rs.metadata.name}, ${rs.status?.readyReplicas ?? 0} of ${want} ready`)}>
            <rect width={RS_W} height={RS_H} rx={10} fill="#fff" stroke={sel ? "#0f172a" : "#e2e8f0"} strokeWidth={sel ? 1.5 : 1} filter="url(#cv-shadow)" />
            <rect x={0} y={10} width={3.5} height={RS_H - 20} rx={1.75} fill={`hsl(${hue} 65% 55%)`} />
            <text x={14} y={20} className="fill-slate-800" style={{ fontSize: fz(11.5), fontWeight: 600, fontFamily: "var(--font-geist-mono)" }}>
              …{rs.metadata.name.slice(-10)}
            </text>
            <text x={14} y={37} className="fill-slate-400" style={{ fontSize: fz(10.5) }}>
              {compact ? (rev ? `rev ${rev}` : "RS") : `ReplicaSet${rev ? ` · rev ${rev}` : ""}`}
            </text>
            <text x={RS_W - 12} y={30} textAnchor="end" className="fill-slate-700" style={{ fontSize: fz(12), fontWeight: 600, fontFamily: "var(--font-geist-mono)" }}>
              {rs.status?.readyReplicas ?? 0}/{want}
            </text>
          </g>
        );
      })}

      {/* ------------ scheduler queue */}
      <g className="cv-fade">
        <rect x={qx} y={Y_NODES} width={QUEUE_W} height={queueH} rx={14} fill={pending.length ? "#fffbeb" : "#f8fafc"} stroke={pending.length ? "#fcd34d" : "#e2e8f0"} strokeDasharray="5 4" />
        <text x={qx + QUEUE_W / 2} y={Y_NODES + 24} textAnchor="middle" className="fill-slate-600" style={{ fontSize: fz(12), fontWeight: 600 }}>
          Scheduler
        </text>
        <text x={qx + QUEUE_W / 2} y={Y_NODES + 40} textAnchor="middle" className="fill-slate-400" style={{ fontSize: fz(10.5) }}>
          {pending.length ? `${pending.length} waiting for a node` : "nothing pending"}
        </text>
      </g>

      {/* ------------ nodes */}
      {nodeBoxes.map(({ node, x, y, h }) => {
        const name = node.metadata.name;
        const rt = c.state.nodes[name];
        const ready = node.status?.conditions.find((k) => k.type === "Ready")?.status === "True";
        const down = !!rt && !rt.up;
        const isCp = node === cp;
        const cordoned = !!node.spec?.unschedulable;
        const status = down && ready ? "no heartbeat" : ready ? (cordoned ? "cordoned" : "Ready") : "NotReady";
        const color = down ? "#dc2626" : !ready ? "#f59e0b" : cordoned ? "#f59e0b" : "#16a34a";
        const sel = isSel("node", name);
        const border = sel ? "#0f172a" : down ? "#fca5a5" : !ready ? "#fcd34d" : "#e2e8f0";
        const used = (nodePods.get(name) ?? []).filter((p) => !p.metadata.deletionTimestamp).length;
        const slotCount = Math.floor((h - HEAD - PAD * 2 + CHIP_GAP) / (CHIP_H + CHIP_GAP)) * COLS;
        return (
          <g key={node.metadata.uid} className="cv-fade cursor-pointer" {...dnd(`node:${name}`)} onClick={click({ kind: "node", name })} {...act({ kind: "node", name }, `Node ${name}, ${status}, ${used} pods`)}>
            <rect x={x} y={y} width={NODE_W} height={h} rx={16} fill={down ? "#fef2f2" : "#fff"} stroke={border} strokeWidth={sel ? 1.6 : 1} filter="url(#cv-shadow)" />
            {cordoned && <rect x={x} y={y} width={NODE_W} height={h} rx={16} fill="url(#cv-hatch)" pointerEvents="none" />}
            {hl(`node:${name}`) && <rect x={x - 4} y={y - 4} width={NODE_W + 8} height={h + 8} rx={19} fill="#2563eb" fillOpacity={0.05} stroke="#2563eb" strokeWidth={2} strokeDasharray="7 5" pointerEvents="none" />}
            <line x1={x} x2={x + NODE_W} y1={y + HEAD} y2={y + HEAD} stroke="#f1f5f9" />
            <Icon kind={isCp ? "cp" : "node"} x={x + 14} y={y + 16} />
            <text x={x + 48} y={y + 28} className="fill-slate-900" style={{ fontSize: fz(14), fontWeight: 600 }}>
              {name}
            </text>
            <text x={x + 48} y={y + 46} className="fill-slate-400" style={{ fontSize: fz(11) }}>
              {clip(`${isCp ? "control plane" : "worker"} · ${node.status?.addresses[0].address} · ${used} pods`, Math.floor((NODE_W - 150) / (fz(11) * 0.55)))}
            </text>
            <Pill x={x + NODE_W - 14} y={y + 20} anchor="end" color={color} text={status} k={k} />
            {Array.from({ length: slotCount }, (_, k) => (
              <rect key={k} x={x + PAD + (k % COLS) * (CHIP_W + CHIP_GAP)} y={y + HEAD + PAD + Math.floor(k / COLS) * (CHIP_H + CHIP_GAP)} width={CHIP_W} height={CHIP_H} rx={9} fill="#f8fafc" stroke="#eef2f6" strokeDasharray="3 3" pointerEvents="none" />
            ))}
            {isCp && !showSystem && (
              <g pointerEvents="none">
                {["kube-apiserver", "etcd", "scheduler", "controller-mgr"].map((comp, j) => {
                  const px = x + PAD + (j % 2) * ((NODE_W - PAD * 2 + CHIP_GAP) / 2);
                  const py = y + HEAD + PAD + Math.floor(j / 2) * (CHIP_H + CHIP_GAP);
                  return (
                    <g key={comp}>
                      <rect x={px} y={py} width={(NODE_W - PAD * 2 - CHIP_GAP) / 2} height={CHIP_H} rx={9} fill="#f5f3ff" stroke="#ddd6fe" />
                      <circle cx={px + 14} cy={py + CHIP_H / 2} r={3.5} fill={down ? "#94a3b8" : "#8b5cf6"} className={down ? undefined : "cv-pulse"} />
                      <text x={px + 26} y={compact ? py + CHIP_H / 2 + fz(11.5) * 0.36 : py + 22} className="fill-violet-900" style={{ fontSize: fz(11.5), fontWeight: 600, fontFamily: "var(--font-geist-mono)" }}>
                        {clip(comp, Math.floor(((NODE_W - PAD * 2 - CHIP_GAP) / 2 - 32) / (fz(11.5) * 0.62)))}
                      </text>
                      {!compact && (
                        <text x={px + 26} y={py + 37} className="fill-violet-400" style={{ fontSize: fz(10) }}>
                          system component
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            )}
            {down && (
              <text x={x + NODE_W / 2} y={y + h - 10} textAnchor="middle" className="fill-red-400" style={{ fontSize: fz(10.5), fontWeight: 500 }}>
                powered off · kubelet not reporting
              </text>
            )}
          </g>
        );
      })}

      {/* ------------ pods */}
      {[...podPos.values()].map(({ x, y, pod }) => {
        const nodeName = pod.spec?.nodeName;
        const stale = !!nodeName && c.state.nodes[nodeName]?.up === false;
        const cat: PodCategory = stale && !pod.metadata.deletionTimestamp ? "stale" : podCategory(pod);
        const own = ownerName(pod);
        const hue = hueFor(own ?? pod.metadata.name);
        const short = own && pod.metadata.name.startsWith(own) ? pod.metadata.name.slice(own.length + 1) : pod.metadata.name;
        const sel = isSel("pod", pod.metadata.name, pod.metadata.namespace);
        const status = CAT[cat].label ?? podStatus(pod);
        const r = restarts(pod);
        const bg = cat === "bad" ? "#fef2f2" : cat === "gone" || cat === "stale" ? "#f8fafc" : "#fff";
        return (
          <g
            key={pod.metadata.uid}
            className={`cv-pod cursor-pointer ${cat === "gone" ? "cv-gone" : ""}`}
            style={{ transform: `translate(${x}px, ${y}px)` }}
            opacity={dragged("pod", pod.metadata.namespace, pod.metadata.name) ? 0.35 : undefined}
            {...dnd(`pod:${pod.metadata.namespace}/${pod.metadata.name}`, { kind: "object", type: "pod", ns: pod.metadata.namespace ?? "default", name: pod.metadata.name, label: `Pod ${short}` })}
            onClick={click({ kind: "pod", ns: pod.metadata.namespace, name: pod.metadata.name })}
            {...act({ kind: "pod", ns: pod.metadata.namespace, name: pod.metadata.name }, `Pod ${pod.metadata.name}, ${status}${nodeName ? `, on ${nodeName}` : ", not scheduled"}${r ? `, ${r} restarts` : ""}`)}
          >
            <title>{`${pod.metadata.name}\n${podStatus(pod)}${pod.status?.podIP ? ` · ${pod.status.podIP}` : ""}`}</title>
            {hl(`pod:${pod.metadata.namespace}/${pod.metadata.name}`) && <rect x={-3} y={-3} width={CHIP_W + 6} height={CHIP_H + 6} rx={11} fill="#dc2626" fillOpacity={0.08} stroke="#dc2626" strokeWidth={2} strokeDasharray="5 3" />}
            <rect width={CHIP_W} height={CHIP_H} rx={9} fill={bg} stroke={sel ? "#0f172a" : cat === "bad" ? "#fecaca" : "#e2e8f0"} strokeWidth={sel ? 1.8 : 1} strokeDasharray={cat === "starting" ? "4 3" : undefined} filter="url(#cv-shadow)" />
            <rect x={0} y={9} width={3.5} height={CHIP_H - 18} rx={1.75} fill={cat === "stale" || cat === "gone" ? "#cbd5e1" : `hsl(${hue} 65% 55%)`} />
            {compact ? (
              <>
                <circle cx={14} cy={CHIP_H / 2} r={4.5} fill={CAT[cat].dot} className={cat === "starting" ? "cv-pulse" : cat === "bad" ? "cv-blink" : undefined} />
                <text x={24} y={CHIP_H / 2 + fz(11) * 0.36} className="fill-slate-800" style={{ fontSize: fz(11), fontWeight: 600, fontFamily: "var(--font-geist-mono)" }}>
                  {clip(short, Math.floor((CHIP_W - 28) / (fz(11) * 0.62)))}
                </text>
              </>
            ) : (
              <>
                <text x={11} y={19} className="fill-slate-800" style={{ fontSize: fz(11), fontWeight: 600, fontFamily: "var(--font-geist-mono)" }}>
                  {clip(short, 10)}
                </text>
                <circle cx={14} cy={33} r={3} fill={CAT[cat].dot} className={cat === "starting" ? "cv-pulse" : cat === "bad" ? "cv-blink" : undefined} />
                <text x={21} y={36.5} fill={CAT[cat].text} style={{ fontSize: fz(9.5), fontWeight: 500 }}>
                  {clip(status, 13)}
                </text>
              </>
            )}
            {r > 0 && (
              <g>
                <rect x={CHIP_W - 22} y={6} width={17} height={14} rx={7} fill="#fee2e2" />
                <text x={CHIP_W - 13.5} y={16} textAnchor="middle" fill="#b91c1c" style={{ fontSize: fz(9), fontWeight: 700 }}>
                  {r}
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* ------------ services */}
      {svcBoxes.map(({ s, x, y }) => {
        const ep = c.raw("Endpoints", s.metadata.namespace, s.metadata.name) as unknown as Endpoints | undefined;
        const ready = (ep?.subsets ?? []).reduce((a, sub) => a + (sub.addresses?.length ?? 0), 0);
        const sel = isSel("service", s.metadata.name, s.metadata.namespace) || hot("svc", s.metadata.uid);
        const port = s.spec?.ports?.[0];
        return (
          <g key={s.metadata.uid} className="cv-fade cursor-pointer" opacity={dragged("service", s.metadata.namespace, s.metadata.name) ? 0.45 : 1} {...dnd(`service:${s.metadata.namespace}/${s.metadata.name}`, { kind: "object", type: "service", ns: s.metadata.namespace ?? "default", name: s.metadata.name, label: `Service ${s.metadata.name}` })} onClick={click({ kind: "service", ns: s.metadata.namespace, name: s.metadata.name })} {...act({ kind: "service", ns: s.metadata.namespace, name: s.metadata.name }, `Service ${s.metadata.name}, ${ready} endpoints`)}>
            <rect x={x} y={y} width={SVC_W} height={SVC_H} rx={14} fill="#fff" stroke={sel ? "#2563eb" : "#dbe5f5"} strokeWidth={sel ? 1.6 : 1} filter="url(#cv-shadow)" />
            <Icon kind="svc" x={x + 14} y={y + 18} />
            <text x={x + 48} y={y + 27} className="fill-slate-900" style={{ fontSize: fz(13.5), fontWeight: 600 }}>
              {clip(nsPrefix(s.metadata.namespace) + s.metadata.name, Math.floor((SVC_W - 110) / (fz(13.5) * 0.58)))}
            </text>
            <text x={x + 48} y={y + 45} className="fill-slate-400" style={{ fontSize: fz(10.5), fontFamily: "var(--font-geist-mono)" }}>
              {s.spec?.clusterIP}:{port?.port}
              {port?.nodePort ? ` · node :${port.nodePort}` : ""}
            </text>
            <Pill x={x + SVC_W - 12} y={y + 14} anchor="end" color={ready ? "#2563eb" : "#dc2626"} text={`${ready} ep`} small k={k} />
          </g>
        );
      })}

      {/* ------------ traffic */}
      <g pointerEvents="none">
        {packets.map((p) => {
          const e = p.serviceUid ? svcEdges.get(`${p.serviceUid}/${p.podUid}`) : undefined;
          const t0 = Math.min(1, (now - p.born) / PACKET_MS);
          const t = t0 < 0.5 ? 2 * t0 * t0 : 1 - (-2 * t0 + 2) ** 2 / 2;
          let pt: Pt | undefined;
          if (e) pt = onCubic(e.a, e.c1, e.c2, e.b, p.ok ? t : Math.min(t, 0.7));
          else {
            const b = podBottom(p.podUid);
            if (b) pt = { x: b.x, y: b.y + 60 * (1 - t) };
          }
          if (!pt) return null;
          return <circle key={p.id} cx={pt.x} cy={pt.y} r={4} fill={p.ok ? "#2563eb" : "#dc2626"} stroke="#fff" strokeWidth={1.5} opacity={t0 > 0.85 ? (1 - t0) / 0.15 : 1} />;
        })}
      </g>
    </PanZoom>
  );
}

function Pill({ x, y, text, color, anchor = "start", small, k = 1 }: { x: number; y: number; text: string; color: string; anchor?: "start" | "end"; small?: boolean; k?: number }) {
  const fs = Math.max(small ? 10 : 10.5, 10 / k);
  const w = text.length * fs * 0.56 + 22;
  const h = fs + (small ? 8 : 9.5);
  const x0 = anchor === "end" ? x - w : x;
  return (
    <g pointerEvents="none">
      <rect x={x0} y={y} width={w} height={h} rx={h / 2} fill="#f8fafc" stroke="#e2e8f0" />
      <circle cx={x0 + 10} cy={y + h / 2} r={3} fill={color} />
      <text x={x0 + 17} y={y + h / 2 + fs * 0.36} className="fill-slate-600" style={{ fontSize: fs, fontWeight: 500 }}>
        {text}
      </text>
    </g>
  );
}

function Icon({ kind, x, y }: { kind: "node" | "cp" | "deploy" | "svc"; x: number; y: number }) {
  const bg = { node: "#f1f5f9", cp: "#f5f3ff", deploy: "#f1f5f9", svc: "#eff6ff" }[kind];
  const fg = { node: "#475569", cp: "#7c3aed", deploy: "#334155", svc: "#2563eb" }[kind];
  return (
    <g transform={`translate(${x} ${y})`} pointerEvents="none">
      <rect width={26} height={26} rx={7} fill={bg} />
      <g transform="translate(5 5)" fill="none" stroke={fg} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        {kind === "node" && (
          <>
            <rect x={1.5} y={2.5} width={13} height={4.5} rx={1.2} />
            <rect x={1.5} y={9} width={13} height={4.5} rx={1.2} />
            <circle cx={4.5} cy={4.75} r={0.4} fill={fg} />
            <circle cx={4.5} cy={11.25} r={0.4} fill={fg} />
          </>
        )}
        {kind === "cp" && <path d="M8 1.5l6 3.5v6L8 14.5 2 11V5l6-3.5z M8 5.5l2.8 1.6v3.2L8 12l-2.8-1.7V7.1z" />}
        {kind === "deploy" && (
          <>
            <rect x={2} y={2} width={5} height={5} rx={1.2} />
            <rect x={9} y={2} width={5} height={5} rx={1.2} />
            <rect x={2} y={9} width={5} height={5} rx={1.2} />
            <rect x={9} y={9} width={5} height={5} rx={1.2} />
          </>
        )}
        {kind === "svc" && (
          <>
            <circle cx={8} cy={3.5} r={2} />
            <circle cx={3} cy={12.5} r={2} />
            <circle cx={13} cy={12.5} r={2} />
            <path d="M8 5.5v3 M8 8.5L4 11 M8 8.5l4 2.5" />
          </>
        )}
      </g>
    </g>
  );
}

function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s;
}
