// horizontal-pod-autoscaler (autoscaling/v2), resource metrics only. Every
// 15s: desired = ceil(current × usage/target) over the target's Pods, skipped
// within 10% tolerance; missing metrics count as 0% when scaling up and as
// 100% when scaling down; scale-up is limited to max(4 Pods, 100%) per 15s;
// scale-down uses the highest recommendation of the last 5 minutes (or
// behavior.scaleDown.stabilizationWindowSeconds).
// Behaviour reference v2 §6.

import { isPodReady, isPodTerminal, type Cluster } from "../cluster";
import { containerRequests } from "../quantity";
import type { Condition, Deployment, HorizontalPodAutoscaler, Pod } from "../types";
import { matchesSelectorString } from "../util";
import { metricsAvailable } from "./metrics";

const SYNC_MS = 15_000;
const TOLERANCE = 0.1;
const DOWN_WINDOW_MS = 300_000;

type Scalable = { kind: string; spec?: { replicas?: number; selector?: { matchLabels?: Record<string, string>; matchExpressions?: never[] } }; metadata: { name: string; namespace?: string } };

function setCond(conds: Condition[], c: Omit<Condition, "lastTransitionTime">, now: number): Condition[] {
  const old = conds.find((x) => x.type === c.type);
  const next = { ...c, lastTransitionTime: old && old.status === c.status ? old.lastTransitionTime : now };
  return [...conds.filter((x) => x.type !== c.type), next].sort((a, b) => ["AbleToScale", "ScalingActive", "ScalingLimited"].indexOf(a.type) - ["AbleToScale", "ScalingActive", "ScalingLimited"].indexOf(b.type));
}

