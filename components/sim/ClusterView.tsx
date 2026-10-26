"use client";

// 2D Cluster View built for learning. It shows the whole ownership chain:
//   Deployment → ReplicaSet → Pods, StatefulSet / DaemonSet → Pods,
//   CronJob → Job → Pods (Pods placed on their Node) ← Service ← Ingress
// with the scheduler queue on the left, config, storage, policies and access
// in a column on the right, and traffic flowing along the edges.

import { useEffect, useState } from "react";
import { CalendarClock, Database, FileText, Globe, HardDrive, Hexagon, KeyRound, Layers, Network, Play, Server, ShieldCheck, UserCheck, type LucideIcon } from "lucide-react";
import { fit, onFontsReady, textWidth } from "./textFit";
import { isIsolated, podRequests, nodeAllocatable, type Cluster, type ConfigMap, type CronJob, type DaemonSet, type Deployment, type Endpoints, type HorizontalPodAutoscaler, type Ingress, type Job, type NetworkPolicy, type Node, type PersistentVolume, type PersistentVolumeClaim, type Pod, type ReplicaSet, type RoleBinding, type Secret, type Service, type StatefulSet } from "@/lib/engine";
import { fnv32a } from "@/lib/engine/util";
import { SYSTEM_NAMESPACES } from "@/lib/engine/bootstrap";
import { PACKET_MS, type Packet } from "@/lib/sim/useSimulation";
import { isRollingOut, podCategory, podStatus, restarts, type PodCategory } from "@/lib/sim/status";
import { PanZoom, type Bounds, type Inset } from "./PanZoom";
import { useDrag } from "./DragLayer";
import type { DragItem } from "@/lib/sim/drag";

export type SelKind = "pod" | "node" | "service" | "deployment" | "replicaset" | "statefulset" | "daemonset" | "job" | "cronjob" | "ingress" | "configmap" | "secret" | "pvc" | "networkpolicy" | "hpa" | "rolebinding";
export type Selection = { kind: SelKind; ns?: string; name: string } | null;

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
const Y_RS = 96;
const Y_NODES = 212;
const SVC_W = 218;
const SVC_H = 64;
const ING_W = 250;
const ING_H = 64;
const QUEUE_W = 128;
/** The control plane collapses to this when its system Pods are hidden and nothing else runs there. */
const CP_W = 236;
const CP_BODY = 44;
const SIDE_W = 190;
const SIDE_H = 40;

/** Corner radius shared by every card (Nodes and Services add a little). */
const R = 0;
const ARROW = 6;

const HUES = [221, 162, 262, 24, 330, 190, 142, 45];
export const hueFor = (name: string) => HUES[fnv32a(name) % HUES.length];
const ownerOf = (o: { metadata: { ownerReferences?: { controller?: boolean; kind: string; name: string; uid: string }[] } }) => o.metadata.ownerReferences?.find((r) => r.controller);

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
/** Right-angle route with rounded corners, turning at `turnY`. */
const ortho = (a: Pt, b: Pt, turnY: number, r = 10) => {
  if (Math.abs(a.x - b.x) < 1) return `M${a.x},${a.y} V${b.y}`;
  const s = Math.sign(b.x - a.x);
  const rr = Math.max(0, Math.min(r, Math.abs(b.x - a.x) / 2, turnY - a.y, b.y - turnY));
  return `M${a.x},${a.y} V${turnY - rr} Q${a.x},${turnY} ${a.x + s * rr},${turnY} H${b.x - s * rr} Q${b.x},${turnY} ${b.x},${turnY + rr} V${b.y}`;
};
const arrowDown = (tip: Pt) => `M${tip.x},${tip.y} l${-ARROW * 0.6},${-ARROW} h${ARROW * 1.2} z`;
const hcurve = (a: Pt, b: Pt) => {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.45);
  const s = Math.sign(b.x - a.x) || 1;
  return `M${a.x},${a.y} C${a.x + dx * s},${a.y} ${b.x - dx * s},${b.y} ${b.x},${b.y}`;
};
const onCubic = (a: Pt, c1: Pt, c2: Pt, b: Pt, t: number): Pt => {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
};
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

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
  /** Nodes per row (phones stack them so each stays readable). Default 4. */
  perRow?: number;
  /** See PanZoom: off when the canvas sits inside a scrolling page. */
  captureWheel?: boolean;
}

type TopKind = "deployment" | "statefulset" | "daemonset" | "cronjob" | "job";
interface TopCard {
  kind: TopKind;
  obj: Deployment | StatefulSet | DaemonSet | CronJob | Job;
  x: number;
  w: number;
  children: { kind: "replicaset" | "job"; obj: ReplicaSet | Job; x: number; y: number }[];
}

/** Everything a Pod refers to: ConfigMaps, Secrets and PVCs (by name, in its namespace). */
function podRefs(p: Pod): { configmap: Set<string>; secret: Set<string>; pvc: Set<string> } {
  const out = { configmap: new Set<string>(), secret: new Set<string>(), pvc: new Set<string>() };
  for (const v of p.spec?.volumes ?? []) {
    if (v.configMap && v.configMap.name !== "kube-root-ca.crt") out.configmap.add(v.configMap.name);
    if (v.secret) out.secret.add(v.secret.secretName);
    if (v.persistentVolumeClaim) out.pvc.add(v.persistentVolumeClaim.claimName);
  }
  for (const c of p.spec?.containers ?? []) {
    for (const e of c.env ?? []) {
      if (e.valueFrom?.configMapKeyRef) out.configmap.add(e.valueFrom.configMapKeyRef.name);
      if (e.valueFrom?.secretKeyRef) out.secret.add(e.valueFrom.secretKeyRef.name);
    }
    for (const e of c.envFrom ?? []) {
      if (e.configMapRef) out.configmap.add(e.configMapRef.name);
      if (e.secretRef) out.secret.add(e.secretRef.name);
    }
  }
  return out;
}

