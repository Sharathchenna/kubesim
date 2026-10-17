// `kubectl get` output: server-side table columns for every kind (ported from
// pkg/printers/internalversion/printers.go), the table layout, and the -o
// yaml | json | name | wide | jsonpath | custom-columns formats.

import YAML from "yaml";
import { KINDS, rfc3339, type AnyObject, type Cluster, type ConfigMap, type CronJob, type DaemonSet, type Deployment, type Endpoints, type EndpointSlice, type HorizontalPodAutoscaler, type Ingress, type Job, type KubeEvent, type NetworkPolicy, type Node, type PersistentVolume, type PersistentVolumeClaim, type Pod, type ReplicaSet, type RoleBinding, type Secret, type Service, type StatefulSet, type StorageClass } from "@/lib/engine";
import { ACCESS_SHORT } from "@/lib/engine/controllers/storage";
import { age, podReady, podStatus, restarts } from "@/lib/sim/status";
import { evalPath, formatValue, jsonpath, jsonpathValues } from "./jsonpath";

/** kubectl's YAML: list items sit under their key without extra indent. */
export const YAML_OPTS = { indentSeq: false } as const;

export class PrintError extends Error {}

/**
 * Strings sigs.k8s.io/yaml (go-yaml v2, YAML 1.1) quotes but a YAML 1.2 printer wouldn't:
 * timestamps (creationTimestamp: "2026-01-01T09:00:00Z"), yes/no/on/off, and base-60 numbers.
 */
const GO_QUOTED = [/^(y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/, /^\d{4}-\d{1,2}-\d{1,2}([Tt ]|$)/, /^[-+]?\d[\d_]*(:[0-5]?\d)+(\.[\d_]*)?$/, /^[-+]?\d[\d_]*_[\d_]*$/];

/** YAML as kubectl prints it. */
export function toYaml(value: unknown): string {
  const doc = new YAML.Document(value);
  YAML.visit(doc, {
    Scalar(_, node) {
      if (typeof node.value === "string" && GO_QUOTED.some((re) => re.test(node.value as string))) node.type = "QUOTE_DOUBLE";
    },
  });
  return doc.toString(YAML_OPTS);
}

export function baseTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i] + 3))).join("").trimEnd()).join("\n");
}

const TIME_KEYS = /(Timestamp|Time|startedAt|finishedAt|startTime|lastProbeTime|completionTime|lastScheduleTime|lastSuccessfulTime|lastScaleTime|lastPhaseTransitionTime)$/;

/** The object as the API returns it: times as RFC3339, keys sorted at every level. */
export function toApiShape(o: unknown, key = ""): unknown {
  if (o === null || o === undefined) return o;
  if (typeof o === "number" && TIME_KEYS.test(key)) return Number.isFinite(o) ? rfc3339(o) : null;
  if (Array.isArray(o)) return o.map((x) => toApiShape(x));
  if (typeof o === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o as Record<string, unknown>).sort()) {
      const v = (o as Record<string, unknown>)[k];
      if (v === undefined) continue;
      out[k] = toApiShape(v, k);
    }
    return out;
  }
  return o;
}

export interface KindRef {
  kind: string;
  plural: string;
  singular: string;
  group: string;
  namespaced: boolean;
}

export const refName = (k: KindRef, name: string) => `${k.singular}${k.group ? `.${k.group}` : ""}/${name}`;

const lbl = (l?: Record<string, string>) => Object.entries(l ?? {}).map(([a, b]) => `${a}=${b}`).join(",");
const sel = (s?: { matchLabels?: Record<string, string>; matchExpressions?: { key: string; operator: string; values?: string[] }[] }) => {
  const parts = [
    ...Object.entries(s?.matchLabels ?? {}).map(([a, b]) => `${a}=${b}`),
    ...(s?.matchExpressions ?? []).map((e) => (e.operator === "Exists" ? e.key : e.operator === "DoesNotExist" ? `!${e.key}` : `${e.key} ${e.operator.toLowerCase()} (${(e.values ?? []).join(",")})`)),
  ];
  return parts.join(",");
};
const csv = (xs: string[]) => xs.join(",");
/** listWithMoreString (printers.go): first three items, then " + N more...", or <unset> when empty. */
const listWithMore = (xs: string[], max = 3) => (xs.length ? xs.slice(0, max).join(",") + (xs.length > max ? ` + ${xs.length - max} more...` : "") : "<unset>");

