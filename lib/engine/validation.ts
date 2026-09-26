// API-server validation. Messages follow the real apiserver's format:
//   The Deployment "web" is invalid: spec.replicas: Invalid value: -1: must be ...
// and, for several errors, a "\n* " bullet list.

import { ApiError, type Cluster } from "./cluster";
import { usedNodePorts } from "./admission";
import type { AnyObject, Container, Deployment, LabelSelector, Pod, ReplicaSet, Service } from "./types";
import { deepEqual, isDns1123Label, isDns1123Subdomain, matchesSelector, stableStringify } from "./util";

const SUBDOMAIN_MSG =
  "a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character (e.g. 'example.com', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*')";
const LABEL_MSG =
  "a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character (e.g. 'my-name',  or '123-abc', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?')";
const DNS1035_MSG =
  "a DNS-1035 label must consist of lower case alphanumeric characters or '-', start with an alphabetic character, and end with an alphanumeric character (e.g. 'my-name',  or 'abc-123', regex used for validation is '[a-z]([-a-z0-9]*[a-z0-9])?')";

const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/;
const LABEL_KEY_NAME = /^([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]$/;

const fmt = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : v !== null && typeof v === "object" ? stableStringify(v) : String(v));

class Errs {
  list: string[] = [];
  required(path: string) {
    this.list.push(`${path}: Required value`);
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

function checkContainers(e: Errs, path: string, containers: Container[] | undefined) {
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
  });
}

function checkSelector(e: Errs, kind: string, sel: LabelSelector | undefined, tplLabels: Record<string, string> | undefined, prevSel?: LabelSelector) {
  const empty = !sel || (Object.keys(sel.matchLabels ?? {}).length === 0 && (sel.matchExpressions ?? []).length === 0);
  if (empty) {
    e.required("spec.selector");
    e.invalid("spec.selector", sel ?? {}, "empty selector is invalid for deployment");
  } else if (!matchesSelector(tplLabels, sel)) {
    e.invalid("spec.template.metadata.labels", tplLabels ?? {}, "`selector` does not match template `labels`");
  }
  if (prevSel && !deepEqual(prevSel, sel)) e.invalid("spec.selector", sel ?? {}, "field is immutable");
  void kind;
}

export function validate(cluster: Cluster, obj: AnyObject, prev: AnyObject | undefined): void {
  const e = new Errs();
  const name = obj.metadata?.name;
  if (!name) e.required("metadata.name");
  else if (obj.kind === "Service" ? !/^[a-z]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 63 : obj.kind === "Namespace" ? !isDns1123Label(name) : !isDns1123Subdomain(name)) {
    e.invalid("metadata.name", name, obj.kind === "Service" ? DNS1035_MSG : obj.kind === "Namespace" ? LABEL_MSG : SUBDOMAIN_MSG);
  }
  const ns = obj.metadata?.namespace;
  if (ns !== undefined && !isDns1123Label(ns)) e.invalid("metadata.namespace", ns, LABEL_MSG);
  checkLabels(e, "metadata.labels", obj.metadata?.labels);

  switch (obj.kind) {
    case "Pod": {
      const pod = obj as unknown as Pod;
      checkContainers(e, "spec", pod.spec?.containers);
      const rp = pod.spec?.restartPolicy;
      if (rp && !["Always", "OnFailure", "Never"].includes(rp)) e.unsupported("spec.restartPolicy", rp, ["Always", "OnFailure", "Never"]);
      if (prev) {
        // Pods are mostly immutable: only images (and a few fields we don't model) may change.
        const a = structuredClone((prev as unknown as Pod).spec!);
        const b = structuredClone(pod.spec!);
        for (const s of [a, b]) {
          s.containers = s.containers.map((c) => ({ ...c, image: "" }));
          delete s.nodeName;
          delete s.tolerations;
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
      const s = w.spec;
      if (!s) {
        e.required("spec");
        break;
      }
      if (s.replicas !== undefined && !(Number.isInteger(s.replicas) && s.replicas >= 0))
        e.invalid("spec.replicas", s.replicas, "must be greater than or equal to 0");
      if (!s.template) e.required("spec.template");
      checkSelector(e, obj.kind, s.selector, s.template?.metadata?.labels, (prev as unknown as Deployment | undefined)?.spec?.selector);
      checkLabels(e, "spec.template.metadata.labels", s.template?.metadata?.labels);
      checkContainers(e, "spec.template.spec", s.template?.spec?.containers);
      if (obj.kind === "Deployment") {
        const st = (s as Deployment["spec"])!.strategy;
        if (st && !["RollingUpdate", "Recreate"].includes(st.type)) e.unsupported("spec.strategy.type", st.type, ["Recreate", "RollingUpdate"]);
      }
      break;
    }
    case "Service": {
      const s = (obj as unknown as Service).spec;
      const type = s?.type ?? "ClusterIP";
      if (!["ClusterIP", "NodePort", "LoadBalancer", "ExternalName"].includes(type)) e.unsupported("spec.type", type, ["ClusterIP", "ExternalName", "LoadBalancer", "NodePort"]);
      if (!s?.ports || s.ports.length === 0) e.required("spec.ports");
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
  }

  if (e.list.length) {
    const head = `The ${obj.kind} "${name ?? ""}" is invalid: `;
    const msg = e.list.length === 1 ? head + e.list[0] : head + "\n" + e.list.map((l) => `* ${l}`).join("\n");
    throw new ApiError(msg, "Invalid");
  }
}
