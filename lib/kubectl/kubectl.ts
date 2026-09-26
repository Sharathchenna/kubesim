// A faithful-enough kubectl for the Simulated Cluster. Parses a command line,
// talks to the Cluster API, and prints output the way real kubectl does.

import YAML from "yaml";
import { ApiError, Cluster, request, rfc3339, parseSelectorString, matchesSelectorString, type AnyObject, type Deployment, type Endpoints, type KubeEvent, type Node, type Pod, type ReplicaSet, type Service } from "@/lib/engine";
import { shellWords } from "@/lib/engine/images";
import { explain } from "./explain";
import * as A from "@/lib/sim/actions";
import { age, podReady, podStatus, restarts } from "@/lib/sim/status";

export interface KubectlContext {
  cluster: Cluster;
  namespace: string;
  /** The Learner's virtual files (Editor buffers, redirected output). */
  files?: Record<string, string>;
}

export interface CommandResult {
  out: string;
  ok: boolean;
  /** A streaming command (get -w, logs -f, rollout status): re-run it live. */
  watch?: string;
  /** Ask the UI to open this file in the Editor (kubectl edit). */
  openFile?: string;
}

// ---------------------------------------------------------------- args

const VALUED = new Set(["-n", "--namespace", "-o", "--output", "-l", "--selector", "-c", "--container", "--image", "--replicas", "--port", "--target-port", "--type", "--grace-period", "--to-revision", "--restart", "--name", "-f", "--filename", "--tail", "--labels"]);

interface Args {
  pos: string[];
  flags: Record<string, string | true>;
  rest: string[]; // after --
}

function parseArgs(words: string[], verb?: string): Args {
  const valued = verb === "logs" ? new Set([...VALUED].filter((f) => f !== "-f")) : VALUED;
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  let rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "--") {
      rest = words.slice(i + 1);
      break;
    }
    if (w.startsWith("-") && w.length > 1) {
      const eq = w.indexOf("=");
      if (eq > 0) flags[w.slice(0, eq)] = w.slice(eq + 1);
      else if (valued.has(w) && i + 1 < words.length) flags[w] = words[++i];
      else if (/^-[a-zA-Z]{2,}$/.test(w)) for (const ch of w.slice(1)) flags[`-${ch}`] = true;
      else flags[w] = true;
    } else pos.push(w);
  }
  return { pos, flags, rest };
}

const flag = (a: Args, ...names: string[]) => {
  for (const n of names) if (a.flags[n] !== undefined) return a.flags[n];
  return undefined;
};

// ---------------------------------------------------------------- resources

interface Kind {
  kind: string;
  plural: string;
  short: string;
  namespaced: boolean;
  group?: string;
}

const KINDS: Kind[] = [
  { kind: "Pod", plural: "pods", short: "pod", namespaced: true },
  { kind: "Deployment", plural: "deployments", short: "deployment", namespaced: true, group: "apps" },
  { kind: "ReplicaSet", plural: "replicasets", short: "replicaset", namespaced: true, group: "apps" },
  { kind: "Service", plural: "services", short: "service", namespaced: true },
  { kind: "Endpoints", plural: "endpoints", short: "endpoints", namespaced: true },
  { kind: "Node", plural: "nodes", short: "node", namespaced: false },
  { kind: "Namespace", plural: "namespaces", short: "namespace", namespaced: false },
  { kind: "Event", plural: "events", short: "event", namespaced: true },
];

const ALIASES: Record<string, string> = {
  po: "Pod", pod: "Pod", pods: "Pod",
  deploy: "Deployment", deployment: "Deployment", deployments: "Deployment",
  rs: "ReplicaSet", replicaset: "ReplicaSet", replicasets: "ReplicaSet",
  svc: "Service", service: "Service", services: "Service",
  ep: "Endpoints", endpoints: "Endpoints",
  no: "Node", node: "Node", nodes: "Node",
  ns: "Namespace", namespace: "Namespace", namespaces: "Namespace",
  ev: "Event", event: "Event", events: "Event",
};

function kindOf(word: string): Kind {
  const k = ALIASES[word.toLowerCase().replace(/\.apps$/, "")];
  if (!k) throw new CmdError(`error: the server doesn't have a resource type "${word}"`);
  return KINDS.find((x) => x.kind === k)!;
}

const ref = (k: Kind, name: string) => `${k.short}${k.group ? `.${k.group}` : ""}/${name}`;

class CmdError extends Error {}

/** Splits "deployment/web" or ["deployment", "web"] into kind + names. */
function targets(pos: string[]): { k: Kind; names: string[] }[] {
  if (pos.length === 0) throw new CmdError("error: You must specify the type of resource to get. Use \"kubectl api-resources\" for a complete list of supported resources.");
  if (pos[0].includes("/")) {
    return pos.map((p) => {
      const [t, n] = p.split("/");
      return { k: kindOf(t), names: [n] };
    });
  }
  return pos[0].split(",").map((t) => ({ k: kindOf(t), names: pos.slice(1) }));
}

// ---------------------------------------------------------------- printing

function baseTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i] + 3))).join("").trimEnd()).join("\n");
}

const TIME_KEYS = /(Timestamp|Time|startedAt|finishedAt|startTime|lastProbeTime)$/;

function toApiShape(o: unknown, key = ""): unknown {
  if (o === null || o === undefined) return o;
  if (typeof o === "number" && TIME_KEYS.test(key)) return rfc3339(o);
  if (Array.isArray(o)) return o.map((x) => toApiShape(x));
  if (typeof o === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = toApiShape(v, k);
    }
    return out;
  }
  return o;
}

