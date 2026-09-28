// API-server validation. Messages follow the real apiserver's format:
//   The Deployment "web" is invalid: spec.replicas: Invalid value: -1: must be ...
// and, for several errors, a "\n* " bullet list.

import { ApiError, type Cluster } from "./cluster";
import { usedNodePorts } from "./admission";
import { parseCron, validTimeZone } from "./controllers/cronjob";
import { isQuantity, parseQuantity } from "./quantity";
import type {
  AnyObject,
  Container,
  CronJob,
  DaemonSet,
  Deployment,
  HorizontalPodAutoscaler,
  Ingress,
  Job,
  LabelSelector,
  PersistentVolume,
  PersistentVolumeClaim,
  Pod,
  PodSpec,
  Probe,
  ReplicaSet,
  Role,
  RoleBinding,
  Service,
  StatefulSet,
} from "./types";
import { deepEqual, isDns1123Label, isDns1123Subdomain, matchesSelector, stableStringify } from "./util";

const SUBDOMAIN_MSG =
  "a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character (e.g. 'example.com', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*')";
const LABEL_MSG =
  "a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character (e.g. 'my-name',  or '123-abc', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?')";
const DNS1035_MSG =
  "a DNS-1035 label must consist of lower case alphanumeric characters or '-', start with an alphabetic character, and end with an alphanumeric character (e.g. 'my-name',  or 'abc-123', regex used for validation is '[a-z]([-a-z0-9]*[a-z0-9])?')";
const QUANTITY_MSG = "quantities must match the regular expression '^([+-]?[0-9.]+)([eEinumkKMGTP]*[-+]?[0-9]*)$'";
const CONFIG_KEY_MSG = "a valid config key must consist of alphanumeric characters, '-', '_' or '.' (e.g. 'key.name',  or 'KEY_NAME',  or 'key-name', regex used for validation is '[-._a-zA-Z0-9]+')";

const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/;
const LABEL_KEY_NAME = /^([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]$/;

const fmt = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : v !== null && typeof v === "object" ? stableStringify(v) : String(v));

class Errs {
  list: string[] = [];
  required(path: string, detail?: string) {
    this.list.push(`${path}: Required value${detail ? `: ${detail}` : ""}`);
  }
  invalid(path: string, value: unknown, msg: string) {
    this.list.push(`${path}: Invalid value: ${fmt(value)}: ${msg}`);
  }
  unsupported(path: string, value: unknown, allowed: string[]) {
    this.list.push(`${path}: Unsupported value: ${fmt(value)}: supported values: ${allowed.map((a) => `"${a}"`).join(", ")}`);
  }
  forbidden(path: string, msg: string) {
    this.list.push(`${path}: Forbidden: ${msg}`);
  }
  notFound(path: string, value: unknown) {
    this.list.push(`${path}: Not found: ${fmt(value)}`);
  }
}

function checkLabels(e: Errs, path: string, labels: Record<string, string> | undefined) {
  for (const [k, v] of Object.entries(labels ?? {})) {
    const name = k.includes("/") ? k.slice(k.indexOf("/") + 1) : k;
    const prefix = k.includes("/") ? k.slice(0, k.indexOf("/")) : undefined;
    if (!LABEL_KEY_NAME.test(name) || name.length > 63 || (prefix !== undefined && !isDns1123Subdomain(prefix))) {
      e.invalid(path, k, "name part must consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyName',  or 'my.name',  or '123-abc', regex used for validation is '([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]')");
    }
    if (typeof v !== "string" || v.length > 63 || !LABEL_VALUE.test(v)) {
      e.invalid(`${path}`, v, "a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyValue',  or 'my_value',  or '12345', regex used for validation is '(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?')");
    }
  }
}