export function ClusterView({ cluster: c, packets, selection, onSelect, showSystem, slots, now, namespace, inset, perRow = 4, captureWheel }: Props) {
  const [k, setK] = useState(1);
  const drag = useDrag();
  /** Drag + drop wiring for an object: its drop key, optional drag source, and highlight. */
  const dnd = (key: string, item?: DragItem) => ({
    "data-drop": key,
    ...(drag && item ? { onPointerDown: (e: React.PointerEvent) => drag.begin(item, e) } : {}),
  });
  const hl = (key: string) => drag?.over === key;
  const dragged = (type: string, ns: string | undefined, name: string) => drag?.dragging?.kind === "object" && drag.dragging.type === type && drag.dragging.name === name && drag.dragging.ns === (ns ?? "default");
  // Labels are measured with the real font; re-render once web fonts arrive.
  const [, setFontTick] = useState(0);
  useEffect(() => onFontsReady(() => setFontTick((t) => t + 1)), []);
  const allNs = !namespace || namespace === "*";
  const nsOk = (ns?: string) => (allNs ? showSystem || !SYSTEM_NAMESPACES.has(ns ?? "") : ns === namespace);
  const nsPrefix = (ns?: string) => (allNs && ns && ns !== "default" ? `${ns}/` : "");
  /** Keyboard + screen-reader props for a selectable object. */
  const act = (sel: Selection, label: string) => ({
    role: "button",
    tabIndex: 0,
    "aria-label": label,
    "aria-pressed": isSelObj(sel),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(sel);
      }
    },
  });
  const isSelObj = (s: Selection) => !!s && !!selection && s.kind === selection.kind && s.name === selection.name && (s.ns ?? "default") === (selection.ns ?? "default");
  const nodes = c.list<Node>("Node");
  const cp = nodes.find((n) => n.metadata.labels?.["node-role.kubernetes.io/control-plane"] !== undefined);
  const ordered = cp ? [cp, ...nodes.filter((n) => n !== cp)] : nodes;
  const pods = c.list<Pod>("Pod").filter((p) => nsOk(p.metadata.namespace));
  const services = c.list<Service>("Service").filter((s) => nsOk(s.metadata.namespace) && s.metadata.name !== "kubernetes");
  const deps = c.list<Deployment>("Deployment").filter((d) => nsOk(d.metadata.namespace));
  const stss = c.list<StatefulSet>("StatefulSet").filter((d) => nsOk(d.metadata.namespace));
  const dss = c.list<DaemonSet>("DaemonSet").filter((d) => nsOk(d.metadata.namespace));
  const cjs = c.list<CronJob>("CronJob").filter((d) => nsOk(d.metadata.namespace));
  const jobs = c.list<Job>("Job").filter((d) => nsOk(d.metadata.namespace));
  const rsAll = c.list<ReplicaSet>("ReplicaSet").filter((r) => nsOk(r.metadata.namespace));
  const hpas = c.list<HorizontalPodAutoscaler>("HorizontalPodAutoscaler").filter((h) => nsOk(h.metadata.namespace));
  const ingresses = c.list<Ingress>("Ingress").filter((i) => nsOk(i.metadata.namespace));
  const cms = c.list<ConfigMap>("ConfigMap").filter((m) => nsOk(m.metadata.namespace) && m.metadata.name !== "kube-root-ca.crt" && !SYSTEM_NAMESPACES.has(m.metadata.namespace ?? ""));
  const secrets = c.list<Secret>("Secret").filter((m) => nsOk(m.metadata.namespace) && !SYSTEM_NAMESPACES.has(m.metadata.namespace ?? ""));
  const pvcs = c.list<PersistentVolumeClaim>("PersistentVolumeClaim").filter((m) => nsOk(m.metadata.namespace));
  const netpols = c.list<NetworkPolicy>("NetworkPolicy").filter((m) => nsOk(m.metadata.namespace));
  const bindings = c.list<RoleBinding>("RoleBinding").filter((m) => nsOk(m.metadata.namespace) && !SYSTEM_NAMESPACES.has(m.metadata.namespace ?? ""));

  // ---- node + pod layout
  const podPos = new Map<string, Pt & { pod: Pod }>();
  const nodeBoxes: { node: Node; x: number; y: number; h: number; w: number; collapsed: boolean }[] = [];
  const nodePods = new Map<string, Pod[]>();
  /** Slot assignments for this frame. Computed from the previous ones without touching them; committed after render. */
  const nextSlots = new Map<string, Map<string, number>>();
  const pending: Pod[] = [];
  for (const p of pods) {
    const n = p.spec?.nodeName;
    if (n && nodes.some((x) => x.metadata.name === n)) (nodePods.get(n) ?? nodePods.set(n, []).get(n)!).push(p);
    else pending.push(p);
  }
  let rowY = Y_NODES;
  let nodesW = 0;
  for (let r = 0; r < Math.ceil(ordered.length / perRow); r++) {
    const row = ordered.slice(r * perRow, r * perRow + perRow);
    let rowH = 0;
    let rowX = 0;
    const boxes = row.map((node) => {
      const name = node.metadata.name;
      const list = nodePods.get(name) ?? [];
      const collapsed = node === cp && !showSystem && list.length === 0;
      if (collapsed) {
        nextSlots.set(name, new Map());
        const h = HEAD + CP_BODY;
        rowH = Math.max(rowH, h);
        const x = rowX;
        rowX += CP_W + NODE_GAP;
        return { node, x, y: rowY, h, w: CP_W, collapsed };
      }
      const m = new Map(slots.get(name) ?? []);
      nextSlots.set(name, m);
      const alive = new Set(list.map((p) => p.metadata.uid));
      for (const uid of [...m.keys()]) if (!alive.has(uid)) m.delete(uid);
      for (const p of list) {
        if (m.has(p.metadata.uid)) continue;
        const used = new Set(m.values());
        let s = 0;
        while (used.has(s)) s++;
        m.set(p.metadata.uid, s);
      }
      const maxSlot = Math.max(-1, ...m.values());
      const rows = Math.max(1, Math.ceil((maxSlot + 1) / COLS));
      const h = HEAD + PAD + rows * (CHIP_H + CHIP_GAP) - CHIP_GAP + PAD;
      rowH = Math.max(rowH, h);
      const x = rowX;
      rowX += NODE_W + NODE_GAP;
      for (const p of list) {
        const s = m.get(p.metadata.uid)!;
        podPos.set(p.metadata.uid, { x: x + PAD + (s % COLS) * (CHIP_W + CHIP_GAP), y: rowY + HEAD + PAD + Math.floor(s / COLS) * (CHIP_H + CHIP_GAP), pod: p });
      }
      return { node, x, y: rowY, h, w: NODE_W, collapsed: false };
    });
    nodeBoxes.push(...boxes);
    nodesW = Math.max(nodesW, rowX - NODE_GAP);
    rowY += rowH + NODE_GAP;
  }
  const nodesBottom = rowY - NODE_GAP;
  useEffect(() => {
    for (const [name, m] of nextSlots) slots.set(name, m);
  });
  const qx = -QUEUE_W - NODE_GAP;
  pending.forEach((p, i) => podPos.set(p.metadata.uid, { x: qx + (QUEUE_W - CHIP_W) / 2, y: Y_NODES + 52 + i * (CHIP_H + CHIP_GAP), pod: p }));
  const queueH = Math.max(160, 52 + pending.length * (CHIP_H + CHIP_GAP) + 8);

  // ---- workloads band: controllers on top, their ReplicaSets / Jobs below
  const topCards: TopCard[] = [];
  const childBox = new Map<string, { x: number; y: number; kind: "replicaset" | "job"; obj: ReplicaSet | Job }>();
  const cardByUid = new Map<string, TopCard>();
  {
    const groups: Omit<TopCard, "x" | "w">[] = [
      ...deps.map((d) => ({
        kind: "deployment" as const,
        obj: d,
        children: rsAll
          .filter((r) => r.metadata.ownerReferences?.some((o) => o.uid === d.metadata.uid))
          .filter((r) => (r.spec?.replicas ?? 0) > 0 || (r.status?.replicas ?? 0) > 0 || r.metadata.annotations?.["deployment.kubernetes.io/revision"] === d.metadata.annotations?.["deployment.kubernetes.io/revision"])
          .sort((a, b) => a.metadata.creationTimestamp - b.metadata.creationTimestamp)
          .map((r) => ({ kind: "replicaset" as const, obj: r, x: 0, y: Y_RS })),
      })),
      ...stss.map((s) => ({ kind: "statefulset" as const, obj: s, children: [] })),
      ...dss.map((s) => ({ kind: "daemonset" as const, obj: s, children: [] })),
      ...cjs.map((cj) => ({
        kind: "cronjob" as const,
        obj: cj,
        children: jobs
          .filter((j) => ownerOf(j)?.uid === cj.metadata.uid)
          .sort((a, b) => a.metadata.creationTimestamp - b.metadata.creationTimestamp)
          .slice(-3)
          .map((j) => ({ kind: "job" as const, obj: j, x: 0, y: Y_RS })),
      })),
      ...jobs.filter((j) => !ownerOf(j)).map((j) => ({ kind: "job" as const, obj: j, children: [] })),
    ];
    const widths = groups.map((g) => Math.max(g.kind === "deployment" || g.kind === "cronjob" ? 280 : 250, g.children.length * (RS_W + 12) - 12));
    const total = widths.reduce((a, b) => a + b, 0) + Math.max(0, widths.length - 1) * 28;
    let x = Math.max(0, (nodesW - total) / 2);
    groups.forEach((g, i) => {
      const w = widths[i];
      const start = x + (w - (g.children.length * (RS_W + 12) - 12)) / 2;
      const card: TopCard = { ...g, x, w, children: g.children.map((ch, j) => ({ ...ch, x: start + j * (RS_W + 12) })) };
      for (const ch of card.children) childBox.set(ch.obj.metadata.uid, ch);
      cardByUid.set(g.obj.metadata.uid, card);
      topCards.push(card);
      x += w + 28;
    });
    // Bare ReplicaSets get their own boxes.
    rsAll.filter((r) => !r.metadata.ownerReferences?.length).forEach((rs, j) => childBox.set(rs.metadata.uid, { kind: "replicaset", obj: rs, x: x + j * (RS_W + 12), y: Y_RS }));
  }
  const workloadsRight = Math.max(0, ...topCards.map((t) => t.x + t.w), ...[...childBox.values()].map((b) => b.x + RS_W));

  // ---- services, then ingresses under them
  const svcY = nodesBottom + 84;
  const svcTotal = services.length * (SVC_W + 24) - 24;
  const svcBoxes = services.map((s, i) => ({ s, x: Math.max(0, (nodesW - svcTotal) / 2) + i * (SVC_W + 24), y: svcY }));
  const svcBox = new Map(svcBoxes.map((b) => [`${b.s.metadata.namespace}/${b.s.metadata.name}`, b]));
  const ingY = (services.length ? svcY + SVC_H : nodesBottom) + 84;
  const ingTotal = ingresses.length * (ING_W + 24) - 24;
  const ingBoxes = ingresses.map((ing, i) => ({ ing, x: Math.max(0, (nodesW - ingTotal) / 2) + i * (ING_W + 24), y: ingY }));

  // ---- config, storage, policy and access column
  const sideX = Math.max(nodesW, workloadsRight) + 44;
  type Side = { kind: SelKind; ns?: string; name: string; title: string; sub: string; tone: string; y: number; uid: string; warn?: boolean };
  const sections: { label: string; items: Omit<Side, "y">[] }[] = [
    {
      label: "CONFIG",
      items: [
        ...cms.map((m) => ({ kind: "configmap" as const, ns: m.metadata.namespace, name: m.metadata.name, uid: m.metadata.uid, title: nsPrefix(m.metadata.namespace) + m.metadata.name, sub: `ConfigMap · ${Object.keys(m.data ?? {}).length} key${Object.keys(m.data ?? {}).length === 1 ? "" : "s"}`, tone: "#0891b2" })),
        ...secrets.map((m) => ({ kind: "secret" as const, ns: m.metadata.namespace, name: m.metadata.name, uid: m.metadata.uid, title: nsPrefix(m.metadata.namespace) + m.metadata.name, sub: `Secret · ${m.type === "Opaque" || !m.type ? "" : `${m.type.replace("kubernetes.io/", "")} · `}${Object.keys(m.data ?? {}).length} key${Object.keys(m.data ?? {}).length === 1 ? "" : "s"}`, tone: "#9333ea" })),
      ],
    },
    {
      label: "STORAGE",
      items: pvcs.map((p) => {
        const pv = p.spec?.volumeName ? (c.raw("PersistentVolume", undefined, p.spec.volumeName) as unknown as PersistentVolume | undefined) : undefined;
        const node = pv?.spec?.nodeAffinity?.required?.nodeSelectorTerms?.[0]?.matchExpressions?.[0]?.values?.[0];
        const phase = p.metadata.deletionTimestamp !== undefined ? "Terminating" : (p.status?.phase ?? "Pending");
        return { kind: "pvc" as const, ns: p.metadata.namespace, name: p.metadata.name, uid: p.metadata.uid, title: nsPrefix(p.metadata.namespace) + p.metadata.name, sub: `PVC · ${phase} · ${p.spec?.resources?.requests?.storage ?? ""}${node ? ` · on ${node}` : ""}`, tone: phase === "Bound" ? "#16a34a" : "#f59e0b", warn: phase !== "Bound" };
      }),
    },
    {
      label: "NETWORK POLICIES",
      items: netpols.map((n) => {
        const sel = Object.entries(n.spec?.podSelector?.matchLabels ?? {}).map(([a, b]) => `${a}=${b}`).join(",") || "all pods";
        return { kind: "networkpolicy" as const, ns: n.metadata.namespace, name: n.metadata.name, uid: n.metadata.uid, title: nsPrefix(n.metadata.namespace) + n.metadata.name, sub: `${(n.spec?.policyTypes ?? ["Ingress"]).join("+")} · ${sel} · ${((m) => `${m} pod${m === 1 ? "" : "s"}`)(pods.filter((p) => policySelects(c, n.metadata.namespace!, n.metadata.name, p)).length)}`, tone: "#e11d48" };
      }),
    },
    {
      label: "ACCESS",
      items: bindings.map((b) => ({ kind: "rolebinding" as const, ns: b.metadata.namespace, name: b.metadata.name, uid: b.metadata.uid, title: nsPrefix(b.metadata.namespace) + b.metadata.name, sub: `${(b.subjects ?? []).map((s) => s.name).join(", ") || "nobody"} → ${b.roleRef.name}`, tone: "#475569" })),
    },
  ].filter((s) => s.items.length);
  const sideItems: Side[] = [];
  const sideLabels: { label: string; y: number }[] = [];
  {
    let y = Y_NODES;
    for (const s of sections) {
      sideLabels.push({ label: s.label, y: y - 14 });
      for (const it of s.items) {
        sideItems.push({ ...it, y });
        y += SIDE_H + 8;
      }
      y += 36;
    }
  }
  const sideByKey = new Map(sideItems.map((s) => [`${s.kind}:${s.ns}/${s.name}`, s]));

  // ---- relationships for highlighting
  const selPod = selection?.kind === "pod" ? pods.find((p) => p.metadata.name === selection.name && p.metadata.namespace === (selection.ns ?? "default")) : undefined;
  const findTop = (kind: TopKind, name: string, ns?: string) => topCards.find((t) => t.kind === kind && t.obj.metadata.name === name && t.obj.metadata.namespace === (ns ?? "default"));
  const selChildUid =
    selection?.kind === "replicaset" || (selection?.kind === "job" && !findTop("job", selection.name, selection.ns))
      ? [...childBox.values()].find((b) => b.obj.metadata.name === selection.name && b.obj.metadata.namespace === (selection.ns ?? "default"))?.obj.metadata.uid
      : selPod
        ? ownerOf(selPod)?.uid
        : undefined;
  const selTop: TopCard | undefined =
    selection && ["deployment", "statefulset", "daemonset", "cronjob", "job"].includes(selection.kind)
      ? findTop(selection.kind as TopKind, selection.name, selection.ns)
      : undefined;
  const topOfChild = (uid?: string) => (uid ? topCards.find((t) => t.children.some((ch) => ch.obj.metadata.uid === uid) || t.obj.metadata.uid === uid) : undefined);
  const hotTop = selTop ?? topOfChild(selChildUid);
  const selSvc = selection?.kind === "service" ? services.find((s) => s.metadata.name === selection.name && s.metadata.namespace === (selection.ns ?? "default")) : undefined;
  const selIng = selection?.kind === "ingress" ? ingresses.find((s) => s.metadata.name === selection.name && s.metadata.namespace === (selection.ns ?? "default")) : undefined;
  const selSide = selection ? sideByKey.get(`${selection.kind}:${selection.ns ?? "default"}/${selection.name}`) : undefined;

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
  const podRight = (uid: string): Pt | undefined => {
    const p = podPos.get(uid);
    return p ? { x: p.x + CHIP_W, y: p.y + CHIP_H / 2 } : undefined;
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
  // ingress → service edges
  const ingEdges = new Map<string, { a: Pt; b: Pt; c1: Pt; c2: Pt; d: string; ingUid: string; svcUid: string }>();
  for (const { ing, x, y } of ingBoxes) {
    const backends = new Set<string>();
    for (const r of ing.spec?.rules ?? []) for (const p of r.http?.paths ?? []) if (p.backend.service) backends.add(p.backend.service.name);
    if (ing.spec?.defaultBackend?.service) backends.add(ing.spec.defaultBackend.service.name);
    for (const name of backends) {
      const sb = svcBox.get(`${ing.metadata.namespace}/${name}`);
      if (!sb) continue;
      const a = { x: x + ING_W / 2, y };
      const b = { x: sb.x + SVC_W / 2, y: sb.y + SVC_H };
      const cv = curve(a, b);
      ingEdges.set(`${ing.metadata.uid}/${sb.s.metadata.uid}`, { a, b, ...cv, ingUid: ing.metadata.uid, svcUid: sb.s.metadata.uid });
    }
  }
  // side-column edges: shown for the selected Pod, or for the selected side item's Pods
  const sideEdges: { d: string; key: string }[] = [];
  const refsOf = (p: Pod) => podRefs(p);
  const linkPod = (p: Pod, it: Side) => {
    const a = podRight(p.metadata.uid);
    if (!a) return;
    sideEdges.push({ d: hcurve(a, { x: sideX, y: it.y + SIDE_H / 2 }), key: `${p.metadata.uid}/${it.uid}` });
  };
  if (selPod) {
    const r = refsOf(selPod);
    for (const it of sideItems) {
      const hit = (it.kind === "configmap" && r.configmap.has(it.name)) || (it.kind === "secret" && r.secret.has(it.name)) || (it.kind === "pvc" && r.pvc.has(it.name)) || (it.kind === "networkpolicy" && (c.raw("NetworkPolicy", it.ns, it.name) ? isIsolated(c, selPod, "Ingress") || isIsolated(c, selPod, "Egress") : false) && policySelects(c, it.ns!, it.name, selPod));
      if (hit && it.ns === selPod.metadata.namespace) linkPod(selPod, it);
    }
  } else if (selSide) {
    for (const p of pods) {
      if (p.metadata.namespace !== selSide.ns) continue;
      const r = refsOf(p);
      const hit = (selSide.kind === "configmap" && r.configmap.has(selSide.name)) || (selSide.kind === "secret" && r.secret.has(selSide.name)) || (selSide.kind === "pvc" && r.pvc.has(selSide.name)) || (selSide.kind === "networkpolicy" && policySelects(c, selSide.ns!, selSide.name, p));
      if (hit) linkPod(p, selSide);
    }
  }

  // Every NetworkPolicy is always linked (faintly) to the Pods it selects: a policy floating on its own says nothing.
  const polEdges: { d: string; key: string }[] = [];
  for (const it of sideItems) {
    if (it.kind !== "networkpolicy" || selSide === it) continue;
    for (const p of pods) {
      if (!policySelects(c, it.ns!, it.name, p)) continue;
      const a = podRight(p.metadata.uid);
      if (a) polEdges.push({ d: hcurve(a, { x: sideX, y: it.y + SIDE_H / 2 }), key: `np${p.metadata.uid}/${it.uid}` });
    }
  }

  const hotChild = (uid: string) => !!selection && (selChildUid === uid || (!!hotTop && hotTop.children.some((ch) => ch.obj.metadata.uid === uid)));
  const hotCard = (uid: string) => !!hotTop && hotTop.obj.metadata.uid === uid;

  const sideBottom = sideItems.length ? sideItems[sideItems.length - 1].y + SIDE_H : 0;
  const minX = (pending.length ? qx : 0) - 40;
  const maxX = Math.max(nodesW, workloadsRight, ...svcBoxes.map((s) => s.x + SVC_W), ...ingBoxes.map((s) => s.x + ING_W), sideItems.length ? sideX + SIDE_W : 0) + 40;
  const maxY = Math.max(ingresses.length ? ingY + ING_H : services.length ? svcY + SVC_H : nodesBottom, sideBottom) + 40;
  const top = (topCards.length || childBox.size ? Y_DEP : Y_NODES) - 40;
  const bounds: Bounds = { x: minX, y: top, w: maxX - minX, h: maxY - top };
  // Fit-to-screen always shows every Node (and the scheduler queue beside them).
  const nodesLeft = pending.length ? qx : 0;
  const nodesArea: Bounds = { x: nodesLeft, y: Y_NODES - 24, w: nodesW - nodesLeft, h: Math.max(nodesBottom, pending.length ? Y_NODES + queueH : 0) - Y_NODES + 24 };

  const hpaFor = (kind: string, name: string, ns?: string) => hpas.find((h) => h.spec?.scaleTargetRef.kind === kind && h.spec.scaleTargetRef.name === name && h.metadata.namespace === ns);
  const metrics = c.state.metrics;

  // Level of detail: zoomed out, objects simplify instead of shrinking their text.
  const detail = k >= 0.7 ? 2 : k >= 0.5 ? 1 : 0;
  // Service → Pod edges carrying requests right now, for the flow animation.
  const flowing = new Set(packets.filter((p) => p.serviceUid && !p.blocked).map((p) => `${p.serviceUid}/${p.podUid}`));
  const lane = new Map([...cardByUid.keys(), ...childBox.keys()].map((uid, i) => [uid, i % 5]));
  const cls = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(" ");

  return (
    <PanZoom bounds={bounds} mustFit={nodesArea} captureWheel={captureWheel} fitKey={`${perRow}:${ordered.length}:${topCards.length}:${services.length}:${ingresses.length}:${sideItems.length > 0}`} onBackgroundClick={() => onSelect(null)} inset={inset} onZoom={setK}>
      {/* section labels */}
      {detail > 0 && (
        <g className="cv-label">
          {topCards.length > 0 && <text x={minX + 40} y={Y_DEP - 14}>WORKLOADS</text>}
          <text x={minX + 40} y={Y_NODES - 14}>NODES</text>
          {services.length > 0 && <text x={minX + 40} y={svcY - 14}>SERVICES</text>}
          {ingresses.length > 0 && <text x={minX + 40} y={ingY - 14}>INGRESS</text>}
          {sideLabels.map((l) => (
            <text key={l.label} x={sideX} y={l.y}>
              {l.label}
            </text>
          ))}
        </g>
      )}

      {/* ------------ edges (behind cards) */}
      <g pointerEvents="none">
        {topCards.flatMap(({ obj, x, w, children }) =>
          children.map((b) => {
            const h = hotCard(obj.metadata.uid);
            const tip = { x: b.x + RS_W / 2, y: b.y };
            return (
              <g key={`d${b.obj.metadata.uid}`}>
                <path d={ortho({ x: x + w / 2, y: Y_DEP + DEP_H }, { x: tip.x, y: tip.y - ARROW }, (Y_DEP + DEP_H + b.y) / 2)} className={cls("cv-wire", h && "is-hot")} />
                <path d={arrowDown(tip)} className={cls("cv-arrow", h && "is-hot")} />
              </g>
            );
          }),
        )}
        {pods.map((p) => {
          const own = ownerOf(p);
          if (!own) return null;
          const t = podTop(p.metadata.uid);
          if (!t) return null;
          const child = childBox.get(own.uid);
          const card = child ? undefined : cardByUid.get(own.uid);
          if (!child && !card) return null;
          const from = child ? { x: child.x + RS_W / 2, y: child.y + RS_H } : { x: card!.x + card!.w / 2, y: Y_DEP + DEP_H };
          const h = (child ? hotChild(own.uid) : hotCard(own.uid)) || selPod?.metadata.uid === p.metadata.uid;
          const hue = hueFor(child ? child.obj.metadata.name : card!.obj.metadata.name);
          // Pending Pods sit in the scheduler queue on the left: a curve reads better than a right-angle route there.
          // Each owner turns on its own lane so different workloads' wires don't merge into one line.
          const d = p.spec?.nodeName ? ortho(from, t, Y_NODES - 14 - (lane.get(own.uid) ?? 0) * 7) : curve(from, t).d;
          return <path key={`r${p.metadata.uid}`} d={d} fill="none" stroke={`hsl(${hue} 55% ${h ? 45 : 72}%)`} strokeOpacity={h ? 0.95 : 0.55} strokeWidth={h ? 1.6 : 1.1} className="cv-edge" />;
        })}
        {[...svcEdges.values()].map((e) => {
          const h = selSvc?.metadata.uid === e.svcUid || selPod?.metadata.uid === e.podUid;
          const key = `${e.svcUid}/${e.podUid}`;
          return (
            <g key={`s${key}`} className="cv-edge">
              <path d={e.d} className={cls("cv-svc-wire", h && "is-hot", !e.ready && "is-notready")} />
              {e.ready && flowing.has(key) && <path d={e.d} className="cv-flow" />}
            </g>
          );
        })}
        {[...ingEdges.values()].map((e) => {
          const h = selIng?.metadata.uid === e.ingUid || selSvc?.metadata.uid === e.svcUid;
          return <path key={`i${e.ingUid}${e.svcUid}`} d={e.d} fill="none" stroke={h ? "var(--cv-line-3)" : "var(--cv-line)"} strokeWidth={h ? 1.8 : 1.25} className="cv-edge" />;
        })}
        {sideEdges.map((e) => (
          <path key={e.key} d={e.d} fill="none" stroke="var(--cv-line-3)" strokeOpacity={0.7} strokeWidth={1.3} strokeDasharray="5 4" />
        ))}
      </g>

      {/* ------------ controllers */}
      {topCards.map(({ kind, obj, x, w }) => {
        const ns = obj.metadata.namespace;
        const name = obj.metadata.name;
        const sel = isSel(kind, name, ns);
        const card = cardSummary(c, kind, obj);
        const hpa = kind === "deployment" ? hpaFor("Deployment", name, ns) : kind === "statefulset" ? hpaFor("StatefulSet", name, ns) : undefined;
        const dropKey = kind === "deployment" ? `deployment:${ns}/${name}` : undefined;
        const dragItem: DragItem | undefined = kind === "deployment" ? { kind: "object", type: "deployment", ns: ns ?? "default", name, label: `Deployment ${name}` } : undefined;
        const tagW = tagWidth(card.status);
        return (
          <g
            key={obj.metadata.uid}
            data-kind={kind}
            className={cls("cv-obj cv-fade cursor-pointer", card.tone === "bad" && "is-bad", card.tone === "warn" && "is-warn", hotCard(obj.metadata.uid) && !sel && "is-hot")}
            opacity={kind === "deployment" && dragged("deployment", ns, name) ? 0.45 : 1}
            {...(dropKey ? dnd(dropKey, dragItem) : {})}
            onClick={click({ kind, ns, name })}
            {...act({ kind, ns, name }, `${card.kindLabel} ${name}, ${card.status}`)}
          >
            <rect className="cv-body" x={x} y={Y_DEP} width={w} height={DEP_H} rx={R} />
            {sel && <rect className="cv-ring" x={x - 3.5} y={Y_DEP - 3.5} width={w + 7} height={DEP_H + 7} rx={R} />}
            {dropKey && hl(dropKey) && <rect x={x - 3} y={Y_DEP - 3} width={w + 6} height={DEP_H + 6} rx={R} fill="#172340" fillOpacity={0.04} stroke="#172340" strokeWidth={2} strokeDasharray="6 4" />}
            <KindIcon kind={kind} x={x + 12} y={Y_DEP + 16} />
            <text x={x + 48} y={detail ? Y_DEP + 26 : Y_DEP + 34} className="cv-title" style={{ fontSize: 13.5 }}>
              {fit(nsPrefix(ns) + name, w - 48 - (detail ? tagW + 20 : 14), 13.5, { weight: 600 })}
              {<title>{nsPrefix(ns) + name}</title>}
            </text>
            {detail > 0 && (
              <text x={x + 48} y={Y_DEP + 43} className="cv-sub" style={{ fontSize: 11 }}>
                {fit(`${card.kindLabel} · ${card.sub}`, w - 60, 11)}
              </text>
            )}
            {detail > 0 && <Tag x={x + w - 12} y={Y_DEP + 11} anchor="end" cat={card.tone} text={card.status} />}
            {hpa && detail > 1 && <Tag x={x + w / 2} y={Y_DEP + DEP_H + 7} anchor="middle" cat="hpa" text={`HPA ${hpa.spec?.minReplicas ?? 1}–${hpa.spec?.maxReplicas} · ${hpaTarget(hpa)}`} />}
          </g>
        );
      })}
      {[...childBox.values()].map(({ kind, obj, x, y }) => {
        const hue = hueFor(obj.metadata.name);
        const isRs = kind === "replicaset";
        const rs = obj as ReplicaSet;
        const job = obj as Job;
        const want = isRs ? (rs.spec?.replicas ?? 0) : (job.spec?.completions ?? 1) ?? 1;
        const retired = isRs ? want === 0 : jobDone(job);
        const rev = isRs ? rs.metadata.annotations?.["deployment.kubernetes.io/revision"] : undefined;
        const sel = isSel(kind, obj.metadata.name, obj.metadata.namespace);
        const failed = !isRs && jobFailedFlag(job);
        const right = isRs ? `${rs.status?.readyReplicas ?? 0}/${want}` : failed ? "failed" : `${job.status?.succeeded ?? 0}/${want}`;
        const label = isRs ? `ReplicaSet ${obj.metadata.name}, ${rs.status?.readyReplicas ?? 0} of ${want} ready` : `Job ${obj.metadata.name}, ${job.status?.succeeded ?? 0} of ${want} succeeded`;
        const rightW = textWidth(right, 12, { mono: true, weight: 600 });
        return (
          <g key={obj.metadata.uid} data-kind={kind} className={cls("cv-obj cv-fade cursor-pointer", failed && "is-bad", hotChild(obj.metadata.uid) && !sel && "is-hot")} opacity={retired ? 0.55 : 1} style={{ transform: `translate(${x}px, ${y}px)`, transition: "transform .6s cubic-bezier(.22,1,.36,1)" }} onClick={click({ kind, ns: obj.metadata.namespace, name: obj.metadata.name })} {...act({ kind, ns: obj.metadata.namespace, name: obj.metadata.name }, label)}>
            <rect className="cv-body" width={RS_W} height={RS_H} rx={R} />
            {sel && <rect className="cv-ring" x={-3.5} y={-3.5} width={RS_W + 7} height={RS_H + 7} rx={R} />}
            <rect x={0} y={10} width={3} height={RS_H - 20} fill={`hsl(${hue} 65% 55%)`} />
            <text x={14} y={detail ? 21 : 29} className="cv-title cv-mono" style={{ fontSize: 11.5 }}>
              {fit(obj.metadata.name, RS_W - 14 - rightW - 20, 11.5, { mono: true, weight: 600, keepEnd: true })}
              <title>{obj.metadata.name}</title>
            </text>
            {detail > 0 && (
              <text x={14} y={37} className="cv-sub" style={{ fontSize: 10.5 }}>
                {isRs ? `ReplicaSet${rev ? ` · rev ${rev}` : ""}` : `Job · ${jobDone(job) ? "complete" : failed ? "failed" : "running"}`}
              </text>
            )}
            <text x={RS_W - 12} y={30} textAnchor="end" className={cls("cv-mono", failed ? "fill-red-600" : "cv-dim")} style={{ fontSize: 12, fontWeight: 600 }}>
              {right}
            </text>
          </g>
        );
      })}

      {/* ------------ scheduler queue (only while Pods wait for a Node) */}
      {pending.length > 0 && (
        <g className="cv-fade">
          <rect x={qx} y={Y_NODES} width={QUEUE_W} height={queueH} rx={R} fill="#fffbeb" stroke="#f6d38a" strokeDasharray="5 4" />
          <text x={qx + QUEUE_W / 2} y={Y_NODES + 24} textAnchor="middle" className="cv-title" style={{ fontSize: 12 }}>
            Scheduler
          </text>
          <text x={qx + QUEUE_W / 2} y={Y_NODES + 40} textAnchor="middle" className="cv-sub" style={{ fontSize: 10.5 }}>
            {pending.length} waiting for a node
          </text>
        </g>
      )}

      {/* ------------ nodes */}
      {nodeBoxes.map(({ node, x, y, h, w: NW, collapsed }) => {
        const name = node.metadata.name;
        const rt = c.state.nodes[name];
        const ready = node.status?.conditions.find((q) => q.type === "Ready")?.status === "True";
        const down = !!rt && !rt.up;
        const isCp = node === cp;
        const cordoned = !!node.spec?.unschedulable;
        const userTaints = (node.spec?.taints ?? []).filter((t) => !t.key.startsWith("node.kubernetes.io/") && !t.key.startsWith("node-role.kubernetes.io/"));
        const status = down && ready ? "no heartbeat" : ready ? (cordoned ? "cordoned" : "Ready") : "NotReady";
        const tone: Tone = down ? "bad" : !ready || cordoned ? "warn" : "ok";
        const sel = isSel("node", name);
        const onNode = nodePods.get(name) ?? [];
        const used = onNode.filter((p) => !p.metadata.deletionTimestamp).length;
        // Requested resources (what the scheduler counts) and live usage from metrics-server.
        const alloc = nodeAllocatable(node);
        const allOnNode = c.list<Pod>("Pod").filter((p) => p.spec?.nodeName === name && p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed");
        const req = allOnNode.reduce((a, p) => { const r = podRequests(p.spec); return { cpu: a.cpu + r.cpu, memory: a.memory + r.memory }; }, { cpu: 0, memory: 0 });
        const use = metrics.nodes[name];
        const showBars = req.cpu > 0 || !!use;
        const barX = x + 48;
        const barW = NW - 48 - 14;
        const tagW = tagWidth(status);
        return (
          <g key={node.metadata.uid} data-kind={isCp ? "cp" : "node"} className={cls("cv-obj cv-fade cursor-pointer", down && "is-down", !down && tone === "warn" && "is-warn")} {...dnd(`node:${name}`)} onClick={click({ kind: "node", name })} {...act({ kind: "node", name }, `Node ${name}, ${status}, ${used} pods${showBars ? `, CPU requested ${Math.round((req.cpu / alloc.cpu) * 100)}%` : ""}`)}>
            <title>{`${name} · ${node.status?.addresses[0].address}`}</title>
            <rect className="cv-body" x={x} y={y} width={NW} height={h} rx={R} />
            {sel && <rect className="cv-ring" x={x - 3.5} y={y - 3.5} width={NW + 7} height={h + 7} rx={R} />}
            {cordoned && <rect x={x} y={y} width={NW} height={h} rx={R} fill="url(#cv-hatch)" pointerEvents="none" />}
            {hl(`node:${name}`) && <rect x={x - 4} y={y - 4} width={NW + 8} height={h + 8} rx={R} fill="#172340" fillOpacity={0.04} stroke="#172340" strokeWidth={2} strokeDasharray="7 5" pointerEvents="none" />}
            <line className="cv-hair" x1={x + 1} x2={x + NW - 1} y1={y + HEAD} y2={y + HEAD} />
            <KindIcon kind={isCp ? "cp" : "node"} x={x + 12} y={y + 16} />
            <text x={x + 48} y={y + 29} className="cv-title" style={{ fontSize: 14 }}>
              {fit(name, NW - 48 - tagW - 22, 14, { weight: 600 })}
            </text>
            {detail > 0 && (
              <text x={x + 48} y={y + 45} className="cv-sub" style={{ fontSize: 11 }}>
                {fit(`${isCp ? "control plane" : "worker"}${collapsed ? "" : ` · ${used} pod${used === 1 ? "" : "s"}`}${userTaints.length ? ` · tainted ${userTaints.map((t) => t.key).join(",")}` : ""}`, NW - 60 - (showBars && detail > 1 && !collapsed ? 0 : 0), 11)}
              </text>
            )}
            <Tag x={x + NW - 12} y={y + 18} anchor="end" cat={tone} text={status} />
            {showBars && detail > 1 && !collapsed && (
              <g pointerEvents="none">
                <title>{`Requested: CPU ${req.cpu}m of ${alloc.cpu}m, memory ${Math.round(req.memory / 2 ** 20)}Mi of ${Math.round(alloc.memory / 2 ** 20)}Mi${use ? `\nUsing now: CPU ${use.cpu}m, memory ${Math.round(use.memory / 2 ** 20)}Mi` : ""}`}</title>
                <Bar x={barX} y={y + 52} w={barW / 2 - 6} frac={req.cpu / alloc.cpu} usage={use ? use.cpu / alloc.cpu : undefined} label="cpu" />
                <Bar x={barX + barW / 2 + 6} y={y + 52} w={barW / 2 - 6} frac={req.memory / alloc.memory} usage={use ? use.memory / alloc.memory : undefined} label="mem" />
              </g>
            )}
            {!collapsed && used === 0 && !isCp && detail > 0 && (
              <text x={x + NW / 2} y={y + HEAD + PAD + CHIP_H / 2 + 4} textAnchor="middle" className="cv-sub" style={{ fontSize: 11, opacity: 0.7 }} pointerEvents="none">
                no pods
              </text>
            )}
            {collapsed && (
              <g pointerEvents="none">
                <title>kube-apiserver, etcd, kube-scheduler and kube-controller-manager run here. Turn on System pods to see them.</title>
                <rect x={x + PAD} y={y + HEAD + 8} width={NW - PAD * 2} height={CP_BODY - 16} rx={R} className="cv-tint" />
                <Mark cat={down ? "stale" : "ok"} x={x + PAD + 13} y={y + HEAD + CP_BODY / 2} />
                <text x={x + PAD + 24} y={y + HEAD + CP_BODY / 2 + 4} className="cv-ink" style={{ fontSize: 11, fontWeight: 500 }}>
                  4 system components
                </text>
              </g>
            )}
            {isCp && !showSystem && !collapsed && (
              <g pointerEvents="none">
                {["kube-apiserver", "etcd", "scheduler", "controller-mgr"].map((comp, j) => {
                  const cw = (NW - PAD * 2 - CHIP_GAP) / 2;
                  const px = x + PAD + (j % 2) * (cw + CHIP_GAP);
                  const py = y + HEAD + PAD + Math.floor(j / 2) * (CHIP_H + CHIP_GAP);
                  return (
                    <g key={comp}>
                      <rect x={px} y={py} width={cw} height={CHIP_H} rx={R} className="cv-tint" />
                      <Mark cat={down ? "stale" : "ok"} x={px + 14} y={py + CHIP_H / 2} />
                      <text x={px + 26} y={py + CHIP_H / 2 + 4} className="cv-ink cv-mono" style={{ fontSize: 11.5, fontWeight: 600 }}>
                        {fit(comp, cw - 32, 11.5, { mono: true, weight: 600 })}
                      </text>
                    </g>
                  );
                })}
              </g>
            )}
            {down && detail > 0 && (
              <text x={x + NW / 2} y={y + h - 10} textAnchor="middle" className="fill-red-500" style={{ fontSize: 10.5, fontWeight: 500 }}>
                powered off · kubelet not reporting
              </text>
            )}
          </g>
        );
      })}

      {/* ------------ policy → selected Pods, above the Node cards so neighbours don't hide them */}
      <g fill="none" pointerEvents="none">
        {polEdges.map((e) => (
          <path key={e.key} d={e.d} stroke="#e11d48" strokeOpacity={0.45} strokeWidth={1.2} strokeDasharray="4 4" />
        ))}
      </g>

      {/* ------------ pods */}
      {[...podPos.values()].map(({ x, y, pod }) => {
        const nodeName = pod.spec?.nodeName;
        const stale = !!nodeName && c.state.nodes[nodeName]?.up === false;
        const cat: PodCategory = stale && !pod.metadata.deletionTimestamp ? "stale" : podCategory(pod);
        const own = ownerOf(pod);
        const hue = hueFor(own?.name ?? pod.metadata.name);
        const base = own?.kind === "ReplicaSet" ? own.name : own?.kind === "StatefulSet" ? undefined : own?.name;
        const short = base && pod.metadata.name.startsWith(base) ? pod.metadata.name.slice(base.length + 1) || pod.metadata.name : pod.metadata.name;
        const sel = isSel("pod", pod.metadata.name, pod.metadata.namespace);
        const st = podStatus(pod);
        const ready = pod.status?.conditions?.find((q) => q.type === "Ready")?.status === "True";
        const status = CAT[cat].label ?? (st === "Running" && !ready ? "not ready" : st);
        const r = restarts(pod);
        const isolated = isIsolated(c, pod, "Ingress") || isIsolated(c, pod, "Egress");
        const hasVol = (pod.spec?.volumes ?? []).some((v) => v.persistentVolumeClaim);
        const m = metrics.pods[pod.metadata.uid];
        const icons = (isolated ? 13 : 0) + (hasVol ? 13 : 0);
        return (
          <g
            key={pod.metadata.uid}
            data-kind="pod"
            className={cls("cv-obj cv-pod cursor-pointer", cat === "gone" && "cv-gone", cat === "bad" && "is-bad", cat === "starting" && "is-warn")}
            style={{ transform: `translate(${x}px, ${y}px)` }}
            opacity={dragged("pod", pod.metadata.namespace, pod.metadata.name) ? 0.35 : undefined}
            {...dnd(`pod:${pod.metadata.namespace}/${pod.metadata.name}`, { kind: "object", type: "pod", ns: pod.metadata.namespace ?? "default", name: pod.metadata.name, label: `Pod ${short}` })}
            onClick={click({ kind: "pod", ns: pod.metadata.namespace, name: pod.metadata.name })}
            {...act({ kind: "pod", ns: pod.metadata.namespace, name: pod.metadata.name }, `Pod ${pod.metadata.name}, ${status}${nodeName ? `, on ${nodeName}` : ", not scheduled"}${r ? `, ${r} restarts` : ""}${isolated ? ", isolated by a NetworkPolicy" : ""}`)}
          >
            <title>{`${pod.metadata.name}\n${st}${pod.status?.podIP ? ` · ${pod.status.podIP}` : ""}${m ? `\nCPU ${m.cpu}m · memory ${Math.round(m.memory / 2 ** 20)}Mi` : ""}${isolated ? "\nIsolated by a NetworkPolicy" : ""}`}</title>
            {hl(`pod:${pod.metadata.namespace}/${pod.metadata.name}`) && <rect x={-3} y={-3} width={CHIP_W + 6} height={CHIP_H + 6} rx={R} fill="#dc2626" fillOpacity={0.08} stroke="#dc2626" strokeWidth={2} strokeDasharray="5 3" />}
            <rect className="cv-body" width={CHIP_W} height={CHIP_H} rx={R} strokeDasharray={cat === "starting" ? "4 3" : undefined} />
            {sel && <rect className="cv-ring" x={-3.5} y={-3.5} width={CHIP_W + 7} height={CHIP_H + 7} rx={R} />}
            <rect x={0} y={9} width={3} height={CHIP_H - 18} fill={cat === "stale" || cat === "gone" ? "#cbd5e1" : `hsl(${hue} 65% 55%)`} />
            {detail < 2 ? (
              <>
                <Mark cat={cat} x={15} y={CHIP_H / 2} r={4.5} />
                {detail > 0 && (
                  <text x={26} y={CHIP_H / 2 + 4} className="cv-title cv-mono" style={{ fontSize: 11 }}>
                    {fit(short, CHIP_W - 32, 11, { mono: true, weight: 600 })}
                  </text>
                )}
              </>
            ) : (
              <>
                <text x={11} y={19} className="cv-title cv-mono" style={{ fontSize: 11 }}>
                  {fit(short, CHIP_W - 11 - (r > 0 ? 26 : 8), 11, { mono: true, weight: 600 })}
                </text>
                <Mark cat={cat} x={14} y={33} r={3} />
                <text x={21} y={36.5} fill={CAT[cat].text} style={{ fontSize: 9.5, fontWeight: 500 }}>
                  {fit(status, CHIP_W - 25 - icons, 9.5, { weight: 500 })}
                </text>
                {m && m.cpu > 0 && <rect x={6} y={CHIP_H - 4} width={Math.max(2, Math.min(1, m.cpu / Math.max(1, podRequests(pod.spec).cpu || 1000)) * (CHIP_W - 12))} height={2} fill="var(--cv-dim)" opacity={0.55} />}
                {isolated && <Shield x={CHIP_W - 14} y={CHIP_H - 16} />}
                {hasVol && <Cylinder x={CHIP_W - (isolated ? 27 : 14)} y={CHIP_H - 16} />}
              </>
            )}
            {r > 0 && detail > 0 && (
              <g>
                <rect x={CHIP_W - 22} y={6} width={17} height={14} fill="#fee2e2" />
                <text x={CHIP_W - 13.5} y={16} textAnchor="middle" fill="#b91c1c" style={{ fontSize: 9, fontWeight: 700 }}>
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
        const sel = isSel("service", s.metadata.name, s.metadata.namespace);
        const hot = [...ingEdges.values()].some((e) => e.svcUid === s.metadata.uid && selIng?.metadata.uid === e.ingUid);
        const port = s.spec?.ports?.[0];
        const headless = s.spec?.clusterIP === "None";
        const lbIp = s.status?.loadBalancer?.ingress?.[0]?.ip;
        const sub = headless ? `headless · DNS → Pod IPs` : `${s.spec?.clusterIP}:${port?.port}${port?.nodePort ? ` · node :${port.nodePort}` : ""}${s.spec?.type === "LoadBalancer" ? ` · ${lbIp ?? "<pending>"}` : ""}`;
        const tag = `${ready} ep`;
        return (
          <g key={s.metadata.uid} data-kind="service" className={cls("cv-obj cv-fade cursor-pointer", !ready && "is-warn", hot && "is-hot")} opacity={dragged("service", s.metadata.namespace, s.metadata.name) ? 0.45 : 1} {...dnd(`service:${s.metadata.namespace}/${s.metadata.name}`, { kind: "object", type: "service", ns: s.metadata.namespace ?? "default", name: s.metadata.name, label: `Service ${s.metadata.name}` })} onClick={click({ kind: "service", ns: s.metadata.namespace, name: s.metadata.name })} {...act({ kind: "service", ns: s.metadata.namespace, name: s.metadata.name }, `Service ${s.metadata.name}, ${headless ? "headless, " : ""}${ready} endpoints`)}>
            <rect className="cv-body" x={x} y={y} width={SVC_W} height={SVC_H} rx={R} />
            {sel && <rect className="cv-ring" x={x - 3.5} y={y - 3.5} width={SVC_W + 7} height={SVC_H + 7} rx={R} />}
            <KindIcon kind="service" x={x + 12} y={y + 19} />
            <text x={x + 48} y={y + 28} className="cv-title" style={{ fontSize: 13.5 }}>
              {fit(nsPrefix(s.metadata.namespace) + s.metadata.name, SVC_W - 48 - tagWidth(tag) - 20, 13.5, { weight: 600 })}
            </text>
            {detail > 0 && (
              <text x={x + 48} y={y + 46} className="cv-sub cv-mono" style={{ fontSize: 10.5 }}>
                {fit(sub, SVC_W - 60, 10.5, { mono: true })}
              </text>
            )}
            <Tag x={x + SVC_W - 12} y={y + 14} anchor="end" cat={ready ? "info" : "bad"} text={tag} />
          </g>
        );
      })}

      {/* ------------ ingresses */}
      {ingBoxes.map(({ ing, x, y }) => {
        const sel = isSel("ingress", ing.metadata.name, ing.metadata.namespace);
        const rules = (ing.spec?.rules ?? []).flatMap((r) => (r.http?.paths ?? []).map((p) => `${r.host ?? "*"}${p.path ?? "/"} → ${p.backend.service?.name ?? "?"}`));
        const addr = ing.status?.loadBalancer?.ingress?.[0]?.hostname ?? ing.status?.loadBalancer?.ingress?.[0]?.ip;
        const tag = addr ?? "no address";
        return (
          <g key={ing.metadata.uid} data-kind="ingress" className={cls("cv-obj cv-fade cursor-pointer", !addr && "is-warn")} onClick={click({ kind: "ingress", ns: ing.metadata.namespace, name: ing.metadata.name })} {...act({ kind: "ingress", ns: ing.metadata.namespace, name: ing.metadata.name }, `Ingress ${ing.metadata.name}, ${rules.length} rules${addr ? `, address ${addr}` : ", no address yet"}`)}>
            <rect className="cv-body" x={x} y={y} width={ING_W} height={ING_H} rx={R} />
            {sel && <rect className="cv-ring" x={x - 3.5} y={y - 3.5} width={ING_W + 7} height={ING_H + 7} rx={R} />}
            <KindIcon kind="ingress" x={x + 12} y={y + 19} />
            <text x={x + 48} y={y + 28} className="cv-title" style={{ fontSize: 13.5 }}>
              {fit(nsPrefix(ing.metadata.namespace) + ing.metadata.name, ING_W - 48 - tagWidth(tag) - 20, 13.5, { weight: 600 })}
            </text>
            {detail > 0 && (
              <text x={x + 48} y={y + 46} className="cv-sub cv-mono" style={{ fontSize: 10.5 }}>
                {fit(rules[0] ? `${rules[0]}${rules.length > 1 ? ` +${rules.length - 1}` : ""}` : "default backend", ING_W - 60, 10.5, { mono: true })}
              </text>
            )}
            <Tag x={x + ING_W - 12} y={y + 14} anchor="end" cat={addr ? "ingress" : "warn"} text={tag} />
          </g>
        );
      })}

      {/* ------------ config, storage, policies, access */}
      {sideItems.map((it) => {
        const sel = isSel(it.kind, it.name, it.ns);
        return (
          <g key={it.uid} data-kind={it.kind} className={cls("cv-obj cv-fade cursor-pointer", it.warn && "is-warn")} onClick={click({ kind: it.kind, ns: it.ns, name: it.name })} {...act({ kind: it.kind, ns: it.ns, name: it.name }, `${it.sub.split(" · ")[0]} ${it.name}, ${it.sub}`)}>
            <rect className="cv-body" x={sideX} y={it.y} width={SIDE_W} height={SIDE_H} rx={R} />
            {sel && <rect className="cv-ring" x={sideX - 3.5} y={it.y - 3.5} width={SIDE_W + 7} height={SIDE_H + 7} rx={R} />}
            <KindGlyph kind={it.kind} x={sideX + 10} y={it.y + 12} size={16} />
            <text x={sideX + 34} y={detail ? it.y + 17 : it.y + 24} className="cv-title cv-mono" style={{ fontSize: 11.5 }}>
              {fit(it.title, SIDE_W - 42, 11.5, { mono: true, weight: 600 })}
            </text>
            {detail > 0 && (
              <text x={sideX + 34} y={it.y + 31} className="cv-sub" style={{ fontSize: 10 }}>
                {fit(it.sub, SIDE_W - 42, 10)}
              </text>
            )}
          </g>
        );
      })}

      {/* ------------ traffic */}
      <g pointerEvents="none">
        {packets.map((p) => {
          const t0 = Math.min(1, (now - p.born) / PACKET_MS);
          const t = t0 < 0.5 ? 2 * t0 * t0 : 1 - (-2 * t0 + 2) ** 2 / 2;
          const stop = p.ok ? 1 : 0.82;
          let pt: Pt | undefined;
          const se = p.serviceUid ? svcEdges.get(`${p.serviceUid}/${p.podUid}`) : undefined;
          const ie = p.ingressUid && p.serviceUid ? ingEdges.get(`${p.ingressUid}/${p.serviceUid}`) : undefined;
          if (ie && se) {
            // Ingress → Service, then Service → Pod.
            pt = t < 0.5 ? onCubic(ie.a, ie.c1, ie.c2, ie.b, t * 2) : onCubic(se.a, se.c1, se.c2, se.b, Math.min((t - 0.5) * 2, stop));
          } else if (se) pt = onCubic(se.a, se.c1, se.c2, se.b, Math.min(t, stop));
          else if (p.fromUid && podPos.has(p.fromUid) && podPos.has(p.podUid) && p.fromUid !== p.podUid) {
            const a = podTop(p.fromUid)!;
            const b = podTop(p.podUid)!;
            const mid = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 50 };
            const q = Math.min(t, stop);
            pt = lerp(lerp(a, mid, q), lerp(mid, b, q), q);
          } else {
            const b = podBottom(p.podUid);
            if (b) pt = { x: b.x, y: b.y + 60 * (1 - Math.min(t, stop)) };
          }
          if (!pt) return null;
          const fade = t0 > 0.85 ? (1 - t0) / 0.15 : 1;
          return (
            <g key={p.id} opacity={fade} className="cv-packet" aria-hidden="true">
              <circle cx={pt.x} cy={pt.y} r={3.5} fill={p.ok ? "var(--cv-flow)" : "var(--cv-danger)"} stroke="var(--cv-bg)" strokeWidth={1.5} />
              {p.blocked && t0 > 0.5 && <path d={`M${pt.x - 4},${pt.y - 12} l8,8 M${pt.x + 4},${pt.y - 12} l-8,8`} stroke="var(--cv-danger)" strokeWidth={1.8} strokeLinecap="round" />}
            </g>
          );
        })}
      </g>

      <defs>
        <pattern id="cv-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="3" height="8" fill="#f59e0b" opacity="0.12" />
        </pattern>
      </defs>
    </PanZoom>
  );
}

function policySelects(c: Cluster, ns: string, name: string, p: Pod): boolean {
  const np = c.raw("NetworkPolicy", ns, name) as unknown as NetworkPolicy | undefined;
  if (!np || p.metadata.namespace !== ns) return false;
  const want = np.spec?.podSelector?.matchLabels ?? {};
  return Object.entries(want).every(([a, b]) => p.metadata.labels?.[a] === b);
}

const jobDone = (j: Job) => (j.status?.conditions ?? []).some((q) => q.type === "Complete" && q.status === "True");
const jobFailedFlag = (j: Job) => (j.status?.conditions ?? []).some((q) => q.type === "Failed" && q.status === "True");

function hpaTarget(h: HorizontalPodAutoscaler): string {
  const cur = h.status?.currentMetrics?.[0]?.resource?.current?.averageUtilization;
  const tgt = h.spec?.metrics?.[0]?.resource?.target.averageUtilization ?? 80;
  return `cpu ${cur !== undefined ? `${cur}%` : "?"}/${tgt}%`;
}

function cardSummary(c: Cluster, kind: TopKind, obj: TopCard["obj"]): { kindLabel: string; sub: string; status: string; tone: Tone } {
  switch (kind) {
    case "deployment": {
      const d = obj as Deployment;
      const want = d.spec?.replicas ?? 1;
      const ready = d.status?.readyReplicas ?? 0;
      const rolling = isRollingOut(c, d);
      return { kindLabel: "Deployment", sub: (d.spec?.template?.spec?.containers?.[0]?.image ?? ""), status: rolling ? `rolling out · ${ready}/${want}` : `${ready}/${want} ready`, tone: ready === want && !rolling ? "ok" : "warn" };
    }
    case "statefulset": {
      const s = obj as StatefulSet;
      const want = s.spec?.replicas ?? 1;
      const ready = s.status?.readyReplicas ?? 0;
      return { kindLabel: "StatefulSet", sub: `${(s.spec?.template?.spec?.containers?.[0]?.image ?? "")}${s.spec?.serviceName ? ` · svc ${s.spec.serviceName}` : ""}`, status: `${ready}/${want} ready`, tone: ready === want ? "ok" : "warn" };
    }
    case "daemonset": {
      const d = obj as DaemonSet;
      const want = d.status?.desiredNumberScheduled ?? 0;
      const ready = d.status?.numberReady ?? 0;
      return { kindLabel: "DaemonSet", sub: `${(d.spec?.template?.spec?.containers?.[0]?.image ?? "")} · one per node`, status: `${ready}/${want} nodes`, tone: ready === want ? "ok" : "warn" };
    }
    case "cronjob": {
      const cj = obj as CronJob;
      const active = cj.status?.active?.length ?? 0;
      return { kindLabel: "CronJob", sub: cj.spec!.schedule, status: cj.spec?.suspend ? "suspended" : active ? `${active} running` : "waiting", tone: cj.spec?.suspend ? "muted" : active ? "warn" : "ok" };
    }
    case "job": {
      const j = obj as Job;
      const want = j.spec?.completions ?? 1;
      const done = j.status?.succeeded ?? 0;
      return { kindLabel: "Job", sub: (j.spec?.template?.spec?.containers?.[0]?.image ?? ""), status: jobFailedFlag(j) ? "failed" : jobDone(j) ? `complete · ${done}/${want}` : `running · ${done}/${want}`, tone: jobFailedFlag(j) ? "bad" : jobDone(j) ? "ok" : "warn" };
    }
  }
}

function Bar({ x, y, w, frac, usage, label }: { x: number; y: number; w: number; frac: number; usage?: number; label: string }) {
  const lw = 24;
  const f = Math.min(1, frac);
  return (
    <g>
      <text x={x} y={y + 4} className="cv-sub" style={{ fontSize: 9 }}>
        {label}
      </text>
      <rect x={x + lw} y={y} width={w - lw} height={4} fill="var(--cv-hair)" />
      <rect x={x + lw} y={y} width={(w - lw) * f} height={4} fill={frac > 0.9 ? "var(--cv-warn)" : "var(--cv-line-2)"} />
      {usage !== undefined && <rect x={x + lw + (w - lw) * Math.min(1, usage) - 1} y={y - 1.5} width={2} height={7} fill="var(--cv-text)" />}
    </g>
  );
}

function Shield({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path d="M5 0.5l4.5 1.6v3.3c0 2.8-2 4.6-4.5 5.6C2.5 10 0.5 8.2 0.5 5.4V2.1z" fill="#ffe4e6" stroke="#e11d48" strokeWidth={1} />
    </g>
  );
}

function Cylinder({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`} fill="#dcfce7" stroke="#16a34a" strokeWidth={1}>
      <path d="M0.5 2v7c0 1 2 1.6 4.5 1.6S9.5 10 9.5 9V2" />
      <ellipse cx={5} cy={2} rx={4.5} ry={1.5} />
    </g>
  );
}

type Tone = "ok" | "warn" | "bad" | "muted";
type TagCat = Tone | "info" | "hpa" | "ingress";
const TAG_FS = 10.5;
const tagWidth = (text: string) => textWidth(text, TAG_FS, { weight: 500 }) + 24;

/** Health mark: colour AND shape, so it reads without colour vision. Disc ok, ring starting, square failing. */
function Mark({ cat, x, y, r = 3.5 }: { cat: PodCategory | TagCat; x: number; y: number; r?: number }) {
  if (cat === "bad") return <rect x={x - r * 0.9} y={y - r * 0.9} width={r * 1.8} height={r * 1.8} rx={0.8} className="cv-mark-bad cv-blink" />;
  if (cat === "starting" || cat === "warn") return <circle cx={x} cy={y} r={r - 0.6} className={`cv-mark-starting ${cat === "starting" ? "cv-pulse" : ""}`} />;
  if (cat === "gone" || cat === "stale") return <circle cx={x} cy={y} r={r - 0.6} className={`cv-mark-${cat}`} />;
  const fill = cat === "info" ? "var(--cv-text)" : cat === "hpa" || cat === "ingress" ? "var(--cv-text)" : cat === "done" || cat === "muted" ? "var(--cv-muted)" : "var(--cv-ok)";
  return <circle cx={x} cy={y} r={r} fill={fill} />;
}

/** Status tag: a quiet pill with a health mark. Width is measured, so text never spills. */
function Tag({ x, y, text, cat, anchor = "start" }: { x: number; y: number; text: string; cat: TagCat; anchor?: "start" | "end" | "middle" }) {
  const w = tagWidth(text);
  const h = 19;
  const x0 = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
  return (
    <g pointerEvents="none">
      <rect x={x0} y={y} width={w} height={h} fill="var(--cv-bg)" stroke="var(--cv-line)" />
      <Mark cat={cat} x={x0 + 10} y={y + h / 2} r={3} />
      <text x={x0 + 17} y={y + h / 2 + 3.6} className="cv-dim" style={{ fontSize: TAG_FS, fontWeight: 500 }}>
        {text}
      </text>
    </g>
  );
}

const GLYPH: Record<string, LucideIcon> = {
  deployment: Layers,
  statefulset: Database,
  daemonset: Server,
  cronjob: CalendarClock,
  job: Play,
  node: Server,
  cp: Hexagon,
  service: Network,
  ingress: Globe,
  configmap: FileText,
  secret: KeyRound,
  pvc: HardDrive,
  networkpolicy: ShieldCheck,
  rolebinding: UserCheck,
};

/** A lucide icon drawn straight into the diagram, in the object's kind colour. */
function KindGlyph({ kind, x, y, size = 16 }: { kind: string; x: number; y: number; size?: number }) {
  const G = GLYPH[kind] ?? Layers;
  return (
    <g className="cv-ink" pointerEvents="none">
      <G x={x} y={y} width={size} height={size} strokeWidth={1.75} aria-hidden />
    </g>
  );
}

/** Icon on a tinted tile: the header mark of cards. */
function KindIcon({ kind, x, y }: { kind: string; x: number; y: number }) {
  return (
    <g pointerEvents="none">
      <rect x={x} y={y} width={26} height={26} className="cv-tint" />
      <KindGlyph kind={kind} x={x + 5} y={y + 5} />
    </g>
  );
}