/** "5 (85s ago)": restarts plus how long ago the latest one finished. */
function restartsCell(c: Cluster, p: Pod): string {
  const n = restarts(p);
  if (!n) return "0";
  const last = Math.max(0, ...(p.status?.containerStatuses ?? []).map((s) => s.lastState.terminated?.finishedAt ?? 0));
  return last ? `${n} (${age(c.now - last)} ago)` : String(n);
}

/** printPod's READINESS GATES: true gate conditions out of all gates, or <none>. */
function readinessGates(p: Pod): string {
  const gates = p.spec?.readinessGates ?? [];
  if (!gates.length) return "<none>";
  const ok = gates.filter((g) => p.status?.conditions?.find((c) => c.type === g.conditionType)?.status === "True").length;
  return `${ok}/${gates.length}`;
}

function jobStatus(j: Job): string {
  const conds = j.status?.conditions ?? [];
  const has = (t: string) => conds.some((c) => c.type === t && c.status === "True");
  // printJob's order.
  if (has("Complete")) return "Complete";
  if (has("Failed")) return "Failed";
  if (j.metadata.deletionTimestamp !== undefined) return "Terminating";
  if (has("Suspended")) return "Suspended";
  if (has("FailureTarget")) return "FailureTarget";
  if (has("SuccessCriteriaMet")) return "SuccessCriteriaMet";
  return "Running";
}

/** Ingress HOSTS: hosts in rule order (empty skipped), "*" if none, "+ N more..." after 3. */
function hostsCell(i: Ingress): string {
  const hosts = (i.spec?.rules ?? []).map((r) => r.host).filter((h): h is string => !!h);
  if (!hosts.length) return "*";
  return hosts.length > 3 ? `${hosts.slice(0, 3).join(",")} + ${hosts.length - 3} more...` : hosts.join(",");
}

export function hpaTargets(h: HorizontalPodAutoscaler): string {
  return (h.spec?.metrics ?? [])
    .map((m) => {
      const name = m.resource?.name ?? "cpu";
      const cur = h.status?.currentMetrics?.find((x) => x.resource?.name === name)?.resource?.current;
      const t = m.resource?.target;
      if (t?.type === "AverageValue") return `${name}: ${cur?.averageValue ?? "<unknown>"}/${t.averageValue}`;
      return `${name}: ${cur?.averageUtilization !== undefined ? `${cur.averageUtilization}%` : "<unknown>"}/${t?.averageUtilization ?? 80}%`;
    })
    .join(", ");
}

function svcExternal(s: Service): string {
  if (s.spec?.type === "ExternalName") return s.spec.externalName ?? "<none>";
  if (s.spec?.type === "LoadBalancer") {
    const ing = s.status?.loadBalancer?.ingress ?? [];
    return ing.length ? ing.map((i) => i.ip ?? i.hostname).join(",") : "<pending>";
  }
  return "<none>";
}

function containersOf(spec?: { containers: { name: string; image: string }[] }) {
  const cs = spec?.containers ?? [];
  return [csv(cs.map((x) => x.name)), csv(cs.map((x) => x.image))];
}

export interface PrintOptions {
  output?: string;
  allNs: boolean;
  showLabels?: boolean;
  labelColumns?: string[];
  noHeaders?: boolean;
  /** Objects came from a list (not named), so jsonpath sees a List. */
  listed?: boolean;
}