function checkProbe(e: Errs, path: string, p: Probe | undefined, kind: "liveness" | "readiness" | "startup") {
  if (!p) return;
  const handlers = [p.exec, p.httpGet, p.tcpSocket, p.grpc].filter(Boolean).length;
  if (handlers === 0) e.required(path, "must specify a handler type");
  else if (handlers > 1) e.forbidden(path, "may not specify more than 1 handler type");
  if (p.httpGet && (p.httpGet.port === undefined || p.httpGet.port === "")) e.required(`${path}.httpGet.port`);
  if (p.tcpSocket && (p.tcpSocket.port === undefined || p.tcpSocket.port === "")) e.required(`${path}.tcpSocket.port`);
  if (p.exec && (!p.exec.command || p.exec.command.length === 0)) e.required(`${path}.exec.command`);
  if (kind !== "readiness" && p.successThreshold !== undefined && p.successThreshold !== 1) e.invalid(`${path}.successThreshold`, p.successThreshold, "must be 1");
  for (const k of ["initialDelaySeconds", "periodSeconds", "timeoutSeconds", "successThreshold", "failureThreshold"] as const) {
    const v = p[k];
    if (v !== undefined && !(Number.isInteger(v) && v >= (k === "initialDelaySeconds" ? 0 : 1))) e.invalid(`${path}.${k}`, v, k === "initialDelaySeconds" ? "must be greater than or equal to 0" : "must be greater than or equal to 1");
  }
}

function checkResources(e: Errs, path: string, c: Container) {
  const r = c.resources;
  if (!r) return;
  for (const part of ["requests", "limits"] as const) {
    for (const [k, v] of Object.entries(r[part] ?? {})) {
      if (!isQuantity(v)) e.invalid(`${path}.resources.${part}[${k}]`, v, QUANTITY_MSG);
      else if (parseQuantity(v) < 0) e.invalid(`${path}.resources.${part}[${k}]`, v, "must be greater than or equal to 0");
    }
  }
  for (const k of ["cpu", "memory"]) {
    const req = r.requests?.[k];
    const lim = r.limits?.[k];
    if (req !== undefined && lim !== undefined && isQuantity(req) && isQuantity(lim) && parseQuantity(req) > parseQuantity(lim)) {
      e.invalid(`${path}.resources.requests`, req, `must be less than or equal to ${k} limit of ${lim}`);
    }
  }
}

function checkContainers(e: Errs, path: string, containers: Container[] | undefined, volumes: Set<string>) {
  if (!containers || containers.length === 0) return e.required(`${path}.containers`);
  const seen = new Set<string>();
  containers.forEach((c, i) => {
    const p = `${path}.containers[${i}]`;
    if (!c.name) e.required(`${p}.name`);
    else if (!isDns1123Label(c.name)) e.invalid(`${p}.name`, c.name, LABEL_MSG);
    else if (seen.has(c.name)) e.list.push(`${p}.name: Duplicate value: ${fmt(c.name)}`);
    if (c.name) seen.add(c.name);
    if (!c.image || !String(c.image).trim()) e.required(`${p}.image`);
    for (const [j, port] of (c.ports ?? []).entries()) {
      if (!(port.containerPort >= 1 && port.containerPort <= 65535))
        e.invalid(`${p}.ports[${j}].containerPort`, port.containerPort, "must be between 1 and 65535, inclusive");
    }
    (c.volumeMounts ?? []).forEach((m, j) => {
      if (!m.name) e.required(`${p}.volumeMounts[${j}].name`);
      else if (!volumes.has(m.name)) e.notFound(`${p}.volumeMounts[${j}].name`, m.name);
      if (!m.mountPath) e.required(`${p}.volumeMounts[${j}].mountPath`);
    });
    (c.env ?? []).forEach((v, j) => {
      if (!v.name) e.required(`${p}.env[${j}].name`);
      if (v.value !== undefined && v.valueFrom) e.invalid(`${p}.env[${j}].valueFrom`, "", "may not be specified when `value` is not empty");
    });
    checkProbe(e, `${p}.livenessProbe`, c.livenessProbe, "liveness");
    checkProbe(e, `${p}.readinessProbe`, c.readinessProbe, "readiness");
    checkProbe(e, `${p}.startupProbe`, c.startupProbe, "startup");
    checkResources(e, p, c);
  });
}