function printObjects(ctx: KubectlContext, k: Kind, objs: AnyObject[], output: string | undefined, allNs: boolean, showLabels = false): string {
  const c = ctx.cluster;
  const table = (rows: string[][]) => {
    if (showLabels && k.kind !== "Event") rows = rows.map((r, i) => [...r, i === 0 ? "LABELS" : Object.entries(objs[i - 1]?.metadata.labels ?? {}).map(([a, b]) => `${a}=${b}`).join(",") || "<none>"]);
    return baseTable(rows);
  };
  if (output === "yaml") {
    const shaped = objs.map((o) => toApiShape(o));
    return shaped.length === 1 ? YAML.stringify(shaped[0]).trimEnd() : YAML.stringify({ apiVersion: "v1", kind: "List", items: shaped }).trimEnd();
  }
  if (output === "json") return JSON.stringify(objs.length === 1 ? toApiShape(objs[0]) : { apiVersion: "v1", kind: "List", items: objs.map((o) => toApiShape(o)) }, null, 4);
  if (output === "name") return objs.map((o) => ref(k, o.metadata.name)).join("\n");
  const wide = output === "wide";
  const nsCol = allNs && k.namespaced;
  const pre = (o: AnyObject) => (nsCol ? [o.metadata.namespace ?? ""] : []);
  const head = (...h: string[]) => [...(nsCol ? ["NAMESPACE"] : []), ...h];
  const a = (o: AnyObject) => age(c.now - o.metadata.creationTimestamp);
  switch (k.kind) {
    case "Pod":
      return table([
        head("NAME", "READY", "STATUS", "RESTARTS", "AGE", ...(wide ? ["IP", "NODE"] : [])),
        ...(objs as unknown as Pod[]).map((p) => [...pre(p as unknown as AnyObject), p.metadata.name, podReady(p), podStatus(p), String(restarts(p)), a(p as unknown as AnyObject), ...(wide ? [p.status?.podIP ?? "<none>", p.spec?.nodeName ?? "<none>"] : [])]),
      ]);
    case "Deployment":
      return table([
        head("NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE", ...(wide ? ["CONTAINERS", "IMAGES", "SELECTOR"] : [])),
        ...(objs as unknown as Deployment[]).map((d) => {
          const cs = d.spec!.template.spec.containers;
          return [...pre(d as unknown as AnyObject), d.metadata.name, `${d.status?.readyReplicas ?? 0}/${d.spec?.replicas ?? 1}`, String(d.status?.updatedReplicas ?? 0), String(d.status?.availableReplicas ?? 0), a(d as unknown as AnyObject), ...(wide ? [cs.map((x) => x.name).join(","), cs.map((x) => x.image).join(","), Object.entries(d.spec!.selector.matchLabels ?? {}).map(([x, y]) => `${x}=${y}`).join(",")] : [])];
        }),
      ]);
    case "ReplicaSet":
      return table([
        head("NAME", "DESIRED", "CURRENT", "READY", "AGE", ...(wide ? ["IMAGES"] : [])),
        ...(objs as unknown as ReplicaSet[]).map((r) => [...pre(r as unknown as AnyObject), r.metadata.name, String(r.spec?.replicas ?? 0), String(r.status?.replicas ?? 0), String(r.status?.readyReplicas ?? 0), a(r as unknown as AnyObject), ...(wide ? [r.spec!.template.spec.containers.map((x) => x.image).join(",")] : [])]),
      ]);
    case "Service":
      return table([
        head("NAME", "TYPE", "CLUSTER-IP", "EXTERNAL-IP", "PORT(S)", "AGE", ...(wide ? ["SELECTOR"] : [])),
        ...(objs as unknown as Service[]).map((s) => [
          ...pre(s as unknown as AnyObject),
          s.metadata.name,
          s.spec?.type ?? "ClusterIP",
          s.spec?.clusterIP ?? "",
          "<none>",
          (s.spec?.ports ?? []).map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol ?? "TCP"}`).join(","),
          a(s as unknown as AnyObject),
          ...(wide ? [Object.entries(s.spec?.selector ?? {}).map(([x, y]) => `${x}=${y}`).join(",") || "<none>"] : []),
        ]),
      ]);
    case "Endpoints":
      return table([
        head("NAME", "ENDPOINTS", "AGE"),
        ...(objs as unknown as Endpoints[]).map((e) => {
          const addrs = (e.subsets ?? []).flatMap((s) => (s.addresses ?? []).map((x) => `${x.ip}:${s.ports?.[0]?.port}`));
          return [...pre(e as unknown as AnyObject), e.metadata.name, addrs.length ? addrs.slice(0, 3).join(",") + (addrs.length > 3 ? ` + ${addrs.length - 3} more...` : "") : "<none>", a(e as unknown as AnyObject)];
        }),
      ]);
    case "Node":
      return table([
        ["NAME", "STATUS", "ROLES", "AGE", "VERSION", ...(wide ? ["INTERNAL-IP", "OS-IMAGE"] : [])],
        ...(objs as unknown as Node[]).map((n) => {
          const ready = n.status?.conditions.find((x) => x.type === "Ready")?.status === "True";
          const st = (ready ? "Ready" : "NotReady") + (n.spec?.unschedulable ? ",SchedulingDisabled" : "");
          return [n.metadata.name, st, n.metadata.labels?.["node-role.kubernetes.io/control-plane"] !== undefined ? "control-plane" : "<none>", a(n as unknown as AnyObject), "v1.37.0", ...(wide ? [n.status?.addresses[0].address ?? "", n.status?.nodeInfo.osImage ?? ""] : [])];
        }),
      ]);
    case "Namespace":
      return table([["NAME", "STATUS", "AGE"], ...objs.map((o) => [o.metadata.name, (o.status as { phase: string }).phase, a(o)])]);
    case "Event":
      return table([
        head("LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"),
        ...(objs as unknown as KubeEvent[]).sort((x, y) => x.lastTimestamp - y.lastTimestamp).map((e) => [...pre(e as unknown as AnyObject), age(c.now - e.lastTimestamp), e.type, e.reason, `${e.involvedObject.kind.toLowerCase()}/${e.involvedObject.name}`, e.message]),
      ]);
  }
  return "";
}

// ---------------------------------------------------------------- commands

function nsOf(ctx: KubectlContext, a: Args): string {
  return (flag(a, "-n", "--namespace") as string) || ctx.namespace;
}

function cmdGet(ctx: KubectlContext, a: Args): string {
  const c = ctx.cluster;
  const allNs = !!flag(a, "-A", "--all-namespaces");
  const ns = nsOf(ctx, a);
  const output = flag(a, "-o", "--output") as string | undefined;
  const sel = flag(a, "-l", "--selector") as string | undefined;
  const selector = sel ? parseSelectorString(sel) : undefined;
  if (a.pos[0] === "all") a.pos = ["pods,services,deployments,replicasets"];
  const parts: string[] = [];
  const tgts = targets(a.pos);
  for (const { k, names } of tgts) {
    let objs: AnyObject[];
    if (names.length) {
      objs = names.map((n) => c.get(k.kind, k.namespaced ? ns : undefined, n));
    } else {
      objs = c.list(k.kind, k.namespaced && !allNs ? ns : undefined);
      if (selector) objs = objs.filter((o) => matchesSelectorString(o.metadata.labels, selector));
      if (k.kind === "Event" && !allNs) objs = objs.filter((o) => o.metadata.namespace === ns);
    }
    if (objs.length === 0) {
      if (tgts.length === 1) return k.namespaced && !allNs ? `No resources found in ${ns} namespace.` : "No resources found";
      continue;
    }
    let text = printObjects(ctx, k, objs, output, allNs, !!flag(a, "--show-labels"));
    if (tgts.length > 1 && !output) {
      const idx = allNs && k.namespaced ? 1 : 0;
      text = text
        .split("\n")
        .map((l, i) => {
          if (i === 0) return l;
          const cols = l.split(/(\s{3,})/);
          cols[idx * 2] = ref(k, cols[idx * 2]);
          return cols.join("");
        })
        .join("\n");
    }
    if (k.kind === "Endpoints") text = "Warning: v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice\n" + text;
    parts.push(text);
  }
  return parts.join("\n\n") || `No resources found in ${ns} namespace.`;
}

function labelsStr(l?: Record<string, string>) {
  const e = Object.entries(l ?? {});
  return e.length ? e.map(([k, v]) => `${k}=${v}`).join("\n" + " ".repeat(16)) : "<none>";
}

function eventsBlock(c: Cluster, o: AnyObject): string {
  const evs = c.eventsFor(o);
  if (!evs.length) return "Events:            <none>";
  return "Events:\n" + baseTable([["  Type", "Reason", "Age", "From", "Message"], ["  ----", "------", "----", "----", "-------"], ...evs.map((e) => [`  ${e.type}`, e.reason, age(c.now - e.lastTimestamp) + (e.count > 1 ? ` (x${e.count} over ${age(e.lastTimestamp - e.firstTimestamp)})` : ""), e.source.component, e.message])]);
}

function cmdDescribe(ctx: KubectlContext, a: Args): string {
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  const out: string[] = [];
  for (const { k, names } of targets(a.pos)) {
    const objs = names.length ? names.map((n) => c.get(k.kind, k.namespaced ? ns : undefined, n)) : c.list(k.kind, k.namespaced ? ns : undefined);
    for (const o of objs) {
      const L = (key: string, v: unknown) => `${(key + ":").padEnd(16)}${v}`;
      const lines: string[] = [L("Name", o.metadata.name)];
      if (k.namespaced) lines.push(L("Namespace", o.metadata.namespace));
      if (k.kind === "Pod") {
        const p = o as unknown as Pod;
        const owner = p.metadata.ownerReferences?.find((r) => r.controller);
        lines.push(L("Node", p.spec?.nodeName ? `${p.spec.nodeName}/${p.status?.hostIP ?? ""}` : "<none>"), L("Labels", labelsStr(p.metadata.labels)), L("Status", p.metadata.deletionTimestamp ? "Terminating" : (p.status?.phase ?? "Pending")), L("IP", p.status?.podIP ?? ""), L("Controlled By", owner ? `${owner.kind}/${owner.name}` : "<none>"), "Containers:");
        for (const ct of p.spec!.containers) {
          const st = p.status?.containerStatuses?.find((s) => s.name === ct.name);
          lines.push(`  ${ct.name}:`, `    Image:          ${ct.image}`);
          if (st?.state.running) lines.push(`    State:          Running`, `      Started:      ${rfc3339(st.state.running.startedAt)}`);
          else if (st?.state.waiting) lines.push(`    State:          Waiting`, `      Reason:       ${st.state.waiting.reason}`);
          else if (st?.state.terminated) lines.push(`    State:          Terminated`, `      Reason:       ${st.state.terminated.reason}`, `      Exit Code:    ${st.state.terminated.exitCode}`);
          if (st?.lastState.terminated) lines.push(`    Last State:     Terminated`, `      Reason:       ${st.lastState.terminated.reason}`, `      Exit Code:    ${st.lastState.terminated.exitCode}`);
          lines.push(`    Ready:          ${st?.ready ? "True" : "False"}`, `    Restart Count:  ${st?.restartCount ?? 0}`);
        }
        lines.push("Conditions:", "  Type                        Status", ...(p.status?.conditions ?? []).map((cd) => `  ${cd.type.padEnd(28)}${cd.status}`));
      } else if (k.kind === "Deployment") {
        const d = o as unknown as Deployment;
        const st = d.status ?? {};
        const ru = d.spec?.strategy?.rollingUpdate;
        const rss = c.list<ReplicaSet>("ReplicaSet", ns).filter((r) => r.metadata.ownerReferences?.some((x) => x.uid === d.metadata.uid));
        const newRs = rss.find((r) => r.metadata.annotations?.["deployment.kubernetes.io/revision"] === d.metadata.annotations?.["deployment.kubernetes.io/revision"]);
        lines.push(
          L("Labels", labelsStr(d.metadata.labels)),
          L("Selector", Object.entries(d.spec!.selector.matchLabels ?? {}).map(([x, y]) => `${x}=${y}`).join(",")),
          L("Replicas", `${d.spec?.replicas} desired | ${st.updatedReplicas ?? 0} updated | ${st.replicas ?? 0} total | ${st.availableReplicas ?? 0} available | ${st.unavailableReplicas ?? 0} unavailable`),
          L("StrategyType", d.spec?.strategy?.type),
          ...(ru ? [`RollingUpdateStrategy:  ${ru.maxUnavailable} max unavailable, ${ru.maxSurge} max surge`] : []),
          "Pod Template:",
          ...d.spec!.template.spec.containers.map((ct) => `  ${ct.name}:\n    Image:        ${ct.image}`),
          "Conditions:",
          "  Type           Status  Reason",
          ...(st.conditions ?? []).map((cd) => `  ${cd.type.padEnd(15)}${cd.status.padEnd(8)}${cd.reason}`),
          L("OldReplicaSets", rss.filter((r) => r !== newRs && (r.spec?.replicas ?? 0) > 0).map((r) => `${r.metadata.name} (${r.status?.replicas ?? 0}/${r.spec?.replicas} replicas created)`).join(", ") || "<none>"),
          L("NewReplicaSet", newRs ? `${newRs.metadata.name} (${newRs.status?.replicas ?? 0}/${newRs.spec?.replicas} replicas created)` : "<none>"),
        );
      } else if (k.kind === "Service") {
        const s = o as unknown as Service;
        const ep = c.raw("Endpoints", ns, s.metadata.name) as unknown as Endpoints | undefined;
        const ready = (ep?.subsets ?? []).flatMap((x) => (x.addresses ?? []).map((ad) => `${ad.ip}:${x.ports?.[0]?.port}`));
        lines.push(L("Labels", labelsStr(s.metadata.labels)), L("Selector", Object.entries(s.spec?.selector ?? {}).map(([x, y]) => `${x}=${y}`).join(",") || "<none>"), L("Type", s.spec?.type), L("IP", s.spec?.clusterIP));
        for (const p of s.spec?.ports ?? []) lines.push(L("Port", `${p.name ?? "<unset>"}  ${p.port}/${p.protocol}`), L("TargetPort", `${p.targetPort}/${p.protocol}`), ...(p.nodePort ? [L("NodePort", `${p.name ?? "<unset>"}  ${p.nodePort}/${p.protocol}`)] : []));
        lines.push(L("Endpoints", ready.join(",") || "<none>"));
      } else if (k.kind === "Node") {
        const n = o as unknown as Node;
        lines.push(
          L("Roles", n.metadata.labels?.["node-role.kubernetes.io/control-plane"] !== undefined ? "control-plane" : "<none>"),
          L("Taints", (n.spec?.taints ?? []).map((t) => `${t.key}${t.value ? `=${t.value}` : ""}:${t.effect}`).join("\n" + " ".repeat(16)) || "<none>"),
          L("Unschedulable", n.spec?.unschedulable ? "true" : "false"),
          "Conditions:",
          "  Type             Status   Reason                       Message",
          ...n.status!.conditions.map((cd) => `  ${cd.type.padEnd(17)}${cd.status.padEnd(9)}${(cd.reason ?? "").padEnd(29)}${cd.message ?? ""}`),
          `Addresses:\n  InternalIP:  ${n.status?.addresses[0].address}\n  Hostname:    ${n.metadata.name}`,
          L("PodCIDR", n.spec?.podCIDR),
          "Non-terminated Pods:",
          ...c.list<Pod>("Pod").filter((p) => p.spec?.nodeName === n.metadata.name && !p.metadata.deletionTimestamp).map((p) => `  ${(p.metadata.namespace ?? "").padEnd(14)}${p.metadata.name}`),
        );
      } else if (k.kind === "ReplicaSet") {
        const r = o as unknown as ReplicaSet;
        const owner = r.metadata.ownerReferences?.find((x) => x.controller);
        lines.push(L("Selector", Object.entries(r.spec!.selector.matchLabels ?? {}).map(([x, y]) => `${x}=${y}`).join(",")), L("Labels", labelsStr(r.metadata.labels)), L("Controlled By", owner ? `${owner.kind}/${owner.name}` : "<none>"), L("Replicas", `${r.status?.replicas ?? 0} current / ${r.spec?.replicas} desired`), L("Pods Status", `${r.status?.readyReplicas ?? 0} Running`));
      } else {
        lines.push(L("Labels", labelsStr(o.metadata.labels)));
      }
      lines.push(eventsBlock(c, o));
      out.push(lines.join("\n"));
    }
  }
  return out.join("\n\n\n");
}

function unwrap(r: A.ActionResult): string {
  if (!r.ok) throw new CmdError(r.out);
  return r.out;
}

function cmdRollout(ctx: KubectlContext, a: Args): string {
  const c = ctx.cluster;
  const [sub, ...rest] = a.pos;
  const t = targets(rest)[0];
  const name = t?.names[0];
  if (!name || t.k.kind !== "Deployment") throw new CmdError("error: rollout is supported for deployments in the simulator");
  const d = c.get<Deployment>("Deployment", nsOf(ctx, a), name);
  const rss = c.list<ReplicaSet>("ReplicaSet", d.metadata.namespace).filter((r) => r.metadata.ownerReferences?.some((x) => x.uid === d.metadata.uid));
  const rev = (r: ReplicaSet) => Number(r.metadata.annotations?.["deployment.kubernetes.io/revision"] ?? 0);
  switch (sub) {
    case "status": {
      const want = d.spec?.replicas ?? 1;
      const st = d.status ?? {};
      if (st.conditions?.some((x) => x.reason === "ProgressDeadlineExceeded")) throw new CmdError(`error: deployment "${name}" exceeded its progress deadline`);
      if ((st.updatedReplicas ?? 0) < want) return `Waiting for deployment "${name}" rollout to finish: ${st.updatedReplicas ?? 0} out of ${want} new replicas have been updated...`;
      if ((st.replicas ?? 0) > (st.updatedReplicas ?? 0)) return `Waiting for deployment "${name}" rollout to finish: ${(st.replicas ?? 0) - (st.updatedReplicas ?? 0)} old replicas are pending termination...`;
      if ((st.availableReplicas ?? 0) < want) return `Waiting for deployment "${name}" rollout to finish: ${st.availableReplicas ?? 0} of ${want} updated replicas are available...`;
      return `deployment "${name}" successfully rolled out`;
    }
    case "history":
      return `deployment.apps/${name}\n` + baseTable([["REVISION", "CHANGE-CAUSE"], ...rss.sort((x, y) => rev(x) - rev(y)).map((r) => [String(rev(r)), r.metadata.annotations?.["kubernetes.io/change-cause"] ?? "<none>"])]);
    case "undo":
      return unwrap(A.rolloutUndo(c, name));
    case "restart": {
      c.replace({ ...d, spec: { ...d.spec!, template: { ...d.spec!.template, metadata: { ...d.spec!.template.metadata, annotations: { ...(d.spec!.template.metadata?.annotations ?? {}), "kubectl.kubernetes.io/restartedAt": rfc3339(c.now) } } } } });
      return `deployment.apps/${name} restarted`;
    }
  }
  throw new CmdError(`error: unknown command "${sub}" for "kubectl rollout"`);
}

function cmdLogs(ctx: KubectlContext, a: Args): string {
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  let target = a.pos[0];
  if (!target) throw new CmdError("error: expected 'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]'.");
  let pod: Pod;
  if (target.includes("/")) {
    const [t, n] = target.split("/");
    const k = kindOf(t);
    if (k.kind === "Pod") pod = c.get<Pod>("Pod", ns, n);
    else {
      const d = c.get<Deployment>(k.kind, ns, n);
      const sel = d.spec?.selector.matchLabels ?? {};
      const p = c.list<Pod>("Pod", ns).find((x) => Object.entries(sel).every(([kk, v]) => x.metadata.labels?.[kk] === v));
      if (!p) throw new CmdError(`error: no pods found for ${target}`);
      pod = p;
      target = p.metadata.name;
    }
  } else pod = c.get<Pod>("Pod", ns, target);
  const cname = (flag(a, "-c", "--container") as string) || pod.spec!.containers[0].name;
  const prev = !!flag(a, "-p", "--previous");
  const lines = c.logsFor(pod, cname, prev);
  if (lines === undefined) throw new CmdError(`Error from server (BadRequest): previous terminated container "${cname}" in pod "${pod.metadata.name}" not found`);
  const cs = pod.status?.containerStatuses?.find((x) => x.name === cname);
  if (!prev && cs?.state.waiting && !(cs.restartCount > 0)) throw new CmdError(`Error from server (BadRequest): container "${cname}" in pod "${pod.metadata.name}" is waiting to start: ${cs.state.waiting.reason}`);
  const tail = flag(a, "--tail");
  const out = lines.map((l) => l.text);
  return (tail ? out.slice(-Number(tail)) : out).join("\n");
}

function curl(ctx: KubectlContext, words: string[], fromPod?: Pod): string {
  const url = words.find((w) => !w.startsWith("-"));
  if (!url) throw new CmdError("curl: try 'curl --help' for more information");
  const r = request(ctx.cluster, url, { fromPod });
  if (!r.ok) throw new CmdError(r.error ?? "curl failed");
  return r.body ?? "";
}

const VERBS = ["get", "describe", "create", "run", "apply", "edit", "delete", "scale", "set", "rollout", "expose", "logs", "label", "cordon", "uncordon", "drain", "exec", "config", "explain", "api-resources", "version", "cluster-info"];

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function suggest(word: string): string | undefined {
  const best = VERBS.map((v) => [v, distance(word, v)] as const).sort((x, y) => x[1] - y[1])[0];
  return best && best[1] <= 2 ? best[0] : undefined;
}

/** A clean, editable manifest for an object (what kubectl edit shows, minus status). */
export function manifestFor(o: AnyObject): string {
  const annotations = { ...(o.metadata.annotations ?? {}) };
  delete annotations["kubectl.kubernetes.io/last-applied-configuration"];
  for (const k of Object.keys(annotations)) if (k.startsWith("deployment.kubernetes.io/")) delete annotations[k];
  const clean: Record<string, unknown> = {
    apiVersion: o.apiVersion,
    kind: o.kind,
    metadata: { name: o.metadata.name, ...(o.metadata.namespace ? { namespace: o.metadata.namespace } : {}), ...(o.metadata.labels ? { labels: o.metadata.labels } : {}), ...(Object.keys(annotations).length ? { annotations } : {}) },
    ...(o.spec ? { spec: o.spec } : {}),
  };
  return YAML.stringify(toApiShape(clean));
}

const HELP = `kubectl controls the simulated Kubernetes cluster.

Basic:          get, describe, create, run, expose, delete, apply -f FILE, edit, explain
Files:          ls, cat FILE, kubectl get … -o yaml > FILE (the Editor edits these files)
Deploy:         scale, set image, rollout status|history|undo|restart
Troubleshoot:   logs [-f], get -w, events (kubectl get events), exec POD -- curl URL
                Ctrl+C stops a streaming command
Cluster:        cordon, uncordon, drain, label
Namespaces:     create namespace NAME, -n NAME, config set-context --current --namespace=NAME
Shell:          curl URL, clear, help

Examples:
  kubectl run web --image=nginx
  kubectl create deployment web --image=nginx --replicas=3
  kubectl get pods -o wide
  kubectl expose deployment web --port=80
  curl http://web`;

export function runKubectl(ctx: KubectlContext, line: string): CommandResult {
  const c = ctx.cluster;
  let words: string[];
  try {
    words = shellWords(line.trim());
  } catch {
    return { out: "syntax error", ok: false };
  }
  if (words.length === 0) return { out: "", ok: true };
  if (words[0] === "k") words[0] = "kubectl";
  const files = (ctx.files ??= {});
  const redirect = line.match(/^(.*\S)\s+>\s*(\S+)\s*$/);
  if (redirect) {
    const r = runKubectl(ctx, redirect[1]);
    if (!r.ok) return r;
    files[redirect[2]] = r.out.endsWith("\n") ? r.out : r.out + "\n";
    return { out: "", ok: true };
  }
  try {
    if (words[0] === "help") return { out: HELP, ok: true };
    if (words[0] === "ls") return { out: Object.keys(files).sort().join("  "), ok: true };
    if (words[0] === "cat") {
      const f = words[1];
      if (!f || files[f] === undefined) throw new CmdError(`cat: ${f ?? ""}: No such file or directory`);
      return { out: files[f].replace(/\n$/, ""), ok: true };
    }
    if (words[0] === "curl") return { out: curl(ctx, words.slice(1)), ok: true };
    if (words[0] !== "kubectl") {
      const hint = words[0].startsWith("kube") ? `\nDid you mean "kubectl"?` : "";
      return { out: `bash: ${words[0]}: command not found${hint}\nTry "help" for what this terminal can do.`, ok: false };
    }
    const verb = words[1];
    const a = parseArgs(words.slice(2), verb);
    const ns = nsOf(ctx, a);
    switch (verb) {
      case undefined:
      case "help":
      case "--help":
        return { out: HELP, ok: true };
      case "version":
        return { out: "Client Version: v1.37.0\nServer Version: v1.37.0 (simulated)", ok: true };
      case "cluster-info":
        return { out: "Kubernetes control plane is running at https://172.18.0.2:6443\nCoreDNS is running at https://172.18.0.2:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy", ok: true };
      case "get": {
        const out = cmdGet(ctx, a);
        const w = flag(a, "-w", "--watch");
        return { out, ok: true, ...(w ? { watch: line.replace(/\s(-w|--watch)\b/, "") } : {}) };
      }
      case "describe":
        return { out: cmdDescribe(ctx, a), ok: true };
      case "run": {
        const name = a.pos[0];
        const image = flag(a, "--image") as string;
        if (!name || !image) throw new CmdError("error: NAME and --image are required for kubectl run");
        const restart = (flag(a, "--restart") as string) ?? "Always";
        const labels = flag(a, "--labels") ? Object.fromEntries(String(flag(a, "--labels")).split(",").map((x) => x.split("="))) : { run: name };
        c.create({
          apiVersion: "v1",
          kind: "Pod",
          metadata: { name, namespace: ns, labels },
          spec: { restartPolicy: restart as "Always", containers: [{ name, image, ...(a.rest.length ? (flag(a, "--command") ? { command: a.rest } : { args: a.rest }) : {}) }] },
        });
        return { out: `pod/${name} created`, ok: true };
      }
      case "create": {
        const what = a.pos[0];
        if (what === "namespace" || what === "ns") {
          c.create({ apiVersion: "v1", kind: "Namespace", metadata: { name: a.pos[1] } });
          return { out: `namespace/${a.pos[1]} created`, ok: true };
        }
        if (what === "deployment" || what === "deploy") {
          const name = a.pos[1];
          const image = flag(a, "--image") as string;
          if (!name || !image) throw new CmdError("error: required flag(s) \"image\" not set");
          const replicas = Number(flag(a, "--replicas") ?? 1);
          c.create({
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: { name, namespace: ns, labels: { app: name } },
            spec: { replicas, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{ name: image.split("/").pop()!.split(":")[0], image, ...(a.rest.length ? { args: a.rest } : {}) }] } } },
          });
          return { out: `deployment.apps/${name} created`, ok: true };
        }
        throw new CmdError(`error: the simulator can create: deployment, namespace (try the Editor tab for anything else)`);
      }
      case "apply": {
        const f = flag(a, "-f", "--filename");
        if (typeof f !== "string") throw new CmdError("error: must specify one of -f and -k");
        if (files[f] === undefined) throw new CmdError(`error: the path "${f}" does not exist\nTry "ls" to see your files, or write one in the YAML editor.`);
        return applyYaml(ctx, files[f]);
      }
      case "edit": {
        const t = targets(a.pos)[0];
        if (!t?.names[0]) throw new CmdError("error: edit requires a resource name, e.g. kubectl edit deployment web");
        const o = c.get(t.k.kind, t.k.namespaced ? ns : undefined, t.names[0]);
        const name = `${t.k.short}-${t.names[0]}.yaml`;
        files[name] = manifestFor(o);
        return { out: `Opened ${name} in the YAML editor. Change it, then press Apply.`, ok: true, openFile: name };
      }
      case "explain":
        if (!a.pos[0]) throw new CmdError("error: You must specify the type of resource to explain, e.g. kubectl explain pod.spec");
        try {
          return { out: explain(a.pos[0]), ok: true };
        } catch (e) {
          throw new CmdError((e as Error).message);
        }
      case "api-resources":
        return {
          out: baseTable([["NAME", "SHORTNAMES", "APIVERSION", "NAMESPACED", "KIND"], ...KINDS.map((k) => [k.plural, Object.entries(ALIASES).filter(([al, v]) => v === k.kind && al.length <= 3 && al !== k.short).map(([al]) => al).join(","), k.group ? `${k.group}/v1` : "v1", String(k.namespaced), k.kind])]),
          ok: true,
        };
      case "delete": {
        const out: string[] = [];
        const force = !!flag(a, "--force") || flag(a, "--grace-period") === "0";
        for (const { k, names } of targets(a.pos)) {
          if (!names.length && !flag(a, "--all")) throw new CmdError("error: resource(s) were provided, but no name was specified");
          const list = names.length ? names : c.list(k.kind, k.namespaced ? ns : undefined).map((o) => o.metadata.name);
          for (const n of list) {
            c.delete(k.kind, k.namespaced ? ns : undefined, n, { force });
            out.push(`${k.short}${k.group ? "." + k.group : ""} "${n}" ${force ? "force " : ""}deleted${k.namespaced ? ` from ${ns} namespace` : ""}`);
          }
        }
        if (force) out.push("Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.");
        return { out: out.join("\n"), ok: true };
      }
      case "scale": {
        const t = targets(a.pos)[0];
        const n = Number(flag(a, "--replicas"));
        if (!Number.isFinite(n)) throw new CmdError("error: required flag(s) \"replicas\" not set");
        if (t.k.kind !== "Deployment" && t.k.kind !== "ReplicaSet") throw new CmdError(`error: cannot scale ${t.k.plural}`);
        const o = c.get<Deployment>(t.k.kind, ns, t.names[0]);
        c.replace({ ...o, spec: { ...o.spec!, replicas: n } });
        return { out: `${ref(t.k, t.names[0])} scaled`, ok: true };
      }
      case "set": {
        if (a.pos[0] !== "image") throw new CmdError("error: the simulator supports: kubectl set image");
        const t = targets([a.pos[1]])[0];
        const d = c.get<Deployment>("Deployment", ns, t.names[0]);
        const tpl = structuredClone(d.spec!.template);
        for (const kv of a.pos.slice(2)) {
          const [cn, img] = kv.split("=");
          const ct = tpl.spec.containers.find((x) => x.name === cn || cn === "*");
          if (!ct) throw new CmdError(`error: unable to find container named "${cn}"`);
          ct.image = img;
        }
        c.replace({ ...d, spec: { ...d.spec!, template: tpl } });
        return { out: `deployment.apps/${t.names[0]} image updated`, ok: true };
      }
      case "rollout": {
        const out = cmdRollout(ctx, a);
        const live = a.pos[0] === "status" && out.startsWith("Waiting") && !flag(a, "--watch=false");
        return { out, ok: true, ...(live ? { watch: line } : {}) };
      }
      case "expose": {
        const t = targets(a.pos)[0];
        const d = c.get<Deployment>("Deployment", ns, t.names[0]);
        const port = Number(flag(a, "--port") ?? d.spec!.template.spec.containers[0].ports?.[0]?.containerPort ?? 80);
        const tp = flag(a, "--target-port") ? Number(flag(a, "--target-port")) : port;
        const name = (flag(a, "--name") as string) || t.names[0];
        const type = ((flag(a, "--type") as string) || "ClusterIP") as "ClusterIP";
        c.create({ apiVersion: "v1", kind: "Service", metadata: { name, namespace: ns, labels: d.metadata.labels }, spec: { type, selector: d.spec!.selector.matchLabels, ports: [{ port, targetPort: tp }] } });
        return { out: `service/${name} exposed`, ok: true };
      }
      case "logs": {
        const out = cmdLogs(ctx, a);
        const f = flag(a, "-f", "--follow");
        return { out, ok: true, ...(f ? { watch: line.replace(/\s(-f|--follow)\b/, "") } : {}) };
      }
      case "label": {
        const t = targets(a.pos.slice(0, a.pos[0].includes("/") ? 1 : 2))[0];
        const kvs = a.pos.slice(a.pos[0].includes("/") ? 1 : 2);
        const o = c.get(t.k.kind, t.k.namespaced ? ns : undefined, t.names[0]);
        const labels = { ...(o.metadata.labels ?? {}) };
        for (const kv of kvs) {
          if (kv.endsWith("-")) delete labels[kv.slice(0, -1)];
          else {
            const [k, v] = kv.split("=");
            if (labels[k] !== undefined && labels[k] !== v && !flag(a, "--overwrite")) throw new CmdError(`error: '${k}' already has a value (${labels[k]}), and --overwrite is false`);
            labels[k] = v;
          }
        }
        c.replace({ ...o, metadata: { ...o.metadata, labels } });
        return { out: `${ref(t.k, t.names[0])} labeled`, ok: true };
      }
      case "cordon":
        return { out: unwrap(A.cordon(c, a.pos[0], true)), ok: true };
      case "uncordon":
        return { out: unwrap(A.cordon(c, a.pos[0], false)), ok: true };
      case "drain":
        return { out: unwrap(A.drain(c, a.pos[0])), ok: true };
      case "exec": {
        const pod = c.get<Pod>("Pod", ns, a.pos[0]);
        const [bin, ...rest] = a.rest;
        if (bin === "curl" || bin === "wget") return { out: curl(ctx, rest, pod), ok: true };
        if (bin === "hostname") return { out: pod.metadata.name, ok: true };
        if (bin === "env") return { out: `HOSTNAME=${pod.metadata.name}\nKUBERNETES_SERVICE_HOST=10.96.0.1\nKUBERNETES_SERVICE_PORT=443`, ok: true };
        if (bin === "cat" && rest[0] === "/etc/resolv.conf") return { out: `search ${pod.metadata.namespace}.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5`, ok: true };
        throw new CmdError(`The simulator's exec supports: curl, hostname, env, cat /etc/resolv.conf`);
      }
      case "config": {
        if (a.pos[0] === "set-context" && flag(a, "--namespace")) {
          ctx.namespace = String(flag(a, "--namespace"));
          return { out: `Context "kind-kubesim" modified.`, ok: true };
        }
        if (a.pos[0] === "view" || a.pos[0] === "current-context") return { out: "kind-kubesim", ok: true };
        throw new CmdError("error: the simulator supports: kubectl config set-context --current --namespace=NAME");
      }
      case "top":
        throw new CmdError("error: Metrics API not available");
      default:
        {
          const s = suggest(verb);
          throw new CmdError(s ? `error: unknown command "${verb}" for "kubectl"\n\nDid you mean this?\n\t${s}` : `error: unknown command "${verb}" for "kubectl"\nThis one isn't simulated yet. Type "help" for what is.`);
        }
    }
  } catch (e) {
    if (e instanceof CmdError || e instanceof ApiError) return { out: e.message, ok: false };
    return { out: `error: ${(e as Error).message}`, ok: false };
  }
}

/** Applies a YAML document stream (the Editor's Apply button). */
export function applyYaml(ctx: KubectlContext, text: string): CommandResult {
  const out: string[] = [];
  try {
    const docs = YAML.parseAllDocuments(text).map((d) => d.toJS()).filter(Boolean);
    if (docs.length === 0) return { out: "error: no objects passed to apply", ok: false };
    for (const d of docs) {
      if (!d.kind || !d.metadata?.name) throw new CmdError("error: error validating data: [apiVersion not set, kind not set, metadata.name not set]");
      const k = kindOf(d.kind);
      if (k.namespaced) d.metadata.namespace ??= ctx.namespace;
      const { action } = ctx.cluster.apply(d);
      out.push(`${ref(k, d.metadata.name)} ${action}`);
    }
    return { out: out.join("\n"), ok: true };
  } catch (e) {
    const msg = e instanceof CmdError || e instanceof ApiError ? e.message : `error: error parsing YAML: ${(e as Error).message}`;
    return { out: [...out, msg].join("\n"), ok: false };
  }
}

/** Completions for the terminal's Tab key. */
export function complete(ctx: KubectlContext, line: string): string[] {
  const words = line.split(/\s+/);
  const last = words[words.length - 1];
  const verbs = VERBS;
  if (words.length === 1) return ["kubectl", "curl", "clear", "help", "ls", "cat"].filter((w) => w.startsWith(last));
  if (words[0] === "cat" || /(-f|--filename)$/.test(words[words.length - 2] ?? "")) return Object.keys(ctx.files ?? {}).filter((f) => f.startsWith(last));
  if (last.startsWith("-")) return ["-o", "-o wide", "-o yaml", "-n", "-A", "-l", "-w", "--image=", "--replicas=", "--port=", "--show-labels"].filter((f) => f.startsWith(last));
  if (words.length === 2 && words[0] === "kubectl") return verbs.filter((v) => v.startsWith(last));
  const types = ["pods", "deployments", "replicasets", "services", "nodes", "namespaces", "events", "endpoints"];
  if (words.length === 3 && ["get", "describe", "delete", "edit", "explain"].includes(words[1])) return types.filter((t) => t.startsWith(last));
  const kindWord = words[1] === "logs" || words[1] === "exec" ? "pods" : words[2];
  const k = kindWord ? ALIASES[kindWord] : undefined;
  if (k) {
    const kk = KINDS.find((x) => x.kind === k)!;
    return ctx.cluster.list(k, kk.namespaced ? ctx.namespace : undefined).map((o) => o.metadata.name).filter((n) => n.startsWith(last));
  }
  return [];
}
