// The READY, STATUS and RESTARTS columns of `kubectl get pods`, computed the way the
// API server's table printer does (pkg/printers/internalversion/printers.go printPod),
// including init containers (Init:0/1, Init:CrashLoopBackOff, PodInitializing) and
// sidecars (restartable init containers count toward READY).

import type { ContainerStatus, Pod } from "./types";

export function podStatusColumns(pod: Pod): { ready: string; status: string; restarts: number } {
  const st = pod.status;
  const inits = pod.spec?.initContainers ?? [];
  const sidecars = new Set(inits.filter((c) => c.restartPolicy === "Always").map((c) => c.name));
  let ready = 0;
  let restarts = 0;
  let reason: string = st?.reason || st?.phase || "Pending";
  if (st?.conditions?.some((c) => c.type === "PodScheduled" && c.reason === "SchedulingGated")) reason = "SchedulingGated";

  let initializing = false;
  const initStatuses = st?.initContainerStatuses ?? [];
  for (let i = 0; i < initStatuses.length; i++) {
    const c = initStatuses[i];
    restarts += c.restartCount;
    if (sidecars.has(c.name) && c.started) {
      if (c.ready) ready++;
      continue;
    }
    const t = c.state.terminated;
    const w = c.state.waiting;
    if (t && t.exitCode === 0) continue;
    if (t) reason = t.reason ? `Init:${t.reason}` : `Init:ExitCode:${t.exitCode}`;
    else if (w?.reason && w.reason !== "PodInitializing") reason = `Init:${w.reason}`;
    else reason = `Init:${i}/${inits.length}`;
    initializing = true;
    break;
  }
  const initialized = st?.conditions?.some((c) => c.type === "Initialized" && c.status === "True");
  if (!initializing || initialized) {
    restarts = initStatuses.reduce((a, c) => a + (sidecars.has(c.name) ? c.restartCount : 0), 0);
    let hasRunning = false;
    const cs: ContainerStatus[] = st?.containerStatuses ?? [];
    for (let i = cs.length - 1; i >= 0; i--) {
      const c = cs[i];
      restarts += c.restartCount;
      if (c.state.waiting?.reason) reason = c.state.waiting.reason;
      else if (c.state.terminated?.reason) reason = c.state.terminated.reason;
      else if (c.state.terminated) reason = `ExitCode:${c.state.terminated.exitCode}`;
      else if (c.ready && c.state.running) {
        hasRunning = true;
        ready++;
      }
    }
    if (reason === "Completed" && hasRunning) reason = st?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ? "Running" : "NotReady";
  }
  const terminal = st?.phase === "Succeeded" || st?.phase === "Failed";
  if (pod.metadata.deletionTimestamp !== undefined && st?.reason === "NodeLost") reason = "Unknown";
  else if (pod.metadata.deletionTimestamp !== undefined && !terminal) reason = "Terminating";
  const total = (pod.spec?.containers ?? []).length + sidecars.size;
  return { ready: `${ready}/${total}`, status: reason, restarts };
}