function checkPodSpec(e: Errs, path: string, spec: PodSpec | undefined, claimTemplates: string[] = []) {
  const vols = new Set<string>(claimTemplates);
  (spec?.volumes ?? []).forEach((v, i) => {
    if (!v.name) e.required(`${path}.volumes[${i}].name`);
    else if (vols.has(v.name)) e.list.push(`${path}.volumes[${i}].name: Duplicate value: ${fmt(v.name)}`);
    vols.add(v.name);
    const sources = [v.configMap, v.secret, v.persistentVolumeClaim, v.emptyDir, v.hostPath, v.projected].filter((x) => x !== undefined).length;
    if (sources === 0) e.required(`${path}.volumes[${i}]`, "must specify a volume type");
    if (v.persistentVolumeClaim && !v.persistentVolumeClaim.claimName) e.required(`${path}.volumes[${i}].persistentVolumeClaim.claimName`);
    if (v.configMap && !v.configMap.name) e.required(`${path}.volumes[${i}].configMap.name`);
    if (v.secret && !v.secret.secretName) e.required(`${path}.volumes[${i}].secret.secretName`);
  });
  checkContainers(e, path, spec?.containers, vols);
  const rp = spec?.restartPolicy;
  if (rp && !["Always", "OnFailure", "Never"].includes(rp)) e.unsupported(`${path}.restartPolicy`, rp, ["Always", "OnFailure", "Never"]);
}

function checkSelector(e: Errs, kind: string, sel: LabelSelector | undefined, tplLabels: Record<string, string> | undefined, prevSel?: LabelSelector) {
  const empty = !sel || (Object.keys(sel.matchLabels ?? {}).length === 0 && (sel.matchExpressions ?? []).length === 0);
  if (empty) {
    e.required("spec.selector");
    e.invalid("spec.selector", sel ?? {}, `empty selector is invalid for ${kind.toLowerCase()}`);
  } else if (!matchesSelector(tplLabels, sel)) {
    e.invalid("spec.template.metadata.labels", tplLabels ?? {}, "`selector` does not match template `labels`");
  }
  if (prevSel && !deepEqual(prevSel, sel)) e.invalid("spec.selector", sel ?? {}, "field is immutable");
}

function checkWorkload(e: Errs, kind: string, s: (Deployment | ReplicaSet | StatefulSet | DaemonSet)["spec"], prevSel?: LabelSelector, claimTemplates: string[] = []) {
  if (!s) return e.required("spec");
  const replicas = (s as { replicas?: number }).replicas;
  if (replicas !== undefined && !(Number.isInteger(replicas) && replicas >= 0)) e.invalid("spec.replicas", replicas, "must be greater than or equal to 0");
  if (!s.template) e.required("spec.template");
  checkSelector(e, kind, s.selector, s.template?.metadata?.labels, prevSel);
  checkLabels(e, "spec.template.metadata.labels", s.template?.metadata?.labels);
  checkPodSpec(e, "spec.template.spec", s.template?.spec, claimTemplates);
}

const b64ok = (s: string) => /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0;