export function runHPAs(cluster: Cluster): void {
  const now = cluster.now;
  if (now % SYNC_MS !== 0) return;
  for (const hpa of cluster.list<HorizontalPodAutoscaler>("HorizontalPodAutoscaler")) {
    const ns = hpa.metadata.namespace!;
    const ref = hpa.spec!.scaleTargetRef;
    const target = cluster.raw(ref.kind, ns, ref.name) as unknown as Scalable | undefined;
    let conds = hpa.status?.conditions ?? [];
    const min = hpa.spec!.minReplicas ?? 1;
    const max = hpa.spec!.maxReplicas;
    const write = (patch: Partial<NonNullable<HorizontalPodAutoscaler["status"]>>) =>
      cluster.update(cluster.get<HorizontalPodAutoscaler>("HorizontalPodAutoscaler", ns, hpa.metadata.name), (x) => {
        x.status = { currentReplicas: 0, desiredReplicas: 0, ...(x.status ?? {}), ...patch, conditions: conds };
      });

    if (!target) {
      conds = setCond(conds, { type: "AbleToScale", status: "False", reason: "FailedGetScale", message: `the HPA controller was unable to get the target's current scale: ${ref.kind.toLowerCase()}s.apps "${ref.name}" not found` }, now);
      cluster.record(hpa, "Warning", "FailedGetScale", `${ref.kind.toLowerCase()}s.apps "${ref.name}" not found`, "horizontal-pod-autoscaler");
      write({});
      continue;
    }
    const current = target.spec?.replicas ?? 1;
    conds = setCond(conds, { type: "AbleToScale", status: "True", reason: "SucceededGetScale", message: "the HPA controller was able to get the target's current scale" }, now);
    const metric = (hpa.spec!.metrics ?? []).find((m) => m.type === "Resource" && m.resource);
    const resName = metric?.resource?.name ?? "cpu";
    const targetUtil = metric?.resource?.target.averageUtilization ?? 80;

    // HPA leaves a target with 0 replicas alone.
    if (current === 0) {
      conds = setCond(conds, { type: "ScalingActive", status: "False", reason: "ScalingDisabled", message: "scaling is disabled since the replica count of the target is zero" }, now);
      write({ currentReplicas: 0, desiredReplicas: 0 });
      continue;
    }

    const sel = target.spec?.selector ?? {};
    const pods = cluster.list<Pod>("Pod", ns).filter((p) => !isPodTerminal(p) && p.metadata.deletionTimestamp === undefined && matchesSelectorString(p.metadata.labels, sel));
    const noRequest = pods.flatMap((p) => p.spec!.containers.filter((c) => !(resName === "cpu" ? containerRequests(c).cpu : containerRequests(c).memory)).map((c) => ({ p, c })));
    const rescale = (to: number, why: string) => {
      const t = cluster.get<Deployment>(ref.kind, ns, ref.name);
      cluster.replace({ ...t, spec: { ...t.spec!, replicas: to } } as Deployment);
      cluster.record(hpa, "Normal", "SuccessfulRescale", `New size: ${to}; reason: ${why}`, "horizontal-pod-autoscaler");
    };
    const fail = (reason: string, message: string) => {
      conds = setCond(conds, { type: "ScalingActive", status: "False", reason, message: `the HPA was unable to compute the replica count: ${message}` }, now);
      cluster.record(hpa, "Warning", reason, message, "horizontal-pod-autoscaler");
      cluster.record(hpa, "Warning", "FailedComputeMetricsReplicas", `invalid metrics (1 invalid out of 1), first error is: failed to get ${resName} resource metric value: ${message.replace(/^failed to get \w+ utilization: /, "")}`, "horizontal-pod-autoscaler");
      // Out of range still gets fixed without metrics.
      let desired = current;
      if (current < min) {
        desired = min;
        rescale(min, "Current number of replicas below Spec.MinReplicas");
      } else if (current > max) {
        desired = max;
        rescale(max, "Current number of replicas above Spec.MaxReplicas");
      }
      write({ currentReplicas: current, desiredReplicas: desired, currentMetrics: null, ...(desired !== current ? { lastScaleTime: now } : {}) });
    };
    if (!metricsAvailable(cluster)) {
      fail("FailedGetResourceMetric", `failed to get ${resName} utilization: unable to get metrics for resource ${resName}: unable to fetch metrics from resource metrics API: the server could not find the requested resource (get pods.metrics.k8s.io)`);
      continue;
    }
    if (noRequest.length) {
      fail("FailedGetResourceMetric", `failed to get ${resName} utilization: missing request for ${resName} in container ${noRequest[0].c.name} of Pod ${noRequest[0].p.metadata.name}`);
      continue;
    }
    const m = cluster.state.metrics?.pods ?? {};
    const req = (p: Pod) => p.spec!.containers.reduce((a, c) => a + (resName === "cpu" ? containerRequests(c).cpu : containerRequests(c).memory), 0);
    const withMetrics = pods.filter((p) => m[p.metadata.uid] && isPodReady(p));
    const missing = pods.filter((p) => !m[p.metadata.uid] || !isPodReady(p));
    if (withMetrics.length === 0) {
      fail("FailedGetResourceMetric", `failed to get ${resName} utilization: did not receive metrics for targeted pods (pods might be unready)`);
      continue;
    }
    const use = (p: Pod) => (resName === "cpu" ? m[p.metadata.uid].cpu : m[p.metadata.uid].memory);
    const sumUse = withMetrics.reduce((a, p) => a + use(p), 0);
    const sumReq = withMetrics.reduce((a, p) => a + req(p), 0);
    // The controller works in whole percent (integer division).
    const util = Math.floor((sumUse * 100) / sumReq);
    let ratio = util / targetUtil;
    let desired = current;
    if (Math.abs(ratio - 1) > TOLERANCE) {
      // Rebalance with the missing Pods assumed at 0% (scale up) or 100% (scale down).
      if (missing.length) {
        const assumed = ratio > 1 ? 0 : 1;
        const u2 = (sumUse + missing.reduce((a, p) => a + assumed * req(p), 0)) / (sumReq + missing.reduce((a, p) => a + req(p), 0));
        const r2 = (u2 * 100) / targetUtil;
        if (Math.abs(r2 - 1) <= TOLERANCE || (ratio > 1) !== (r2 > 1)) ratio = 1;
        else ratio = r2;
      }
      desired = ratio === 1 ? current : Math.ceil(ratio * (withMetrics.length + missing.length));
    }

    // Scale-down stabilization: act on the highest recommendation of the window
    // (behavior.scaleDown.stabilizationWindowSeconds, 5 minutes by default).
    const downWindowMs = (hpa.spec!.behavior?.scaleDown?.stabilizationWindowSeconds ?? DOWN_WINDOW_MS / 1000) * 1000;
    const recs = ((cluster.state.hpa[hpa.metadata.uid] ??= { recs: [] }).recs = [...(cluster.state.hpa[hpa.metadata.uid]?.recs ?? []), { t: now, n: desired }].filter((r) => now - r.t <= downWindowMs));
    let next = desired;
    if (desired < current) next = Math.min(current, Math.max(...recs.map((r) => r.n)));
    const stabilized = desired < current && next > desired;
    // Scale-up rate: without behavior, max(2× current, 4); with the default behavior policies, max(+4 Pods, +100%) per 15s.
    let limited: string | undefined;
    const cap = hpa.spec!.behavior ? Math.max(current + 4, current * 2) : Math.max(current * 2, 4);
    if (next > cap) {
      next = cap;
      limited = "ScaleUpLimit";
    }
    if (next > max) {
      next = max;
      limited = "TooManyReplicas";
    } else if (next < min) {
      next = min;
      limited = "TooFewReplicas";
    }
    conds = setCond(conds, { type: "ScalingActive", status: "True", reason: "ValidMetricFound", message: `the HPA was able to successfully calculate a replica count from ${resName} resource utilization (percentage of request)` }, now);
    conds = setCond(
      conds,
      limited
        ? { type: "ScalingLimited", status: "True", reason: limited, message: limited === "ScaleUpLimit" ? "the desired replica count is increasing faster than the maximum scale rate" : `the desired replica count is ${limited === "TooManyReplicas" ? "more than the maximum" : "less than the minimum"} replica count` }
        : { type: "ScalingLimited", status: "False", reason: "DesiredWithinRange", message: "the desired count is within the acceptable range" },
      now,
    );
    let lastScale = hpa.status?.lastScaleTime;
    if (next !== current) {
      rescale(next, next > current ? `${resName} resource utilization (percentage of request) above target` : "All metrics below target");
      lastScale = now;
      conds = setCond(conds, { type: "AbleToScale", status: "True", reason: "SucceededRescale", message: `the HPA controller was able to update the target scale to ${next}` }, now);
    } else if (stabilized) {
      conds = setCond(conds, { type: "AbleToScale", status: "True", reason: "ScaleDownStabilized", message: "recent recommendations were higher than current one, applying the highest recent recommendation" }, now);
    } else {
      conds = setCond(conds, { type: "AbleToScale", status: "True", reason: "ReadyForNewScale", message: "recommended size matches current size" }, now);
    }
    write({
      currentReplicas: current,
      desiredReplicas: next,
      ...(lastScale !== undefined ? { lastScaleTime: lastScale } : {}),
      currentMetrics: [{ type: "Resource", resource: { name: resName, current: { averageUtilization: util, averageValue: resName === "cpu" ? `${Math.round(sumUse / withMetrics.length)}m` : `${Math.round(sumUse / withMetrics.length)}` } } }],
    });
  }
}