/** Table rows (header first) for a kind, as `kubectl get` prints them. */
export function tableRows(c: Cluster, kind: string, objs: AnyObject[], wide: boolean): string[][] {
  const a = (o: AnyObject) => age(c.now - o.metadata.creationTimestamp);
  const created = (o: AnyObject) => rfc3339(o.metadata.creationTimestamp);
  switch (kind) {
    case "Pod":
      return [
        ["NAME", "READY", "STATUS", "RESTARTS", "AGE", ...(wide ? ["IP", "NODE", "NOMINATED NODE", "READINESS GATES"] : [])],
        ...(objs as unknown as Pod[]).map((p) => [p.metadata.name, podReady(p), podStatus(p), restartsCell(c, p), a(p as unknown as AnyObject), ...(wide ? [p.status?.podIP ?? "<none>", p.spec?.nodeName ?? "<none>", p.status?.nominatedNodeName ?? "<none>", readinessGates(p)] : [])]),
      ];
    case "Deployment":
      return [
        ["NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE", ...(wide ? ["CONTAINERS", "IMAGES", "SELECTOR"] : [])],
        ...(objs as unknown as Deployment[]).map((d) => [d.metadata.name, `${d.status?.readyReplicas ?? 0}/${d.spec?.replicas ?? 1}`, String(d.status?.updatedReplicas ?? 0), String(d.status?.availableReplicas ?? 0), a(d as unknown as AnyObject), ...(wide ? [...containersOf(d.spec?.template.spec), sel(d.spec?.selector)] : [])]),
      ];
    case "ReplicaSet":
      return [
        ["NAME", "DESIRED", "CURRENT", "READY", "AGE", ...(wide ? ["CONTAINERS", "IMAGES", "SELECTOR"] : [])],
        ...(objs as unknown as ReplicaSet[]).map((r) => [r.metadata.name, String(r.spec?.replicas ?? 0), String(r.status?.replicas ?? 0), String(r.status?.readyReplicas ?? 0), a(r as unknown as AnyObject), ...(wide ? [...containersOf(r.spec?.template.spec), sel(r.spec?.selector)] : [])]),
      ];
    case "StatefulSet":
      return [
        ["NAME", "READY", "AGE", ...(wide ? ["CONTAINERS", "IMAGES"] : [])],
        ...(objs as unknown as StatefulSet[]).map((s) => [s.metadata.name, `${s.status?.readyReplicas ?? 0}/${s.spec?.replicas ?? 1}`, a(s as unknown as AnyObject), ...(wide ? containersOf(s.spec?.template.spec) : [])]),
      ];
    case "DaemonSet":
      return [
        ["NAME", "DESIRED", "CURRENT", "READY", "UP-TO-DATE", "AVAILABLE", "NODE SELECTOR", "AGE", ...(wide ? ["CONTAINERS", "IMAGES", "SELECTOR"] : [])],
        ...(objs as unknown as DaemonSet[]).map((d) => {
          const st = d.status;
          return [d.metadata.name, String(st?.desiredNumberScheduled ?? 0), String(st?.currentNumberScheduled ?? 0), String(st?.numberReady ?? 0), String(st?.updatedNumberScheduled ?? 0), String(st?.numberAvailable ?? 0), lbl(d.spec?.template.spec.nodeSelector) || "<none>", a(d as unknown as AnyObject), ...(wide ? [...containersOf(d.spec?.template.spec), sel(d.spec?.selector)] : [])];
        }),
      ];
    case "Job":
      return [
        ["NAME", "STATUS", "COMPLETIONS", "DURATION", "AGE", ...(wide ? ["CONTAINERS", "IMAGES", "SELECTOR"] : [])],
        ...(objs as unknown as Job[]).map((j) => {
          const comp = j.spec?.completions;
          const done = j.status?.succeeded ?? 0;
          const par = j.spec?.parallelism ?? 1;
          const completions = comp === null || comp === undefined ? (par > 1 ? `${done}/1 of ${par}` : `${done}/1`) : `${done}/${comp}`;
          const start = j.status?.startTime;
          const dur = start === undefined ? "" : age((j.status?.completionTime ?? c.now) - start);
          return [j.metadata.name, jobStatus(j), completions, dur, a(j as unknown as AnyObject), ...(wide ? [...containersOf(j.spec?.template.spec), sel(j.spec?.selector)] : [])];
        }),
      ];
    case "CronJob":
      return [
        ["NAME", "SCHEDULE", "TIMEZONE", "SUSPEND", "ACTIVE", "LAST SCHEDULE", "AGE", ...(wide ? ["CONTAINERS", "IMAGES", "SELECTOR"] : [])],
        ...(objs as unknown as CronJob[]).map((j) => [
          j.metadata.name,
          j.spec!.schedule,
          j.spec!.timeZone ?? "<none>",
          j.spec!.suspend ? "True" : "False",
          String(j.status?.active?.length ?? 0),
          j.status?.lastScheduleTime !== undefined ? age(c.now - j.status.lastScheduleTime) : "<none>",
          a(j as unknown as AnyObject),
          ...(wide ? [...containersOf(j.spec?.jobTemplate.spec.template.spec), sel(j.spec?.jobTemplate.spec.selector) || "<none>"] : []),
        ]),
      ];
    case "HorizontalPodAutoscaler":
      return [
        ["NAME", "REFERENCE", "TARGETS", "MINPODS", "MAXPODS", "REPLICAS", "AGE"],
        ...(objs as unknown as HorizontalPodAutoscaler[]).map((h) => [h.metadata.name, `${h.spec!.scaleTargetRef.kind}/${h.spec!.scaleTargetRef.name}`, hpaTargets(h), String(h.spec?.minReplicas ?? 1), String(h.spec!.maxReplicas), String(h.status?.currentReplicas ?? 0), a(h as unknown as AnyObject)]),
      ];
    case "Service":
      return [
        ["NAME", "TYPE", "CLUSTER-IP", "EXTERNAL-IP", "PORT(S)", "AGE", ...(wide ? ["SELECTOR"] : [])],
        ...(objs as unknown as Service[]).map((s) => [
          s.metadata.name,
          s.spec?.type ?? "ClusterIP",
          s.spec?.type === "ExternalName" ? "<none>" : (s.spec?.clusterIP ?? ""),
          svcExternal(s),
          (s.spec?.ports ?? []).map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol ?? "TCP"}`).join(",") || "<none>",
          a(s as unknown as AnyObject),
          ...(wide ? [lbl(s.spec?.selector) || "<none>"] : []),
        ]),
      ];
    case "Endpoints":
      return [
        ["NAME", "ENDPOINTS", "AGE"],
        ...(objs as unknown as Endpoints[]).map((e) => {
          const addrs = (e.subsets ?? []).flatMap((s) => (s.addresses ?? []).flatMap((x) => (s.ports?.length ? s.ports : [{ port: 0 }]).map((p) => (p.port ? `${x.ip}:${p.port}` : x.ip))));
          return [e.metadata.name, addrs.length ? addrs.slice(0, 3).join(",") + (addrs.length > 3 ? ` + ${addrs.length - 3} more...` : "") : "<none>", a(e as unknown as AnyObject)];
        }),
      ];
    case "EndpointSlice":
      // printEndpointSlice: formatDiscoveryPorts / formatDiscoveryEndpoints, three items then "+ N more...".
      return [
        ["NAME", "ADDRESSTYPE", "PORTS", "ENDPOINTS", "AGE"],
        ...(objs as unknown as EndpointSlice[]).map((e) => [
          e.metadata.name,
          e.addressType,
          listWithMore((e.ports ?? []).map((p) => (p.port !== undefined ? String(p.port) : p.name ? p.name : "*"))),
          listWithMore((e.endpoints ?? []).flatMap((x) => x.addresses)),
          a(e as unknown as AnyObject),
        ]),
      ];
    case "ConfigMap":
      return [["NAME", "DATA", "AGE"], ...(objs as unknown as ConfigMap[]).map((m) => [m.metadata.name, String(Object.keys(m.data ?? {}).length + Object.keys(m.binaryData ?? {}).length), a(m as unknown as AnyObject)])];
    case "Secret":
      return [["NAME", "TYPE", "DATA", "AGE"], ...(objs as unknown as Secret[]).map((s) => [s.metadata.name, s.type ?? "Opaque", String(Object.keys(s.data ?? {}).length), a(s as unknown as AnyObject)])];
    case "ServiceAccount":
      return [["NAME", "AGE"], ...objs.map((s) => [s.metadata.name, a(s)])];
    case "PersistentVolumeClaim":
      return [
        ["NAME", "STATUS", "VOLUME", "CAPACITY", "ACCESS MODES", "STORAGECLASS", "VOLUMEATTRIBUTESCLASS", "AGE", ...(wide ? ["VOLUMEMODE"] : [])],
        ...(objs as unknown as PersistentVolumeClaim[]).map((p) => {
          const bound = p.status?.phase === "Bound";
          return [p.metadata.name, p.metadata.deletionTimestamp !== undefined ? "Terminating" : (p.status?.phase ?? "Pending"), p.spec?.volumeName ?? "", bound ? (p.status?.capacity?.storage ?? "") : "", bound ? (p.status?.accessModes ?? []).map((m) => ACCESS_SHORT[m] ?? m).join(",") : "", p.spec?.storageClassName ?? "", "<unset>", a(p as unknown as AnyObject), ...(wide ? [p.spec?.volumeMode ?? "Filesystem"] : [])];
        }),
      ];
    case "PersistentVolume":
      return [
        ["NAME", "CAPACITY", "ACCESS MODES", "RECLAIM POLICY", "STATUS", "CLAIM", "STORAGECLASS", "VOLUMEATTRIBUTESCLASS", "REASON", "AGE", ...(wide ? ["VOLUMEMODE"] : [])],
        ...(objs as unknown as PersistentVolume[]).map((v) => [
          v.metadata.name,
          v.spec?.capacity?.storage ?? "",
          (v.spec?.accessModes ?? []).map((m) => ACCESS_SHORT[m] ?? m).join(","),
          v.spec?.persistentVolumeReclaimPolicy ?? "Retain",
          v.metadata.deletionTimestamp !== undefined ? "Terminating" : (v.status?.phase ?? "Pending"),
          v.spec?.claimRef ? `${v.spec.claimRef.namespace}/${v.spec.claimRef.name}` : "",
          v.spec?.storageClassName ?? "",
          "<unset>",
          v.status?.reason ?? "",
          a(v as unknown as AnyObject),
          ...(wide ? [v.spec?.volumeMode ?? "Filesystem"] : []),
        ]),
      ];
    case "StorageClass":
      return [
        ["NAME", "PROVISIONER", "RECLAIMPOLICY", "VOLUMEBINDINGMODE", "ALLOWVOLUMEEXPANSION", "AGE"],
        ...(objs as unknown as StorageClass[]).map((s) => [s.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true" ? `${s.metadata.name} (default)` : s.metadata.name, s.provisioner, s.reclaimPolicy ?? "Delete", s.volumeBindingMode ?? "Immediate", s.allowVolumeExpansion ? "true" : "false", a(s as unknown as AnyObject)]),
      ];
    case "Ingress":
      return [
        ["NAME", "CLASS", "HOSTS", "ADDRESS", "PORTS", "AGE"],
        ...(objs as unknown as Ingress[]).map((i) => [
          i.metadata.name,
          i.spec?.ingressClassName ?? "<none>",
          hostsCell(i),
          (i.status?.loadBalancer?.ingress ?? []).map((x) => x.ip ?? x.hostname).join(","),
          i.spec?.tls?.length ? "80, 443" : "80",
          a(i as unknown as AnyObject),
        ]),
      ];
    case "IngressClass":
      return [["NAME", "CONTROLLER", "PARAMETERS", "AGE"], ...objs.map((i) => [i.metadata.name, (i.spec as { controller: string }).controller, "<none>", a(i)])];
    case "NetworkPolicy":
      return [["NAME", "POD-SELECTOR", "AGE"], ...(objs as unknown as NetworkPolicy[]).map((n) => [n.metadata.name, sel(n.spec?.podSelector) || "<none>", a(n as unknown as AnyObject)])];
    case "Role":
    case "ClusterRole":
      return [["NAME", "CREATED AT"], ...objs.map((r) => [r.metadata.name, created(r)])];
    case "RoleBinding":
    case "ClusterRoleBinding":
      return [
        ["NAME", "ROLE", "AGE", ...(wide ? ["USERS", "GROUPS", "SERVICEACCOUNTS"] : [])],
        ...(objs as unknown as RoleBinding[]).map((b) => {
          const subj = (k: string) => (b.subjects ?? []).filter((s) => s.kind === k).map((s) => (k === "ServiceAccount" ? `${s.namespace ?? b.metadata.namespace ?? ""}/${s.name}` : s.name)).join(", ");
          return [b.metadata.name, `${b.roleRef.kind}/${b.roleRef.name}`, a(b as unknown as AnyObject), ...(wide ? [subj("User"), subj("Group"), subj("ServiceAccount")] : [])];
        }),
      ];
    case "ControllerRevision":
      return [["NAME", "CONTROLLER", "REVISION", "AGE"], ...objs.map((r) => {
        const own = r.metadata.ownerReferences?.find((o) => o.controller);
        const g = own ? KINDS[own.kind]?.group : "";
        return [r.metadata.name, own ? `${own.kind.toLowerCase()}${g ? `.${g}` : ""}/${own.name}` : "<none>", String((r as { revision?: number }).revision ?? 0), a(r)];
      })];
    case "Node":
      return [
        ["NAME", "STATUS", "ROLES", "AGE", "VERSION", ...(wide ? ["INTERNAL-IP", "EXTERNAL-IP", "OS-IMAGE", "KERNEL-VERSION", "CONTAINER-RUNTIME"] : [])],
        ...(objs as unknown as Node[]).map((n) => {
          const ready = n.status?.conditions.find((x) => x.type === "Ready")?.status === "True";
          const st = (ready ? "Ready" : "NotReady") + (n.spec?.unschedulable ? ",SchedulingDisabled" : "");
          return [n.metadata.name, st, n.metadata.labels?.["node-role.kubernetes.io/control-plane"] !== undefined ? "control-plane" : "<none>", a(n as unknown as AnyObject), n.status?.nodeInfo.kubeletVersion ?? "v1.37.0", ...(wide ? [n.status?.addresses[0].address ?? "", "<none>", n.status?.nodeInfo.osImage ?? "", n.status?.nodeInfo.kernelVersion ?? "", n.status?.nodeInfo.containerRuntimeVersion ?? ""] : [])];
        }),
      ];
    case "Namespace":
      return [["NAME", "STATUS", "AGE"], ...objs.map((o) => [o.metadata.name, (o.status as { phase: string }).phase, a(o)])];
    case "Event":
      return [
        ["LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"],
        // Unsorted, like the API returns them (by name); use --sort-by or `kubectl events` for time order.
        ...(objs as unknown as KubeEvent[]).map((e) => [age(c.now - e.lastTimestamp), e.type, e.reason, `${e.involvedObject.kind.toLowerCase()}/${e.involvedObject.name}`, e.message.replace(/\n/g, " ")]),
      ];
  }
  return [["NAME", "AGE"], ...objs.map((o) => [o.metadata.name, a(o)])];
}

const asList = (objs: AnyObject[]) => ({ apiVersion: "v1", items: objs.map((o) => toApiShape(o)), kind: "List", metadata: { resourceVersion: "" } });

/** Formats that print every object together, not one table per kind. */
export const isWholeFormat = (output?: string) => !!output && (output === "yaml" || output === "json" || output.startsWith("jsonpath") || output.startsWith("custom-columns"));

/** customcolumn.go: "HEADER:jsonpath" pairs; the path may be .a.b, a.b or {.a.b}. */
function parseColumns(spec: string): { h: string; p: string }[] {
  if (!spec) throw new PrintError("error: custom-columns format specified but no custom columns given");
  return spec.split(",").map((part) => {
    const i = part.indexOf(":");
    if (i < 0) throw new PrintError(`error: unexpected custom-columns spec: ${part}, expected <header>:<json-path-expr>`);
    let p = part.slice(i + 1).trim();
    if (p.startsWith("{") && p.endsWith("}")) p = p.slice(1, -1);
    if (!p) throw new PrintError(`error: unexpected path string, expected a 'name1.name2' or '.name1.name2' or '{name1.name2}' or '{.name1.name2}'`);
    return { h: part.slice(0, i), p: p.startsWith(".") || p.startsWith("$") ? p : `.${p}` };
  });
}

const FORMATS = "custom-columns,json,jsonpath,jsonpath-as-json,name,wide,yaml";

/** Prints objects (possibly of several kinds) in a whole-output format: one List, one jsonpath root, one custom-columns table. */
export function printWhole(objs: AnyObject[], opts: PrintOptions): string {
  const output = opts.output!;
  const single = objs.length === 1 && !opts.allNs && !opts.listed;
  if (output === "yaml") return toYaml(single ? toApiShape(objs[0]) : asList(objs)).trimEnd();
  if (output === "json") return JSON.stringify(single ? toApiShape(objs[0]) : asList(objs), null, 4);
  if (output.startsWith("jsonpath=") || output.startsWith("jsonpath-as-json=")) {
    const tpl = output.slice(output.indexOf("=") + 1).replace(/^'(.*)'$/, "$1");
    const root = single ? toApiShape(objs[0]) : asList(objs);
    if (output.startsWith("jsonpath-as-json=")) return JSON.stringify(jsonpathValues(root, tpl), null, 4);
    return jsonpath(root, tpl);
  }
  if (output.startsWith("custom-columns=")) {
    const cols = parseColumns(output.slice(15));
    const rows = [cols.map((x) => x.h), ...objs.map((o) => cols.map((col) => evalPath(toApiShape(o), col.p).map(formatValue).join(",") || "<none>"))];
    return baseTable(opts.noHeaders ? rows.slice(1) : rows);
  }
  throw new PrintError(`error: unable to match a printer suitable for the output format "${output}", allowed formats are: ${FORMATS} (the simulator supports these; real kubectl also has go-template and the -file variants)`);
}

/** Checks an -o value before anything runs, so `create --dry-run -o bogus` fails without side effects. */
export function checkOutput(output: string | undefined, allowWide = true): void {
  if (output === undefined || output === "" || output === "name" || (allowWide && output === "wide") || isWholeFormat(output)) {
    if (output?.startsWith("custom-columns=")) parseColumns(output.slice(15));
    // Parse the template now, so a bad one fails even when nothing matches.
    if (output?.startsWith("jsonpath")) jsonpath({}, output.slice(output.indexOf("=") + 1).replace(/^'(.*)'$/, "$1"));
    return;
  }
  throw new PrintError(`error: unable to match a printer suitable for the output format "${output}", allowed formats are: ${FORMATS} (the simulator supports these; real kubectl also has go-template and the -file variants)`);
}

/** Renders objects of one kind in a -o format (or as a table). */
export function printObjects(c: Cluster, k: KindRef, objs: AnyObject[], opts: PrintOptions): string {
  const output = opts.output;
  if (output === "name") return objs.map((o) => refName(k, o.metadata.name)).join("\n");
  if (output && output !== "wide") return printWhole(objs, opts);
  let rows = tableRows(c, k.kind, objs, output === "wide");
  if (opts.labelColumns?.length) rows = rows.map((r, i) => [...r, ...opts.labelColumns!.map((l) => (i === 0 ? l.split("/").pop()!.toUpperCase() : ((objs[i - 1] as AnyObject).metadata.labels?.[l] ?? "")))]);
  if (opts.showLabels && k.kind !== "Event") rows = rows.map((r, i) => [...r, i === 0 ? "LABELS" : lbl((objs[i - 1] as AnyObject).metadata.labels) || "<none>"]);
  if (opts.allNs && k.namespaced) rows = rows.map((r, i) => [i === 0 ? "NAMESPACE" : ((objs[i - 1] as AnyObject).metadata.namespace ?? ""), ...r]);
  return baseTable(opts.noHeaders ? rows.slice(1) : rows);
}