export function validate(cluster: Cluster, obj: AnyObject, prev: AnyObject | undefined): void {
  const e = new Errs();
  const name = obj.metadata?.name;
  if (!name) e.required("metadata.name");
  else if (obj.kind === "Service" ? !/^[a-z]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 63 : obj.kind === "Namespace" ? !isDns1123Label(name) : !isDns1123Subdomain(name) && !["Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding"].includes(obj.kind)) {
    e.invalid("metadata.name", name, obj.kind === "Service" ? DNS1035_MSG : obj.kind === "Namespace" ? LABEL_MSG : SUBDOMAIN_MSG);
  }
  const ns = obj.metadata?.namespace;
  if (ns !== undefined && !isDns1123Label(ns)) e.invalid("metadata.namespace", ns, LABEL_MSG);
  checkLabels(e, "metadata.labels", obj.metadata?.labels);

  switch (obj.kind) {
    case "Pod": {
      const pod = obj as unknown as Pod;
      checkPodSpec(e, "spec", pod.spec);
      if (prev) {
        // Pods are mostly immutable: only images (and a few fields we don't model) may change.
        const a = structuredClone((prev as unknown as Pod).spec!);
        const b = structuredClone(pod.spec!);
        for (const s of [a, b]) {
          s.containers = s.containers.map((c) => ({ ...c, image: "" }));
          delete s.nodeName;
          delete s.tolerations;
          delete s.activeDeadlineSeconds;
        }
        if (!deepEqual(a, b)) {
          e.forbidden(
            "spec",
            "pod updates may not change fields other than `spec.containers[*].image`,`spec.initContainers[*].image`,`spec.activeDeadlineSeconds`,`spec.tolerations` (only additions to existing tolerations),`spec.terminationGracePeriodSeconds` (allow it to be set to 1 if it was previously negative)",
          );
        }
      }
      break;
    }
    case "ReplicaSet":
    case "Deployment": {
      const w = obj as unknown as Deployment | ReplicaSet;
      checkWorkload(e, obj.kind, w.spec, (prev as unknown as Deployment | undefined)?.spec?.selector);
      if (obj.kind === "Deployment") {
        const st = (w.spec as Deployment["spec"])?.strategy;
        if (st?.type !== undefined && !["RollingUpdate", "Recreate"].includes(st.type)) e.unsupported("spec.strategy.type", st.type, ["Recreate", "RollingUpdate"]);
      }
      break;
    }
    case "StatefulSet": {
      const st = obj as unknown as StatefulSet;
      checkWorkload(e, obj.kind, st.spec, (prev as unknown as StatefulSet | undefined)?.spec?.selector, (st.spec?.volumeClaimTemplates ?? []).map((v) => v.metadata?.name));
      const pm = st.spec?.podManagementPolicy;
      if (pm && !["OrderedReady", "Parallel"].includes(pm)) e.unsupported("spec.podManagementPolicy", pm, ["OrderedReady", "Parallel"]);
      (st.spec?.volumeClaimTemplates ?? []).forEach((v, i) => {
        if (!v.metadata?.name) e.required(`spec.volumeClaimTemplates[${i}].metadata.name`);
        if (!v.spec?.accessModes?.length) e.required(`spec.volumeClaimTemplates[${i}].spec.accessModes`, "at least 1 access mode is required");
        if (!v.spec?.resources?.requests?.storage) e.required(`spec.volumeClaimTemplates[${i}].spec.resources[storage]`);
      });
      if (prev) {
        const a = structuredClone((prev as unknown as StatefulSet).spec!);
        const b = structuredClone(st.spec!);
        for (const s of [a, b] as Partial<StatefulSet["spec"] & object>[]) {
          delete s.replicas;
          delete s.template;
          delete s.updateStrategy;
          delete s.persistentVolumeClaimRetentionPolicy;
          delete s.minReadySeconds;
        }
        if (!deepEqual(a, b)) e.forbidden("spec", "updates to statefulset spec for fields other than 'replicas', 'ordinals', 'template', 'updateStrategy', 'persistentVolumeClaimRetentionPolicy' and 'minReadySeconds' are forbidden");
      }
      break;
    }
    case "DaemonSet": {
      const ds = obj as unknown as DaemonSet;
      checkWorkload(e, obj.kind, ds.spec, (prev as unknown as DaemonSet | undefined)?.spec?.selector);
      break;
    }
    case "Job": {
      const job = obj as unknown as Job;
      const s = job.spec;
      if (!s?.template) {
        e.required("spec.template");
        break;
      }
      checkLabels(e, "spec.template.metadata.labels", s.template.metadata?.labels);
      checkPodSpec(e, "spec.template.spec", s.template.spec);
      const rp = s.template.spec?.restartPolicy;
      if (rp !== "OnFailure" && rp !== "Never") e.unsupported("spec.template.spec.restartPolicy", rp ?? "Always", ["OnFailure", "Never"]);
      for (const k of ["parallelism", "completions", "backoffLimit", "activeDeadlineSeconds", "ttlSecondsAfterFinished"] as const) {
        const v = s[k];
        if (v !== undefined && v !== null && !(Number.isInteger(v) && v >= (k === "activeDeadlineSeconds" ? 1 : 0))) e.invalid(`spec.${k}`, v, `must be greater than or equal to ${k === "activeDeadlineSeconds" ? 1 : 0}`);
      }
      if (s.completionMode === "Indexed" && (s.completions === undefined || s.completions === null)) e.required("spec.completions", "when completion mode is Indexed");
      if (prev) {
        const pt = (prev as unknown as Job).spec!.template;
        if (!deepEqual(pt, s.template) && !(prev as unknown as Job).spec?.suspend) e.invalid("spec.template", "core.PodTemplateSpec{…}", "field is immutable");
        const pc = (prev as unknown as Job).spec!.completions;
        if (pc !== s.completions && s.completionMode !== "Indexed") e.invalid("spec.completions", s.completions ?? null, "field is immutable");
      }
      break;
    }
    case "CronJob": {
      const cj = obj as unknown as CronJob;
      const sched = cj.spec?.schedule;
      if (!sched) e.required("spec.schedule");
      else if (/^(TZ|CRON_TZ)=/.test(sched.trim())) e.invalid("spec.schedule", sched, "cannot use TZ or CRON_TZ in schedule, use timeZone field instead");
      else if (!parseCron(sched)) {
        const f = sched.trim().split(/\s+/);
        e.invalid("spec.schedule", sched, f.length !== 5 && !sched.trim().startsWith("@") ? `expected exactly 5 fields, found ${f.length}: [${f.join(" ")}]` : `unparseable schedule: ${sched}`);
      }
      const tz = cj.spec?.timeZone;
      if (tz !== undefined && !validTimeZone(tz)) e.invalid("spec.timeZone", tz, `unknown time zone ${tz}`);
      if (name && name.length > 52) e.invalid("metadata.name", name, "must be no more than 52 characters");
      const cp = cj.spec?.concurrencyPolicy;
      if (cp && !["Allow", "Forbid", "Replace"].includes(cp)) e.unsupported("spec.concurrencyPolicy", cp, ["Allow", "Forbid", "Replace"]);
      const tpl = cj.spec?.jobTemplate?.spec?.template;
      if (!tpl) e.required("spec.jobTemplate.spec.template");
      else {
        checkPodSpec(e, "spec.jobTemplate.spec.template.spec", tpl.spec);
        const rp = tpl.spec?.restartPolicy;
        if (rp !== "OnFailure" && rp !== "Never") e.unsupported("spec.jobTemplate.spec.template.spec.restartPolicy", rp ?? "Always", ["OnFailure", "Never"]);
      }
      break;
    }
    case "HorizontalPodAutoscaler": {
      const h = obj as unknown as HorizontalPodAutoscaler;
      const s = h.spec;
      if (!s?.scaleTargetRef?.kind) e.required("spec.scaleTargetRef.kind");
      if (!s?.scaleTargetRef?.name) e.required("spec.scaleTargetRef.name");
      if (!s?.maxReplicas) e.required("spec.maxReplicas");
      else if ((s.minReplicas ?? 1) > s.maxReplicas) e.invalid("spec.maxReplicas", s.maxReplicas, "must be greater than or equal to `minReplicas`");
      if (s?.minReplicas !== undefined && s.minReplicas < 1) e.invalid("spec.minReplicas", s.minReplicas, "must be greater than or equal to 1");
      break;
    }
    case "Service": {
      const s = (obj as unknown as Service).spec;
      const type = s?.type ?? "ClusterIP";
      if (!["ClusterIP", "NodePort", "LoadBalancer", "ExternalName"].includes(type)) e.unsupported("spec.type", type, ["ClusterIP", "ExternalName", "LoadBalancer", "NodePort"]);
      if (type === "ExternalName") {
        if (!s?.externalName) e.required("spec.externalName");
        break;
      }
      const headless = s?.clusterIP === "None";
      if (headless && type !== "ClusterIP") e.invalid("spec.clusterIPs[0]", "None", `may not be set to 'None' for ${type} services`);
      if ((!s?.ports || s.ports.length === 0) && !headless) e.required("spec.ports");
      const used = usedNodePorts(cluster, prev?.metadata.uid);
      const names = new Set<string>();
      (s?.ports ?? []).forEach((p, i) => {
        const path = `spec.ports[${i}]`;
        if ((s?.ports?.length ?? 0) > 1 && !p.name) e.required(`${path}.name`);
        if (p.name) {
          if (names.has(p.name)) e.list.push(`${path}.name: Duplicate value: ${fmt(p.name)}`);
          names.add(p.name);
        }
        if (!(Number.isInteger(p.port) && p.port >= 1 && p.port <= 65535)) e.invalid(`${path}.port`, p.port, "must be between 1 and 65535, inclusive");
        if (typeof p.targetPort === "number" && !(p.targetPort >= 1 && p.targetPort <= 65535))
          e.invalid(`${path}.targetPort`, p.targetPort, "must be between 1 and 65535, inclusive");
        if (p.nodePort !== undefined) {
          if (type === "ClusterIP") e.forbidden(`${path}.nodePort`, "may not be used when `type` is 'ClusterIP'");
          else if (p.nodePort < 30000 || p.nodePort > 32767)
            e.invalid(`${path}.nodePort`, p.nodePort, "provided port is not in the valid range. The range of valid ports is 30000-32767");
          else if (used.has(p.nodePort)) e.invalid(`${path}.nodePort`, p.nodePort, "provided port is already allocated");
        }
      });
      const prevIp = (prev as unknown as Service | undefined)?.spec?.clusterIP;
      if (prevIp && s?.clusterIP && s.clusterIP !== prevIp) e.invalid("spec.clusterIP", s.clusterIP, "field is immutable");
      break;
    }
    case "ConfigMap":
    case "Secret": {
      type Data = { data?: Record<string, string>; stringData?: Record<string, string>; binaryData?: Record<string, string>; immutable?: boolean };
      const o = obj as unknown as Data;
      for (const k of [...Object.keys(o.data ?? {}), ...Object.keys(o.stringData ?? {}), ...Object.keys(o.binaryData ?? {})]) {
        if (!/^[-._a-zA-Z0-9]+$/.test(k)) e.invalid(`data[${k}]`, k, CONFIG_KEY_MSG);
      }
      if (obj.kind === "Secret") {
        for (const [k, v] of Object.entries(o.data ?? {})) {
          if (typeof v !== "string" || !b64ok(v)) {
            throw new ApiError(`Error from server (BadRequest): Secret in version "v1" cannot be handled as a Secret: illegal base64 data at input byte ${Math.max(0, String(v).search(/[^A-Za-z0-9+/=]/))} (key "${k}")`, "BadRequest");
          }
        }
      }
      const p = prev as unknown as Data | undefined;
      if (p?.immutable) {
        if (!deepEqual(p.data, o.data) || !deepEqual(p.binaryData, o.binaryData)) e.forbidden("data", "field is immutable when `immutable` is set");
        if (o.immutable !== true) e.forbidden("immutable", "field is immutable when `immutable` is set");
      }
      break;
    }
    case "PersistentVolumeClaim": {
      const pvc = obj as unknown as PersistentVolumeClaim;
      if (!pvc.spec?.accessModes?.length) e.required("spec.accessModes", "at least 1 access mode is required");
      for (const m of pvc.spec?.accessModes ?? []) if (!["ReadWriteOnce", "ReadOnlyMany", "ReadWriteMany", "ReadWriteOncePod"].includes(m)) e.unsupported("spec.accessModes", m, ["ReadOnlyMany", "ReadWriteMany", "ReadWriteOnce", "ReadWriteOncePod"]);
      const st = pvc.spec?.resources?.requests?.storage;
      if (!st) e.required("spec.resources[storage]");
      else if (!isQuantity(st)) e.invalid("spec.resources.requests[storage]", st, QUANTITY_MSG);
      if (prev) {
        const a = structuredClone((prev as unknown as PersistentVolumeClaim).spec!);
        const b = structuredClone(pvc.spec!);
        for (const s of [a, b]) {
          delete s.resources;
          delete s.volumeName;
        }
        if (!deepEqual(a, b)) e.forbidden("spec", "spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims");
      }
      break;
    }
    case "PersistentVolume": {
      const pv = obj as unknown as PersistentVolume;
      if (!pv.spec?.capacity?.storage) e.required("spec.capacity");
      if (!pv.spec?.accessModes?.length) e.required("spec.accessModes");
      if (!pv.spec?.hostPath && !pv.spec?.local) e.required("spec", "must specify a volume type");
      break;
    }
    case "Ingress": {
      const ing = obj as unknown as Ingress;
      (ing.spec?.rules ?? []).forEach((r, i) => {
        (r.http?.paths ?? []).forEach((p, j) => {
          const path = `spec.rules[${i}].http.paths[${j}]`;
          if (!p.pathType) e.required(`${path}.pathType`, "pathType must be specified");
          else if (!["Exact", "Prefix", "ImplementationSpecific"].includes(p.pathType)) e.unsupported(`${path}.pathType`, p.pathType, ["Exact", "ImplementationSpecific", "Prefix"]);
          if (p.path && !p.path.startsWith("/") && p.pathType !== "ImplementationSpecific") e.invalid(`${path}.path`, p.path, "must be an absolute path");
          const svc = p.backend?.service;
          if (!svc && !p.backend?.resource) e.invalid(`${path}.backend`, "", "resource or service backend is required");
          if (svc && svc.port?.number === undefined && !svc.port?.name) e.required(`${path}.backend`, "port name or number is required");
          if (svc && svc.port?.number !== undefined && svc.port?.name) e.invalid(`${path}.backend`, "", "cannot set both port name & port number");
        });
        if (r.host && (r.host.includes(":") || !/^(\*\.)?[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/.test(r.host))) e.invalid(`spec.rules[${i}].host`, r.host, SUBDOMAIN_MSG);
      });
      if (!ing.spec?.rules?.length && !ing.spec?.defaultBackend) e.invalid("spec", "", "either `defaultBackend` or `rules` must be specified");
      break;
    }
    case "Role":
    case "ClusterRole": {
      const r = obj as unknown as Role;
      (r.rules ?? []).forEach((rule, i) => {
        if (!rule.verbs?.length) e.required(`rules[${i}].verbs`, "verbs must contain at least one value");
        if (!rule.nonResourceURLs?.length && !rule.apiGroups) e.required(`rules[${i}].apiGroups`, "resource rules must supply at least one api group");
        if (!rule.nonResourceURLs?.length && !rule.resources?.length) e.required(`rules[${i}].resources`, "resource rules must supply at least one resource");
        if (rule.nonResourceURLs?.length && obj.kind === "Role") e.invalid(`rules[${i}].nonResourceURLs`, rule.nonResourceURLs, "namespaced rules cannot apply to non-resource URLs");
      });
      break;
    }
    case "RoleBinding":
    case "ClusterRoleBinding": {
      const b = obj as unknown as RoleBinding;
      if (!b.roleRef?.name) e.required("roleRef.name");
      if (b.roleRef && !["Role", "ClusterRole"].includes(b.roleRef.kind)) e.unsupported("roleRef.kind", b.roleRef.kind, obj.kind === "RoleBinding" ? ["Role", "ClusterRole"] : ["ClusterRole"]);
      if (obj.kind === "ClusterRoleBinding" && b.roleRef?.kind === "Role") e.unsupported("roleRef.kind", "Role", ["ClusterRole"]);
      const pr = (prev as unknown as RoleBinding | undefined)?.roleRef;
      if (pr && !deepEqual(pr, b.roleRef)) e.invalid("roleRef", b.roleRef, "field is immutable");
      (b.subjects ?? []).forEach((s, i) => {
        if (!["User", "Group", "ServiceAccount"].includes(s.kind)) e.unsupported(`subjects[${i}].kind`, s.kind, ["ServiceAccount", "User", "Group"]);
        if (!s.name) e.required(`subjects[${i}].name`);
        if (s.kind === "ServiceAccount" && obj.kind === "ClusterRoleBinding" && !s.namespace) e.required(`subjects[${i}].namespace`);
      });
      break;
    }
  }

  if (e.list.length) {
    const head = `The ${obj.kind} "${name ?? ""}" is invalid: `;
    const msg = e.list.length === 1 ? head + e.list[0] : head + "\n" + e.list.map((l) => `* ${l}`).join("\n");
    throw new ApiError(msg, "Invalid");
  }
}
