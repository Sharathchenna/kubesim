// Fields the API server accepts and stores but the Simulated Cluster does not act on.
// A real cluster would act on them, so instead of ignoring them silently the API
// returns a warning (like the apiserver's `Warning:` response header); kubectl prints
// each one as `Warning: <text>`. See Cluster.warn / Cluster.drainWarnings.

import type { AnyObject, PodSpec } from "./types";

const NOT_SIMULATED = "is not simulated by kubesim (accepted and stored, but has no effect)";

/** securityContext fields the simulator honours (exec.ts `id`/`whoami`, the kubelet, fs.ts). */
const POD_SC_OK = new Set(["runAsUser", "runAsGroup", "runAsNonRoot"]);
const CONTAINER_SC_OK = new Set(["runAsUser", "runAsGroup", "runAsNonRoot", "readOnlyRootFilesystem"]);

function podSpecWarnings(spec: PodSpec | undefined, path: string): string[] {
  if (!spec) return [];
  const out: string[] = [];
  const all = [...(spec.initContainers ?? []).map((c, i) => ({ c, p: `${path}.initContainers[${i}]` })), ...(spec.containers ?? []).map((c, i) => ({ c, p: `${path}.containers[${i}]` }))];
  for (const { c, p } of all) {
    if (c.lifecycle) out.push(`${p}.lifecycle: lifecycle hooks (postStart, preStop) ${NOT_SIMULATED}`);
    const sc = (c as { securityContext?: Record<string, unknown> }).securityContext;
    for (const k of Object.keys(sc ?? {})) if (!CONTAINER_SC_OK.has(k)) out.push(`${p}.securityContext.${k} ${NOT_SIMULATED}`);
  }
  for (const k of Object.keys(spec.securityContext ?? {})) if (!POD_SC_OK.has(k)) out.push(`${path}.securityContext.${k} ${NOT_SIMULATED}`);
  if (spec.resources) out.push(`${path}.resources: pod-level resources ${NOT_SIMULATED}`);
  const ext = spec as PodSpec & { dnsConfig?: unknown };
  if (ext.dnsConfig) out.push(`${path}.dnsConfig ${NOT_SIMULATED}`);
  if (spec.dnsPolicy === "None" || spec.dnsPolicy === "Default") out.push(`${path}.dnsPolicy: ${spec.dnsPolicy} ${NOT_SIMULATED}; Pods always use cluster DNS`);
  return out;
}

/** Warnings for one object about to be stored. */
export function unsupportedWarnings(obj: AnyObject): string[] {
  const spec = obj.spec as Record<string, unknown> | undefined;
  switch (obj.kind) {
    case "Pod":
      return podSpecWarnings(spec as unknown as PodSpec, "spec");
    case "Deployment":
    case "ReplicaSet":
    case "DaemonSet":
      return podSpecWarnings((spec?.template as { spec?: PodSpec } | undefined)?.spec, "spec.template.spec");
    case "StatefulSet": {
      const out = podSpecWarnings((spec?.template as { spec?: PodSpec } | undefined)?.spec, "spec.template.spec");
      if (spec?.ordinals) out.push(`spec.ordinals ${NOT_SIMULATED}; ordinals start at 0`);
      return out;
    }
    case "Job":
    case "CronJob": {
      const js = (obj.kind === "Job" ? spec : (spec?.jobTemplate as { spec?: Record<string, unknown> } | undefined)?.spec) as Record<string, unknown> | undefined;
      const base = obj.kind === "Job" ? "spec" : "spec.jobTemplate.spec";
      const out = podSpecWarnings((js?.template as { spec?: PodSpec } | undefined)?.spec, `${base}.template.spec`);
      for (const k of ["podFailurePolicy", "successPolicy", "backoffLimitPerIndex", "maxFailedIndexes"]) if (js?.[k] !== undefined) out.push(`${base}.${k} ${NOT_SIMULATED}`);
      return out;
    }
    case "Service": {
      const out: string[] = [];
      if (spec?.sessionAffinity === "ClientIP") out.push(`spec.sessionAffinity: ClientIP ${NOT_SIMULATED}; requests are spread across endpoints`);
      if (spec?.externalTrafficPolicy === "Local") out.push(`spec.externalTrafficPolicy: Local ${NOT_SIMULATED}`);
      if (spec?.internalTrafficPolicy === "Local") out.push(`spec.internalTrafficPolicy: Local ${NOT_SIMULATED}`);
      return out;
    }
    case "Ingress":
      return spec?.tls ? [`spec.tls ${NOT_SIMULATED}; the Ingress controller serves plain HTTP only`] : [];
    case "HorizontalPodAutoscaler":
      return ((spec?.metrics as { type: string; resource?: { name: string } }[] | undefined) ?? []).flatMap((m, i) =>
        m.type !== "Resource" || !["cpu", "memory"].includes(m.resource?.name ?? "") ? [`spec.metrics[${i}]: ${m.type} metrics ${NOT_SIMULATED}; only Resource cpu and memory are`] : [],
      );
  }
  return [];
}
