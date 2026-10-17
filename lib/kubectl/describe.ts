// `kubectl describe`: client-side describers (staging/src/k8s.io/kubectl/pkg/describe/describe.go),
// one per kind, ending with the object's Events.

import {
  nodeAllocatable,
  podLimits,
  podRequests,
  type AnyObject,
  type Cluster,
  type ConfigMap,
  type Container,
  type CronJob,
  type DaemonSet,
  type Deployment,
  type Endpoints,
  type EndpointSlice,
  type HorizontalPodAutoscaler,
  type Ingress,
  type Job,
  type LabelSelector,
  type NetworkPolicy,
  type NetworkPolicyPeer,
  type Node,
  type PersistentVolume,
  type PersistentVolumeClaim,
  type Pod,
  type PodSpec,
  type PodTemplateSpec,
  type Probe,
  type ReplicaSet,
  type Role,
  type RoleBinding,
  type Secret,
  type Service,
  type StatefulSet,
  type StorageClass,
} from "@/lib/engine";
import { ACCESS_SHORT } from "@/lib/engine/controllers/storage";
import { SIM_EPOCH as SIM_EPOCH_MS } from "@/lib/engine/util";
import { age } from "@/lib/sim/status";
import { baseTable, hpaTargets } from "./printers";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RFC1123Z, as describe prints times: "Thu, 01 Jan 2026 09:00:30 +0000". */
export function rfc1123z(simMs: number): string {
  const d = new Date(SIM_EPOCH_MS + simMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

const L = (key: string, v: unknown, w = 18) => `${(key + ":").padEnd(Math.max(w, key.length + 3))}${v === undefined || v === "" ? "<none>" : v}`;
const multi = (entries: string[], w: number) => (entries.length ? entries.join("\n" + " ".repeat(w)) : "<none>");
const labelsStr = (l: Record<string, string> | undefined, w = 18) => multi(Object.entries(l ?? {}).map(([k, v]) => `${k}=${v}`), w);
const annotationsStr = (a: Record<string, string> | undefined, w = 18) =>
  multi(
    Object.entries(a ?? {})
      .filter(([k]) => k !== "kubectl.kubernetes.io/last-applied-configuration")
      .map(([k, v]) => `${k}: ${v}`),
    w,
  );
const selStr = (s: LabelSelector | undefined) =>
  [...Object.entries(s?.matchLabels ?? {}).map(([a, b]) => `${a}=${b}`), ...(s?.matchExpressions ?? []).map((e) => `${e.key} ${e.operator} [${(e.values ?? []).join(" ")}]`)].join(",");
const pct = (a: number, b: number) => (b ? Math.floor((a / b) * 100) : 0);
const fmtCpu = (m: number) => (m === 0 ? "0" : m % 1000 === 0 ? String(m / 1000) : `${m}m`);
const fmtMem = (b: number) => (b === 0 ? "0" : b % 2 ** 30 === 0 ? `${b / 2 ** 30}Gi` : `${Math.round(b / 2 ** 20)}Mi`);

function eventsBlock(c: Cluster, o: AnyObject): string {
  // kubectl sorts by last-seen time (SortableEvents), so a repeating event moves to the bottom.
  const evs = [...c.eventsFor(o)].sort((a, b) => a.lastTimestamp - b.lastTimestamp);
  if (!evs.length) return "Events:            <none>";
  return (
    "Events:\n" +
    baseTable([
      ["  Type", "Reason", "Age", "From", "Message"],
      ["  ----", "------", "----", "----", "-------"],
      ...evs.map((e) => [`  ${e.type}`, e.reason, age(c.now - e.lastTimestamp) + (e.count > 1 ? ` (x${e.count} over ${age(c.now - e.firstTimestamp)})` : ""), e.source.component, e.message.replace(/\n/g, " ")]),
    ])
  );
}

function probeStr(p: Probe): string {
  const opts = `delay=${p.initialDelaySeconds ?? 0}s timeout=${p.timeoutSeconds ?? 1}s period=${p.periodSeconds ?? 10}s #success=${p.successThreshold ?? 1} #failure=${p.failureThreshold ?? 3}`;
  if (p.exec) return `exec [${(p.exec.command ?? []).join(" ")}] ${opts}`;
  if (p.httpGet) return `http-get ${(p.httpGet.scheme ?? "HTTP").toLowerCase()}://${p.httpGet.host ?? ""}:${p.httpGet.port}${p.httpGet.path ?? "/"} ${opts}`;
  if (p.tcpSocket) return `tcp-socket :${p.tcpSocket.port} ${opts}`;
  return `grpc <pod>:${p.grpc?.port} ${opts}`;
}

function containerBlock(ct: Container, st: NonNullable<Pod["status"]>["containerStatuses"] extends (infer X)[] | undefined ? X | undefined : never, indent = "  "): string[] {
  const i2 = indent + "  ";
  const lines = [`${indent}${ct.name}:`];
  const K = (k: string, v: unknown) => `${i2}${(k + ":").padEnd(16)}${v}`;
  if (st?.containerID) lines.push(K("Container ID", st.containerID));
  lines.push(K("Image", ct.image));
  if (st?.imageID) lines.push(K("Image ID", st.imageID));
  const ports = ct.ports ?? [];
  lines.push(ports.length ? K(ports.length > 1 ? "Ports" : "Port", ports.map((p) => `${p.containerPort}/${p.protocol ?? "TCP"}${p.name ? ` (${p.name})` : ""}`).join(", ")) : K("Port", "<none>"));
  lines.push(K("Host Port", ports.length ? ports.map((p) => `${(p as { hostPort?: number }).hostPort ?? 0}/${p.protocol ?? "TCP"}`).join(", ") : "<none>"));
  if (ct.command) lines.push(`${i2}Command:`, ...ct.command.map((w) => `${i2}  ${w}`));
  if (ct.args) lines.push(`${i2}Args:`, ...ct.args.map((w) => `${i2}  ${w}`));
  const state = (s: NonNullable<typeof st>["state"], label: string) => {
    if (s.running) lines.push(K(label, "Running"), `${i2}  ${"Started:".padEnd(14)}${rfc1123z(s.running.startedAt)}`);
    else if (s.waiting) lines.push(K(label, "Waiting"), `${i2}  ${"Reason:".padEnd(14)}${s.waiting.reason}`);
    else if (s.terminated) {
      lines.push(K(label, "Terminated"), `${i2}  ${"Reason:".padEnd(14)}${s.terminated.reason}`);
      if (s.terminated.message && label === "State") lines.push(`${i2}  ${"Message:".padEnd(14)}${s.terminated.message}`);
      lines.push(`${i2}  ${"Exit Code:".padEnd(14)}${s.terminated.exitCode}`);
      if (s.terminated.startedAt !== undefined) lines.push(`${i2}  ${"Started:".padEnd(14)}${rfc1123z(s.terminated.startedAt)}`);
      lines.push(`${i2}  ${"Finished:".padEnd(14)}${rfc1123z(s.terminated.finishedAt)}`);
    }
  };
  if (st) {
    state(st.state, "State");
    if (st.lastState.terminated) state(st.lastState, "Last State");
    lines.push(K("Ready", st.ready ? "True" : "False"), K("Restart Count", st.restartCount));
  } else lines.push(K("State", "Waiting"), `${i2}  ${"Reason:".padEnd(14)}ContainerCreating`, K("Ready", "False"), K("Restart Count", 0));
  for (const part of ["limits", "requests"] as const) {
    const r = ct.resources?.[part];
    if (r && Object.keys(r).length) lines.push(`${i2}${part === "limits" ? "Limits" : "Requests"}:`, ...Object.entries(r).map(([k, v]) => `${i2}  ${(k + ":").padEnd(8)}${v}`));
  }
  if (ct.livenessProbe) lines.push(K("Liveness", probeStr(ct.livenessProbe)));
  if (ct.readinessProbe) lines.push(K("Readiness", probeStr(ct.readinessProbe)));
  if (ct.startupProbe) lines.push(K("Startup", probeStr(ct.startupProbe)));
  if (ct.envFrom?.length) {
    lines.push(`${i2}Environment Variables from:`);
    for (const e of ct.envFrom) {
      const r = e.configMapRef ?? e.secretRef;
      lines.push(`${i2}  ${r?.name}  ${e.configMapRef ? "ConfigMap" : "Secret"}  Optional: ${r?.optional ? "true" : "false"}`);
    }
  }
  const env = ct.env ?? [];
  if (!env.length) lines.push(K("Environment", "<none>"));
  else {
    lines.push(`${i2}Environment:`);
    for (const e of env) {
      const vf = e.valueFrom;
      const v = vf?.configMapKeyRef
        ? `<set to the key '${vf.configMapKeyRef.key}' of config map '${vf.configMapKeyRef.name}'>  Optional: ${vf.configMapKeyRef.optional ? "true" : "false"}`
        : vf?.secretKeyRef
          ? `<set to the key '${vf.secretKeyRef.key}' in secret '${vf.secretKeyRef.name}'>  Optional: ${vf.secretKeyRef.optional ? "true" : "false"}`
          : vf?.fieldRef
            ? `(${vf.fieldRef.apiVersion ?? "v1"}:${vf.fieldRef.fieldPath})`
            : vf?.resourceFieldRef
              ? `${vf.resourceFieldRef.resource}`
              : (e.value ?? "");
      lines.push(`${i2}  ${e.name}:  ${v}`);
    }
  }
  const mounts = ct.volumeMounts ?? [];
  lines.push(mounts.length ? `${i2}Mounts:` : K("Mounts", "<none>"), ...mounts.map((m) => `${i2}  ${m.mountPath} from ${m.name} (${m.readOnly ? "ro" : "rw"}${m.subPath ? `,path="${m.subPath}"` : ""})`));
  return lines;
}

function volumesBlock(spec: PodSpec | undefined, indent = ""): string[] {
  const vols = spec?.volumes ?? [];
  if (!vols.length) return [`${indent}Volumes:                     <none>`];
  const out = [`${indent}Volumes:`];
  const K = (k: string, v: unknown) => `${indent}    ${(k + ":").padEnd(25)}${v}`;
  for (const v of vols) {
    out.push(`${indent}  ${v.name}:`);
    if (v.configMap) out.push(K("Type", "ConfigMap (a volume populated by a ConfigMap)"), K("Name", v.configMap.name), K("Optional", v.configMap.optional ? "true" : "false"));
    else if (v.secret) out.push(K("Type", "Secret (a volume populated by a Secret)"), K("SecretName", v.secret.secretName), K("Optional", v.secret.optional ? "true" : "false"));
    else if (v.persistentVolumeClaim) out.push(K("Type", "PersistentVolumeClaim (a reference to a PersistentVolumeClaim in the same namespace)"), K("ClaimName", v.persistentVolumeClaim.claimName), K("ReadOnly", v.persistentVolumeClaim.readOnly ? "true" : "false"));
    else if (v.emptyDir) out.push(K("Type", "EmptyDir (a temporary directory that shares a pod's lifetime)"), K("Medium", v.emptyDir.medium ?? ""), K("SizeLimit", v.emptyDir.sizeLimit ?? "<unset>"));
    else if (v.hostPath) out.push(K("Type", "HostPath (bare host directory volume)"), K("Path", v.hostPath.path), K("HostPathType", v.hostPath.type ?? ""));
    else if (v.projected) out.push(K("Type", "Projected (a volume that contains injected data from multiple sources)"), K("TokenExpirationSeconds", 3607), K("ConfigMapName", "kube-root-ca.crt"), K("Optional", "false"), K("DownwardAPI", "true"));
  }
  return out;
}

function templateBlock(t: PodTemplateSpec): string[] {
  const out = ["Pod Template:", `  Labels:  ${labelsStr(t.metadata?.labels, 11)}`];
  if (t.metadata?.annotations) out.push(`  Annotations:  ${annotationsStr(t.metadata.annotations, 16)}`);
  if (t.spec.serviceAccountName && t.spec.serviceAccountName !== "default") out.push(`  Service Account:  ${t.spec.serviceAccountName}`);
  out.push("  Containers:");
  for (const ct of t.spec.containers) {
    const lines = containerBlock(ct, undefined, "   ");
    // A template has no runtime state.
    out.push(...lines.filter((l) => !/(State:|Reason:|Ready:|Restart Count:|Host Port:)/.test(l)));
  }
  out.push(...volumesBlock(t.spec, "  ").map((l) => l.replace(/^  Volumes:\s+<none>$/, "  Volumes:         <none>")));
  if (t.spec.nodeSelector) out.push(`  Node-Selectors:  ${labelsStr(t.spec.nodeSelector, 19)}`);
  else out.push("  Node-Selectors:  <none>");
  out.push(`  Tolerations:     ${(t.spec.tolerations ?? []).length ? (t.spec.tolerations ?? []).map(tolStr).join("\n                   ") : "<none>"}`);
  return out;
}

const tolStr = (t: { key?: string; operator?: string; value?: string; effect?: string; tolerationSeconds?: number }) =>
  `${t.key ?? ""}${t.value ? `=${t.value}` : ""}${t.effect ? `:${t.effect}` : ""}${t.operator === "Exists" ? " op=Exists" : ""}${t.tolerationSeconds !== undefined ? ` for ${t.tolerationSeconds}s` : ""}`;

function ownerOf(o: AnyObject): string {
  const r = o.metadata.ownerReferences?.find((x) => x.controller);
  return r ? `${r.kind}/${r.name}` : "<none>";
}

function peerStr(p: NetworkPolicyPeer): string[] {
  if (p.ipBlock) return [`IPBlock:`, `  CIDR: ${p.ipBlock.cidr}`, `  Except: ${(p.ipBlock.except ?? []).join(", ")}`];
  const out: string[] = [];
  if (p.namespaceSelector) out.push(`NamespaceSelector: ${selStr(p.namespaceSelector) || "<none>"}`);
  if (p.podSelector) out.push(`PodSelector: ${selStr(p.podSelector) || "<none>"}`);
  return out;
}

export function describeObject(c: Cluster, kind: string, o: AnyObject): string {
  const ns = o.metadata.namespace;
  const lines: string[] = [L("Name", o.metadata.name)];
  if (ns) lines.push(L("Namespace", ns));
  switch (kind) {
    case "Pod": {
      const p = o as unknown as Pod;
      lines.push(
        L("Priority", p.spec?.priority ?? 0),
        L("Service Account", p.spec?.serviceAccountName ?? "default"),
        L("Node", p.spec?.nodeName ? `${p.spec.nodeName}/${p.status?.hostIP ?? ""}` : "<none>"),
        ...(p.status?.startTime !== undefined ? [L("Start Time", rfc1123z(p.status.startTime))] : []),
        L("Labels", labelsStr(p.metadata.labels)),
        L("Annotations", annotationsStr(p.metadata.annotations)),
        L("Status", p.metadata.deletionTimestamp !== undefined ? "Terminating" : (p.status?.phase ?? "Pending")),
        ...(p.status?.reason ? [L("Reason", p.status.reason)] : []),
        ...(p.metadata.deletionTimestamp !== undefined ? [`${"Termination Grace Period:".padEnd(18)}  ${p.metadata.deletionGracePeriodSeconds ?? 30}s`] : []),
        L("IP", p.status?.podIP ?? ""),
        "IPs:",
        p.status?.podIP ? `  IP:           ${p.status.podIP}` : "  <none>",
        ...(o.metadata.ownerReferences?.some((r) => r.controller) ? [`Controlled By:  ${ownerOf(o)}`] : []),
      );
      if (p.spec?.initContainers?.length) {
        lines.push("Init Containers:");
        for (const ct of p.spec.initContainers) lines.push(...containerBlock(ct, p.status?.initContainerStatuses?.find((s) => s.name === ct.name)));
      }
      lines.push("Containers:");
      for (const ct of p.spec!.containers) lines.push(...containerBlock(ct, p.status?.containerStatuses?.find((s) => s.name === ct.name)));
      lines.push("Conditions:", "  Type                        Status", ...(p.status?.conditions ?? []).map((cd) => `  ${cd.type.padEnd(28)}${cd.status} `));
      lines.push(...volumesBlock(p.spec));
      lines.push(`QoS Class:                   ${p.status?.qosClass ?? "BestEffort"}`, `Node-Selectors:              ${labelsStr(p.spec?.nodeSelector, 29)}`, `Tolerations:                 ${multi((p.spec?.tolerations ?? []).map(tolStr), 29)}`);
      break;
    }
    case "Deployment": {
      const d = o as unknown as Deployment;
      const st = d.status ?? {};
      const ru = d.spec?.strategy?.rollingUpdate;
      const rss = c.list<ReplicaSet>("ReplicaSet", ns).filter((r) => r.metadata.ownerReferences?.some((x) => x.uid === d.metadata.uid));
      const newRs = rss.find((r) => r.metadata.annotations?.["deployment.kubernetes.io/revision"] === d.metadata.annotations?.["deployment.kubernetes.io/revision"]);
      lines.push(
        L("CreationTimestamp", rfc1123z(d.metadata.creationTimestamp), 24),
        L("Labels", labelsStr(d.metadata.labels, 24), 24),
        L("Annotations", annotationsStr(d.metadata.annotations, 24), 24),
        L("Selector", selStr(d.spec!.selector), 24),
        L("Replicas", `${d.spec?.replicas} desired | ${st.updatedReplicas ?? 0} updated | ${st.replicas ?? 0} total | ${st.availableReplicas ?? 0} available | ${st.unavailableReplicas ?? 0} unavailable`, 24),
        L("StrategyType", d.spec?.strategy?.type, 24),
        L("MinReadySeconds", d.spec?.minReadySeconds ?? 0, 24),
        ...(ru ? [`RollingUpdateStrategy:  ${ru.maxUnavailable} max unavailable, ${ru.maxSurge} max surge`] : []),
        ...templateBlock(d.spec!.template),
        "Conditions:",
        "  Type           Status  Reason",
        "  ----           ------  ------",
        ...(st.conditions ?? []).map((cd) => `  ${cd.type.padEnd(15)}${cd.status.padEnd(8)}${cd.reason}`),
        `OldReplicaSets:  ${rss.filter((r) => r !== newRs && (r.spec?.replicas ?? 0) > 0).map((r) => `${r.metadata.name} (${r.status?.replicas ?? 0}/${r.spec?.replicas} replicas created)`).join(", ") || "<none>"}`,
        `NewReplicaSet:   ${newRs ? `${newRs.metadata.name} (${newRs.status?.replicas ?? 0}/${newRs.spec?.replicas} replicas created)` : "<none>"}`,
      );
      lines[0] = L("Name", d.metadata.name, 24);
      lines[1] = L("Namespace", ns, 24);
      break;
    }
    case "ReplicaSet": {
      const r = o as unknown as ReplicaSet;
      const pods = c.list<Pod>("Pod", ns).filter((p) => p.metadata.ownerReferences?.some((x) => x.uid === r.metadata.uid));
      const count = (ph: string) => pods.filter((p) => p.status?.phase === ph).length;
      lines.push(
        L("Selector", selStr(r.spec!.selector), 14),
        L("Labels", labelsStr(r.metadata.labels, 14), 14),
        L("Annotations", annotationsStr(r.metadata.annotations, 14), 14),
        L("Controlled By", ownerOf(o), 14),
        L("Replicas", `${r.status?.replicas ?? 0} current / ${r.spec?.replicas} desired`, 14),
        L("Pods Status", `${count("Running")} Running / ${count("Pending")} Waiting / ${count("Succeeded")} Succeeded / ${count("Failed")} Failed`, 14),
        ...templateBlock(r.spec!.template),
      );
      lines[0] = L("Name", r.metadata.name, 14);
      lines[1] = L("Namespace", ns, 14);
      break;
    }
    case "StatefulSet": {
      const s = o as unknown as StatefulSet;
      const pods = c.list<Pod>("Pod", ns).filter((p) => p.metadata.ownerReferences?.some((x) => x.uid === s.metadata.uid));
      const count = (ph: string) => pods.filter((p) => p.status?.phase === ph).length;
      lines[0] = L("Name", s.metadata.name, 20);
      lines[1] = L("Namespace", ns, 20);
      lines.push(
        L("CreationTimestamp", rfc1123z(s.metadata.creationTimestamp), 20),
        L("Selector", selStr(s.spec!.selector), 20),
        L("Labels", labelsStr(s.metadata.labels, 20), 20),
        L("Annotations", annotationsStr(s.metadata.annotations, 20), 20),
        L("Replicas", `${s.spec?.replicas ?? 1} desired | ${s.status?.replicas ?? 0} total`, 20),
        L("Update Strategy", s.spec?.updateStrategy?.type ?? "RollingUpdate", 20),
        ...(s.spec?.updateStrategy?.type !== "OnDelete" ? [`  Partition:        ${s.spec?.updateStrategy?.rollingUpdate?.partition ?? 0}`] : []),
        L("Pods Status", `${count("Running")} Running / ${count("Pending")} Waiting / ${count("Succeeded")} Succeeded / ${count("Failed")} Failed`, 20),
        ...templateBlock(s.spec!.template),
        "Volume Claims:",
        ...((s.spec?.volumeClaimTemplates ?? []).length
          ? (s.spec?.volumeClaimTemplates ?? []).flatMap((v) => [`  Name:          ${v.metadata.name}`, `  StorageClass:  ${v.spec.storageClassName ?? ""}`, `  Labels:        ${labelsStr(v.metadata.labels, 17)}`, `  Annotations:   <none>`, `  Capacity:      ${v.spec.resources?.requests?.storage ?? ""}`, `  Access Modes:  [${(v.spec.accessModes ?? []).join(" ")}]`])
          : ["  <none>"]),
      );
      break;
    }
    case "DaemonSet": {
      const d = o as unknown as DaemonSet;
      const st = d.status;
      lines.push(
        L("Selector", selStr(d.spec!.selector), 32),
        L("Node-Selector", Object.entries(d.spec!.template.spec.nodeSelector ?? {}).map(([a, b]) => `${a}=${b}`).join(",") || "<none>", 32),
        L("Labels", labelsStr(d.metadata.labels, 32), 32),
        L("Annotations", annotationsStr(d.metadata.annotations, 32), 32),
        `Desired Number of Nodes Scheduled: ${st?.desiredNumberScheduled ?? 0}`,
        `Current Number of Nodes Scheduled: ${st?.currentNumberScheduled ?? 0}`,
        `Number of Nodes Scheduled with Up-to-date Pods: ${st?.updatedNumberScheduled ?? 0}`,
        `Number of Nodes Scheduled with Available Pods: ${st?.numberAvailable ?? 0}`,
        `Number of Nodes Misscheduled: ${st?.numberMisscheduled ?? 0}`,
        `Pods Status:  ${st?.numberReady ?? 0} Running / ${(st?.desiredNumberScheduled ?? 0) - (st?.numberReady ?? 0)} Waiting / 0 Succeeded / 0 Failed`,
        ...templateBlock(d.spec!.template),
      );
      lines[0] = L("Name", d.metadata.name, 32);
      lines[1] = L("Namespace", ns, 32);
      break;
    }
    case "Job": {
      const j = o as unknown as Job;
      const st = j.status ?? {};
      lines.push(
        L("Selector", selStr(j.spec?.selector), 26),
        L("Labels", labelsStr(j.metadata.labels, 26), 26),
        L("Annotations", annotationsStr(j.metadata.annotations, 26), 26),
        ...(o.metadata.ownerReferences?.some((r) => r.controller) ? [L("Controlled By", ownerOf(o), 26)] : []),
        L("Parallelism", j.spec?.parallelism ?? 1, 26),
        L("Completions", j.spec?.completions ?? "<unset>", 26),
        L("Completion Mode", j.spec?.completionMode ?? "NonIndexed", 26),
        L("Suspend", j.spec?.suspend ? "true" : "false", 26),
        L("Backoff Limit", j.spec?.backoffLimit ?? 6, 26),
        ...(j.spec?.ttlSecondsAfterFinished !== undefined ? [L("TTL Seconds After Finished", j.spec.ttlSecondsAfterFinished, 26)] : []),
        ...(st.startTime !== undefined ? [L("Start Time", rfc1123z(st.startTime), 26)] : []),
        ...(st.completionTime !== undefined ? [L("Completed At", rfc1123z(st.completionTime), 26), L("Duration", age(st.completionTime - (st.startTime ?? st.completionTime)), 26)] : []),
        L("Pods Statuses", `${st.active ?? 0} Active (${st.ready ?? 0} Ready) / ${st.succeeded ?? 0} Succeeded / ${st.failed ?? 0} Failed`, 26),
        ...(j.spec?.completionMode === "Indexed" ? [L("Completed Indexes", st.completedIndexes ?? "<none>", 26)] : []),
        ...templateBlock(j.spec!.template),
      );
      lines[0] = L("Name", j.metadata.name, 26);
      lines[1] = L("Namespace", ns, 26);
      break;
    }
    case "CronJob": {
      const cj = o as unknown as CronJob;
      lines.push(
        L("Labels", labelsStr(cj.metadata.labels, 30), 30),
        L("Annotations", annotationsStr(cj.metadata.annotations, 30), 30),
        L("Schedule", cj.spec!.schedule, 30),
        L("Concurrency Policy", cj.spec!.concurrencyPolicy ?? "Allow", 30),
        L("Suspend", cj.spec!.suspend ? "True" : "False", 30),
        L("Successful Job History Limit", cj.spec!.successfulJobsHistoryLimit ?? 3, 30),
        L("Failed Job History Limit", cj.spec!.failedJobsHistoryLimit ?? 1, 30),
        L("Starting Deadline Seconds", cj.spec!.startingDeadlineSeconds !== undefined ? `${cj.spec!.startingDeadlineSeconds}s` : "<unset>", 30),
        L("Selector", "<unset>", 30),
        L("Parallelism", cj.spec!.jobTemplate.spec.parallelism ?? "<unset>", 30),
        L("Completions", cj.spec!.jobTemplate.spec.completions ?? "<unset>", 30),
        ...templateBlock(cj.spec!.jobTemplate.spec.template),
        L("Last Schedule Time", cj.status?.lastScheduleTime !== undefined ? rfc1123z(cj.status.lastScheduleTime) : "<unset>", 30),
        L("Active Jobs", (cj.status?.active ?? []).map((a) => a.name).join(", ") || "<none>", 30),
      );
      lines[0] = L("Name", cj.metadata.name, 30);
      lines[1] = L("Namespace", ns, 30);
      break;
    }
    case "HorizontalPodAutoscaler": {
      const h = o as unknown as HorizontalPodAutoscaler;
      const t = hpaTargets(h).split(": ")[1] ?? "";
      lines.push(
        L("Labels", labelsStr(h.metadata.labels, 51), 51),
        L("Annotations", annotationsStr(h.metadata.annotations, 51), 51),
        L("CreationTimestamp", rfc1123z(h.metadata.creationTimestamp), 51),
        L("Reference", `${h.spec!.scaleTargetRef.kind}/${h.spec!.scaleTargetRef.name}`, 51),
        "Metrics:                                               ( current / target )",
        `  resource ${h.spec?.metrics?.[0]?.resource?.name ?? "cpu"} on pods  (as a percentage of request):  ${t.replace("/", " / ")}`,
        L("Min replicas", h.spec?.minReplicas ?? 1, 51),
        L("Max replicas", h.spec!.maxReplicas, 51),
        `${h.spec!.scaleTargetRef.kind} pods:${" ".repeat(Math.max(1, 51 - h.spec!.scaleTargetRef.kind.length - 6))}${h.status?.currentReplicas ?? 0} current / ${h.status?.desiredReplicas ?? 0} desired`,
        "Conditions:",
        ...hpaConditions(h.status?.conditions ?? []),
      );
      lines[0] = L("Name", h.metadata.name, 51);
      lines[1] = L("Namespace", ns, 51);
      break;
    }
    case "Service": {
      const s = o as unknown as Service;
      const ep = c.raw("Endpoints", ns, s.metadata.name) as unknown as Endpoints | undefined;
      const ready = (ep?.subsets ?? []).flatMap((x) => (x.addresses ?? []).map((ad) => `${ad.ip}:${x.ports?.[0]?.port}`));
      lines.push(
        L("Labels", labelsStr(s.metadata.labels, 25), 25),
        L("Annotations", annotationsStr(s.metadata.annotations, 25), 25),
        L("Selector", Object.entries(s.spec?.selector ?? {}).map(([x, y]) => `${x}=${y}`).join(",") || "<none>", 25),
        L("Type", s.spec?.type, 25),
        ...(s.spec?.type === "ExternalName"
          ? [L("External Name", s.spec.externalName, 25)]
          : [L("IP Family Policy", s.spec?.ipFamilyPolicy ?? "SingleStack", 25), L("IP Families", (s.spec?.ipFamilies ?? ["IPv4"]).join(","), 25), L("IP", s.spec?.clusterIP, 25), L("IPs", s.spec?.clusterIP, 25)]),
        ...(s.status?.loadBalancer?.ingress?.length ? [L("LoadBalancer Ingress", s.status.loadBalancer.ingress.map((i) => `${i.ip ?? i.hostname}${i.ipMode ? ` (${i.ipMode})` : ""}`).join(", "), 25)] : []),
      );
      for (const p of s.spec?.ports ?? []) lines.push(L("Port", `${p.name ?? "<unset>"}  ${p.port}/${p.protocol}`, 25), L("TargetPort", `${p.targetPort}/${p.protocol}`, 25), ...(p.nodePort ? [L("NodePort", `${p.name ?? "<unset>"}  ${p.nodePort}/${p.protocol}`, 25)] : []), L("Endpoints", ready.join(",") || "", 25));
      lines.push(L("Session Affinity", s.spec?.sessionAffinity ?? "None", 25), ...(s.spec?.externalTrafficPolicy ? [L("External Traffic Policy", s.spec.externalTrafficPolicy, 25)] : []), L("Internal Traffic Policy", s.spec?.internalTrafficPolicy ?? "Cluster", 25));
      lines[0] = L("Name", s.metadata.name, 25);
      lines[1] = L("Namespace", ns, 25);
      break;
    }
    case "ConfigMap": {
      const m = o as unknown as ConfigMap;
      lines.push(L("Labels", labelsStr(m.metadata.labels, 14), 14), L("Annotations", annotationsStr(m.metadata.annotations, 14), 14), "", "Data", "====");
      for (const [k, v] of Object.entries(m.data ?? {})) lines.push(`${k}:`, "----", v, "");
      lines.push("", "BinaryData", "====", "");
      lines[0] = L("Name", m.metadata.name, 14);
      lines[1] = L("Namespace", ns, 14);
      break;
    }
    case "Secret": {
      const s = o as unknown as Secret;
      lines.push(L("Labels", labelsStr(s.metadata.labels, 14), 14), L("Annotations", annotationsStr(s.metadata.annotations, 14), 14), "", `Type:  ${s.type ?? "Opaque"}`, "", "Data", "====");
      const width = Math.max(0, ...Object.keys(s.data ?? {}).map((k) => k.length));
      for (const [k, v] of Object.entries(s.data ?? {})) lines.push(`${(k + ":").padEnd(width + 3)}${Math.floor((v.length * 3) / 4) - (v.endsWith("==") ? 2 : v.endsWith("=") ? 1 : 0)} bytes`);
      lines[0] = L("Name", s.metadata.name, 14);
      lines[1] = L("Namespace", ns, 14);
      break;
    }
    case "ServiceAccount":
      lines.push(L("Labels", labelsStr(o.metadata.labels, 21), 21), L("Annotations", annotationsStr(o.metadata.annotations, 21), 21), L("Image pull secrets", "<none>", 21), L("Mountable secrets", "<none>", 21), L("Tokens", "<none>", 21));
      lines[0] = L("Name", o.metadata.name, 21);
      lines[1] = L("Namespace", ns, 21);
      break;
    case "PersistentVolumeClaim": {
      const p = o as unknown as PersistentVolumeClaim;
      const users = c.list<Pod>("Pod", ns).filter((x) => (x.spec?.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === p.metadata.name));
      lines.push(
        L("StorageClass", p.spec?.storageClassName ?? "", 15),
        L("Status", p.metadata.deletionTimestamp !== undefined ? `Terminating (lasts ${age(c.now - p.metadata.deletionTimestamp)})` : (p.status?.phase ?? "Pending"), 15),
        L("Volume", p.spec?.volumeName ?? "", 15),
        L("Labels", labelsStr(p.metadata.labels, 15), 15),
        L("Annotations", annotationsStr(p.metadata.annotations, 15), 15),
        L("Finalizers", `[${(p.metadata.finalizers ?? []).join(" ")}]`, 15),
        L("Capacity", p.status?.capacity?.storage ?? "", 15),
        L("Access Modes", (p.status?.accessModes ?? []).map((m) => ACCESS_SHORT[m] ?? m).join(","), 15),
        L("VolumeMode", p.spec?.volumeMode ?? "Filesystem", 15),
        L("Used By", multi(users.map((u) => u.metadata.name), 15), 15),
      );
      lines[0] = L("Name", p.metadata.name, 15);
      lines[1] = L("Namespace", ns, 15);
      break;
    }
    case "PersistentVolume": {
      const v = o as unknown as PersistentVolume;
      const terms = v.spec?.nodeAffinity?.required?.nodeSelectorTerms ?? [];
      lines.push(
        L("Labels", labelsStr(v.metadata.labels), 18),
        L("Annotations", annotationsStr(v.metadata.annotations), 18),
        L("Finalizers", `[${(v.metadata.finalizers ?? []).join(" ")}]`),
        L("StorageClass", v.spec?.storageClassName ?? ""),
        L("Status", v.status?.phase ?? "Available"),
        L("Claim", v.spec?.claimRef ? `${v.spec.claimRef.namespace}/${v.spec.claimRef.name}` : ""),
        L("Reclaim Policy", v.spec?.persistentVolumeReclaimPolicy ?? "Retain"),
        L("Access Modes", (v.spec?.accessModes ?? []).map((m) => ACCESS_SHORT[m] ?? m).join(",")),
        L("VolumeMode", v.spec?.volumeMode ?? "Filesystem"),
        L("Capacity", v.spec?.capacity?.storage ?? ""),
        terms.length ? "Node Affinity:     \n  Required Terms:  \n" + terms.map((t) => `    Term 0:        ${(t.matchExpressions ?? []).map((e) => `${e.key} ${e.operator.toLowerCase()} [${(e.values ?? []).join(", ")}]`).join(", ")}`).join("\n") : "Node Affinity:     <none>",
        "Message:           ",
        "Source:",
        v.spec?.hostPath ? `    Type:          HostPath (bare host directory volume)\n    Path:          ${v.spec.hostPath.path}\n    HostPathType:  ${v.spec.hostPath.type ?? ""}` : `    Type:  LocalVolume (a persistent volume backed by local storage on a node)\n    Path:  ${v.spec?.local?.path ?? ""}`,
      );
      break;
    }
    case "StorageClass": {
      const s = o as unknown as StorageClass;
      lines.push(
        L("IsDefaultClass", s.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true" ? "Yes" : "No", 22),
        L("Annotations", annotationsStr(s.metadata.annotations, 22), 22),
        L("Provisioner", s.provisioner, 22),
        L("Parameters", "<none>", 22),
        L("AllowVolumeExpansion", s.allowVolumeExpansion ? "True" : "<unset>", 22),
        L("MountOptions", "<none>", 22),
        L("ReclaimPolicy", s.reclaimPolicy ?? "Delete", 22),
        L("VolumeBindingMode", s.volumeBindingMode ?? "Immediate", 22),
      );
      lines[0] = L("Name", s.metadata.name, 22);
      break;
    }
    case "Ingress": {
      const ing = o as unknown as Ingress;
      lines.push(
        L("Labels", labelsStr(ing.metadata.labels, 18), 18),
        L("Namespace", ns, 18),
        L("Address", (ing.status?.loadBalancer?.ingress ?? []).map((x) => x.ip ?? x.hostname).join(","), 18),
        L("Ingress Class", ing.spec?.ingressClassName ?? "<none>", 18),
        L("Default backend", ing.spec?.defaultBackend?.service ? `${ing.spec.defaultBackend.service.name}:${ing.spec.defaultBackend.service.port.number ?? ing.spec.defaultBackend.service.port.name}` : "<default>", 18),
        "Rules:",
        "  Host        Path  Backends",
        "  ----        ----  --------",
      );
      lines.splice(1, 1);
      for (const r of ing.spec?.rules ?? []) {
        lines.push(`  ${r.host ?? "*"}`);
        for (const p of r.http?.paths ?? []) {
          const svc = p.backend.service;
          const s = svc ? (c.raw("Service", ns, svc.name) as unknown as Service | undefined) : undefined;
          const ep = svc ? (c.raw("Endpoints", ns, svc.name) as unknown as Endpoints | undefined) : undefined;
          const addrs = (ep?.subsets ?? []).flatMap((x) => (x.addresses ?? []).map((a) => `${a.ip}:${x.ports?.[0]?.port}`));
          lines.push(`              ${(p.path ?? "/").padEnd(6)}${svc ? `${svc.name}:${svc.port.number ?? svc.port.name} (${s ? addrs.join(",") || "<none>" : `<error: services "${svc.name}" not found>`})` : "<resource>"}`);
        }
      }
      lines.push(L("Annotations", annotationsStr(ing.metadata.annotations, 18), 18));
      lines[0] = L("Name", ing.metadata.name, 18);
      break;
    }
    case "NetworkPolicy": {
      const np = o as unknown as NetworkPolicy;
      const types = np.spec?.policyTypes ?? ["Ingress"];
      lines.push(L("Created on", rfc1123z(np.metadata.creationTimestamp), 14), L("Labels", labelsStr(np.metadata.labels, 14), 14), L("Annotations", annotationsStr(np.metadata.annotations, 14), 14), "Spec:", `  PodSelector:     ${selStr(np.spec?.podSelector) || "<none> (Allowing the specific traffic to all pods in this namespace)"}`);
      const rules = (dir: "Ingress" | "Egress") => {
        const list = dir === "Ingress" ? np.spec?.ingress : np.spec?.egress;
        if (!types.includes(dir)) return [`  Not affecting ${dir.toLowerCase()} traffic`];
        if (!list || list.length === 0) return [`  Allowing ${dir.toLowerCase()} traffic:`, `    <none> (Selected pods are isolated for ${dir.toLowerCase()} connectivity)`];
        const out = [`  Allowing ${dir.toLowerCase()} traffic:`];
        list.forEach((r, i) => {
          if (i) out.push("    ----------");
          const ports = r.ports ?? [];
          out.push(ports.length ? ports.map((p) => `    To Port: ${p.port ?? "<any>"}/${p.protocol ?? "TCP"}`).join("\n") : "    To Port: <any> (traffic allowed to all ports)");
          const peers = (dir === "Ingress" ? (r as { from?: NetworkPolicyPeer[] }).from : (r as { to?: NetworkPolicyPeer[] }).to) ?? [];
          if (!peers.length) out.push(`    ${dir === "Ingress" ? "From" : "To"}: <any> (traffic not restricted by destination)`);
          else {
            out.push(`    ${dir === "Ingress" ? "From" : "To"}:`);
            for (const p of peers) out.push(...peerStr(p).map((l) => `      ${l}`));
          }
        });
        return out;
      };
      lines.push(...rules("Ingress"), ...rules("Egress"), `  Policy Types: ${types.join(", ")}`);
      lines[0] = L("Name", np.metadata.name, 14);
      lines[1] = L("Namespace", ns, 14);
      break;
    }
    case "Role":
    case "ClusterRole": {
      const r = o as unknown as Role;
      lines.splice(1);
      lines[0] = L("Name", r.metadata.name, 14);
      lines.push(L("Labels", labelsStr(r.metadata.labels, 14), 14), L("Annotations", annotationsStr(r.metadata.annotations, 14), 14), "PolicyRule:");
      const rows = [["  Resources", "Non-Resource URLs", "Resource Names", "Verbs"], ["  ---------", "-----------------", "--------------", "-----"]];
      for (const rule of r.rules ?? []) {
        const res = (rule.resources ?? []).flatMap((x) => (rule.apiGroups ?? [""]).map((g) => (g ? `${x}.${g}` : x)));
        if (rule.nonResourceURLs?.length) rows.push(["  ", `[${rule.nonResourceURLs.join(" ")}]`, "[]", `[${rule.verbs.join(" ")}]`]);
        for (const x of res) rows.push([`  ${x}`, "[]", `[${(rule.resourceNames ?? []).join(" ")}]`, `[${rule.verbs.join(" ")}]`]);
      }
      lines.push(baseTable(rows));
      return lines.join("\n");
    }
    case "RoleBinding":
    case "ClusterRoleBinding": {
      const b = o as unknown as RoleBinding;
      lines.splice(1);
      lines[0] = L("Name", b.metadata.name, 14);
      lines.push(L("Labels", labelsStr(b.metadata.labels, 14), 14), L("Annotations", annotationsStr(b.metadata.annotations, 14), 14), "Role:", `  Kind:  ${b.roleRef.kind}`, `  Name:  ${b.roleRef.name}`, "Subjects:");
      lines.push(baseTable([["  Kind", "Name", "Namespace"], ["  ----", "----", "---------"], ...(b.subjects ?? []).map((s) => [`  ${s.kind}`, s.name, s.namespace ?? ""])]));
      return lines.join("\n");
    }
    case "Node": {
      const n = o as unknown as Node;
      const pods = c.list<Pod>("Pod").filter((p) => p.spec?.nodeName === n.metadata.name && p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed");
      const alloc = nodeAllocatable(n);
      const req = pods.reduce((acc, p) => {
        const r = podRequests(p.spec);
        const l = podLimits(p.spec);
        return { cpu: acc.cpu + r.cpu, mem: acc.mem + r.memory, lcpu: acc.lcpu + l.cpu, lmem: acc.lmem + l.memory };
      }, { cpu: 0, mem: 0, lcpu: 0, lmem: 0 });
      const cap = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => `  ${(k + ":").padEnd(19)}${v}`);
      lines[0] = L("Name", n.metadata.name, 20);
      lines.push(
        L("Roles", n.metadata.labels?.["node-role.kubernetes.io/control-plane"] !== undefined ? "control-plane" : "<none>", 20),
        L("Labels", labelsStr(n.metadata.labels, 20), 20),
        L("Annotations", annotationsStr(n.metadata.annotations, 20), 20),
        L("CreationTimestamp", rfc1123z(n.metadata.creationTimestamp), 20),
        L("Taints", multi((n.spec?.taints ?? []).map((t) => `${t.key}${t.value ? `=${t.value}` : ""}:${t.effect}`), 20), 20),
        L("Unschedulable", n.spec?.unschedulable ? "true" : "false", 20),
        "Conditions:",
        "  Type             Status   LastHeartbeatTime                 LastTransitionTime                Reason                       Message",
        "  ----             ------   -----------------                 ------------------                ------                       -------",
        ...n.status!.conditions.map((cd) => `  ${cd.type.padEnd(17)}${cd.status.padEnd(9)}${rfc1123z(cd.lastHeartbeatTime ?? 0).padEnd(34)}${rfc1123z(cd.lastTransitionTime ?? 0).padEnd(34)}${(cd.reason ?? "").padEnd(29)}${cd.message ?? ""}`),
        "Addresses:",
        `  InternalIP:  ${n.status?.addresses[0].address}`,
        `  Hostname:    ${n.metadata.name}`,
        "Capacity:",
        ...cap(n.status!.capacity),
        "Allocatable:",
        ...cap(n.status!.allocatable),
        "System Info:",
        ...Object.entries(n.status!.nodeInfo).map(([k, v]) => `  ${(k.replace(/([A-Z])/g, " $1").replace(/^./, (x) => x.toUpperCase()) + ":").padEnd(27)}${v}`),
        L("PodCIDR", n.spec?.podCIDR, 30),
        L("PodCIDRs", n.spec?.podCIDR, 30),
        `Non-terminated Pods:          (${pods.length} in total)`,
        baseTable([
          ["  Namespace", "Name", "CPU Requests", "CPU Limits", "Memory Requests", "Memory Limits", "Age"],
          ["  ---------", "----", "------------", "----------", "---------------", "-------------", "---"],
          ...pods.map((p) => {
            const r = podRequests(p.spec);
            const l = podLimits(p.spec);
            return [`  ${p.metadata.namespace}`, p.metadata.name, `${fmtCpu(r.cpu)} (${pct(r.cpu, alloc.cpu)}%)`, `${fmtCpu(l.cpu)} (${pct(l.cpu, alloc.cpu)}%)`, `${fmtMem(r.memory)} (${pct(r.memory, alloc.memory)}%)`, `${fmtMem(l.memory)} (${pct(l.memory, alloc.memory)}%)`, age(c.now - p.metadata.creationTimestamp)];
          }),
        ]),
        "Allocated resources:",
        "  (Total limits may be over 100 percent, i.e., overcommitted.)",
        baseTable([
          ["  Resource", "Requests", "Limits"],
          ["  --------", "--------", "------"],
          ["  cpu", `${fmtCpu(req.cpu)} (${pct(req.cpu, alloc.cpu)}%)`, `${fmtCpu(req.lcpu)} (${pct(req.lcpu, alloc.cpu)}%)`],
          ["  memory", `${fmtMem(req.mem)} (${pct(req.mem, alloc.memory)}%)`, `${fmtMem(req.lmem)} (${pct(req.lmem, alloc.memory)}%)`],
          ["  ephemeral-storage", "0 (0%)", "0 (0%)"],
          ["  hugepages-1Gi", "0 (0%)", "0 (0%)"],
          ["  hugepages-2Mi", "0 (0%)", "0 (0%)"],
        ]),
      );
      break;
    }
    case "Namespace":
      lines.push(L("Labels", labelsStr(o.metadata.labels, 14), 14), L("Annotations", annotationsStr(o.metadata.annotations, 14), 14), L("Status", (o.status as { phase: string }).phase, 14), "", "No resource quota.", "", "No LimitRange resource.");
      lines[0] = L("Name", o.metadata.name, 14);
      return lines.join("\n");
    case "Endpoints": {
      const e = o as unknown as Endpoints;
      lines.push(L("Labels", labelsStr(e.metadata.labels, 14), 14), L("Annotations", annotationsStr(e.metadata.annotations, 14), 14), "Subsets:");
      for (const s of e.subsets ?? []) {
        lines.push(`  Addresses:          ${(s.addresses ?? []).map((a) => a.ip).join(",") || "<none>"}`, `  NotReadyAddresses:  ${(s.notReadyAddresses ?? []).map((a) => a.ip).join(",") || "<none>"}`, "  Ports:", "    Name     Port  Protocol", "    ----     ----  --------", ...(s.ports ?? []).map((p) => `    ${(p.name ?? "<unset>").padEnd(9)}${String(p.port).padEnd(6)}${p.protocol}`), "");
      }
      lines[0] = L("Name", e.metadata.name, 14);
      lines[1] = L("Namespace", ns, 14);
      break;
    }
    case "EndpointSlice": {
      // describeEndpointSliceV1.
      const e = o as unknown as EndpointSlice;
      lines.push(L("Labels", labelsStr(e.metadata.labels, 14), 14), L("Annotations", annotationsStr(e.metadata.annotations, 14), 14), L("AddressType", e.addressType, 14));
      if (!e.ports?.length) lines.push("Ports: <unset>");
      else {
        const rows = [["  Name", "Port", "Protocol"], ["  ----", "----", "--------"], ...e.ports.map((p) => [`  ${p.name || "<unset>"}`, p.port !== undefined ? String(p.port) : "<unset>", p.protocol ?? "TCP"])];
        lines.push("Ports:", baseTable(rows));
      }
      if (!e.endpoints?.length) lines.push("Endpoints: <none>");
      else {
        lines.push("Endpoints:");
        const opt = (v: string | undefined) => v ?? "<unset>";
        for (const ep of e.endpoints) {
          lines.push(`  - Addresses:  ${ep.addresses.join(", ") || "<none>"}`, "    Conditions:", `      Ready:  ${ep.conditions?.ready === undefined ? "<unset>" : String(ep.conditions.ready)}`);
          const rest: [string, string][] = [["Hostname:", opt(ep.hostname)], ...(ep.targetRef ? ([["TargetRef:", `${ep.targetRef.kind}/${ep.targetRef.name}`]] as [string, string][]) : []), ["NodeName:", opt(ep.nodeName)], ["Zone:", opt(ep.zone)]];
          const w = Math.max(...rest.map(([k]) => k.length)) + 2;
          lines.push(...rest.map(([k, v]) => `    ${k.padEnd(w)}${v}`));
        }
      }
      lines[0] = L("Name", e.metadata.name, 14);
      lines[1] = L("Namespace", ns, 14);
      break;
    }
    default:
      lines.push(L("Labels", labelsStr(o.metadata.labels)), L("Annotations", annotationsStr(o.metadata.annotations)));
  }
  // Secrets and NetworkPolicies describe without an Events section.
  if (kind !== "Secret" && kind !== "NetworkPolicy") lines.push(eventsBlock(c, o));
  return lines.join("\n");
}

/** The HPA's Conditions table: tabwriter columns sized to the longest cell, like kubectl's. */
function hpaConditions(conds: { type: string; status: string; reason?: string; message?: string }[]): string[] {
  const rows = [["Type", "Status", "Reason", "Message"], ["----", "------", "------", "-------"], ...conds.map((cd) => [cd.type, cd.status, cd.reason ?? "", cd.message ?? ""])];
  const w = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length)) + 2);
  return rows.map((r) => `  ${r[0].padEnd(w[0])}${r[1].padEnd(w[1])}${r[2].padEnd(w[2])}${r[3]}`);
}
