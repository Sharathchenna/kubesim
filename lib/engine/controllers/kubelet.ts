// The kubelet: runs on every live Node. Sets up Pod sandboxes, pulls images,
// runs container Programs, restarts with CrashLoopBackOff, terminates deleted
// Pods, and writes Pod status. Timings follow the behaviour reference §2.

import { isPodTerminal, type Cluster, type ContainerRuntime, type PodRuntime } from "../cluster";
import { containerProgram, imageDigest, lookupImage, pullError } from "../images";
import type { Condition, Container, ContainerState, ContainerStatus, Node, Pod, PodPhase, PodStatus } from "../types";
import { SIM_EPOCH, deepEqual } from "../util";
import { kubeletConditions } from "../nodes";

const SANDBOX_MS = 600;
const CREATE_MS = 400;
const EXITED_VISIBLE_MS = 1000;
const INITIAL_BACKOFF = 10_000;
const MAX_BACKOFF = 300_000;
const HEARTBEAT_MS = 10_000;

export function goDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m${s % 60}s`;
}

export function unixDate(simMs: number): string {
  const d = new Date(SIM_EPOCH + simMs);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const t = d.toISOString().slice(11, 19);
  return `${day} ${mon} ${String(d.getUTCDate()).padStart(2, " ")} ${t} UTC ${d.getUTCFullYear()}`;
}

function pullMs(sizeBytes: number): number {
  // ~40 MB/s plus registry round trips.
  return Math.round(800 + (sizeBytes / 40_000_000) * 1000);
}

export function runKubelets(cluster: Cluster): void {
  const now = cluster.now;
  for (const node of cluster.list<Node>("Node")) {
    const rt = cluster.state.nodes[node.metadata.name];
    if (!rt || !rt.up) continue;
    rt.lastHeartbeat = now;
    // Node status heartbeat.
    const ready = now >= rt.readyAt;
    const readyCond = node.status?.conditions.find((c) => c.type === "Ready");
    const wantReady = ready ? "True" : "False";
    if (!readyCond || readyCond.status !== wantReady || now - (readyCond.lastHeartbeatTime ?? 0) >= HEARTBEAT_MS) {
      cluster.update(node, (n) => {
        const fresh = kubeletConditions(now, ready);
        n.status!.conditions = fresh.map((c) => {
          const old = n.status!.conditions.find((o) => o.type === c.type);
          return old && old.status === c.status ? { ...c, lastTransitionTime: old.lastTransitionTime } : c;
        });
      });
      if (readyCond && readyCond.status !== "True" && wantReady === "True") {
        cluster.record(node, "Normal", "NodeReady", `Node ${node.metadata.name} status is now: NodeReady`, "kubelet", node.metadata.name);
      }
    }
  }

  for (const pod of cluster.list<Pod>("Pod")) {
    const nodeName = pod.spec?.nodeName;
    if (!nodeName) continue;
    const nrt = cluster.state.nodes[nodeName];
    if (!nrt || !nrt.up) continue;
    syncPod(cluster, pod, nodeName);
  }
}

function syncPod(cluster: Cluster, pod: Pod, nodeName: string): void {
  const now = cluster.now;
  const uid = pod.metadata.uid;
  const nrt = cluster.state.nodes[nodeName];
  let prt = cluster.state.pods[uid];

  // --- deletion ---
  if (pod.metadata.deletionTimestamp !== undefined) {
    if (!prt || isPodTerminal(pod)) {
      cluster.remove(pod);
      return;
    }
    if (prt.stoppingUntil === undefined) {
      let slow = false;
      for (const c of pod.spec!.containers) {
        const crt = prt.containers[c.name];
        if (!crt || crt.phase !== "running") continue;
        const { info } = lookupImage(c.image);
        // Servers handle SIGTERM; a shell or `sleep` as PID 1 ignores it and waits out the grace period.
        const handlesTerm = !!info?.http || info?.repo.startsWith("registry.k8s.io/") || (crt.program?.some((o) => o.op === "serve") && !c.command);
        if (!handlesTerm) slow = true;
        crt.phase = "stopping";
        cluster.record(pod, "Normal", "Killing", `Stopping container ${c.name}`, "kubelet", nodeName, `spec.containers{${c.name}}`);
      }
      prt.stoppingUntil = slow ? pod.metadata.deletionTimestamp : Math.min(now + 1000, pod.metadata.deletionTimestamp);
      cluster.markChanged();
    }
    if (now >= prt.stoppingUntil) {
      cluster.remove(pod);
      return;
    }
    writeStatus(cluster, pod, prt, nodeName);
    return;
  }

  if (isPodTerminal(pod) && prt && Object.values(prt.containers).every((c) => c.phase === "done")) return;

  // --- sandbox ---
  if (!prt) {
    prt = cluster.state.pods[uid] = { containers: {}, sandboxAt: now + SANDBOX_MS };
    for (const c of pod.spec!.containers) {
      prt.containers[c.name] = { phase: "pulling", until: 0, image: c.image, backoffMs: 0, pc: 0, wakeAt: 0, restarts: 0 };
    }
    cluster.markChanged();
  }
  if (now < prt.sandboxAt) {
    writeStatus(cluster, pod, prt, nodeName);
    return;
  }
  if (!pod.status?.podIP) {
    const ip = pod.metadata.namespace === "kube-system" && pod.metadata.name.startsWith("kube-proxy") || pod.metadata.annotations?.["kubernetes.io/config.source"] === "file"
      ? `172.18.0.${nrt.index + 2}` // host-network Pods use the Node's IP
      : `10.244.${nrt.index}.${nrt.nextPodIp++}`;
    cluster.update(pod, (p) => {
      p.status = { ...(p.status as PodStatus), podIP: ip, hostIP: `172.18.0.${nrt.index + 2}`, startTime: now };
    });
    pod = cluster.get<Pod>("Pod", pod.metadata.namespace, pod.metadata.name);
  }

  for (const c of pod.spec!.containers) {
    let crt = prt.containers[c.name];
    if (!crt) {
      crt = prt.containers[c.name] = { phase: "pulling", until: 0, image: c.image, backoffMs: 0, pc: 0, wakeAt: 0, restarts: 0 };
    }
    // Image changed (kubectl set image on a bare Pod): kill and restart with the new image.
    if (crt.image !== c.image && crt.phase !== "pulling") {
      if (crt.phase === "running") {
        cluster.record(pod, "Normal", "Killing", `Container ${c.name} definition changed, will be restarted`, "kubelet", nodeName, `spec.containers{${c.name}}`);
        crt.lastTerm = { exitCode: 0, reason: "Completed", startedAt: crt.startedAt, finishedAt: now };
        crt.restarts++;
      }
      crt.image = c.image;
      crt.phase = "pulling";
      crt.pullStartedAt = undefined;
      crt.backoffMs = 0;
      cluster.markChanged();
    }
    stepContainer(cluster, pod, c, crt, nodeName);
  }
  writeStatus(cluster, pod, prt, nodeName);
}

function stepContainer(cluster: Cluster, pod: Pod, c: Container, crt: ContainerRuntime, nodeName: string): void {
  const now = cluster.now;
  const nrt = cluster.state.nodes[nodeName];
  const fp = `spec.containers{${c.name}}`;
  const ev = (type: "Normal" | "Warning", reason: string, msg: string) => cluster.record(pod, type, reason, msg, "kubelet", nodeName, fp);
  const { ref, info, tagOk } = lookupImage(c.image);
  const set = (phase: ContainerRuntime["phase"], until = 0) => {
    crt.phase = phase;
    crt.until = until;
    cluster.markChanged();
  };

  switch (crt.phase) {
    case "pulling": {
      const present = nrt.images.includes(ref.full);
      const policy = c.imagePullPolicy ?? "IfNotPresent";
      if (crt.pullStartedAt === undefined) {
        if (policy === "Never" || (present && policy === "IfNotPresent")) {
          if (!present) {
            // ErrImageNeverPull: stays waiting.
            if (crt.exitReason !== "ErrImageNeverPull") {
              crt.exitReason = "ErrImageNeverPull";
              ev("Warning", "ErrImageNeverPull", `Container image "${c.image}" is not present with pull policy of Never`);
              cluster.markChanged();
            }
            return;
          }
          ev("Normal", "Pulled", `Container image "${c.image}" already present on machine and can be verified`);
          set("creating", now + CREATE_MS);
          return;
        }
        crt.pullStartedAt = now;
        ev("Normal", "Pulling", `Pulling image "${c.image}"`);
        cluster.markChanged();
      }
      const dur = present ? 700 : pullMs(info?.sizeBytes ?? 20_000_000);
      if (now - crt.pullStartedAt < (tagOk ? dur : 1500)) return;
      if (!tagOk) {
        const err = pullError(ref, info);
        crt.exitMessage = err;
        ev("Warning", "Failed", `Failed to pull image "${c.image}": ${err}`);
        ev("Warning", "Failed", "Error: ErrImagePull");
        crt.backoffMs = crt.backoffMs ? Math.min(crt.backoffMs * 2, MAX_BACKOFF) : INITIAL_BACKOFF;
        crt.pullStartedAt = undefined;
        // ErrImagePull shows briefly, then ImagePullBackOff until the window ends.
        set("pullError", now + 1500);
        return;
      }
      if (!present) nrt.images.push(ref.full);
      const secs = (dur / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
      ev("Normal", "Pulled", `Successfully pulled image "${c.image}" in ${secs}s (${secs}s including waiting). Image size: ${info!.sizeBytes} bytes.`);
      crt.pullStartedAt = undefined;
      crt.backoffMs = 0;
      set("creating", now + CREATE_MS);
      return;
    }
    case "pullError":
      if (now >= crt.until) {
        ev("Normal", "BackOff", `Back-off pulling image "${c.image}"`);
        ev("Warning", "Failed", "Error: ImagePullBackOff");
        set("pullBackoff", now - 1500 + crt.backoffMs);
      }
      return;
    case "pullBackoff":
      if (now >= crt.until) set("pulling");
      return;
    case "creating": {
      if (now < crt.until) return;
      const res = containerProgram(c, info!, pod.metadata.name);
      if (!res.ok) {
        ev("Normal", "Created", "Container created");
        ev("Warning", "Failed", `Error: ${res.message}`);
        crt.startedAt = now;
        crt.lastRunStart = now;
        crt.exitCode = 128;
        crt.exitReason = "StartError";
        crt.exitMessage = res.message;
        set("exited", now + EXITED_VISIBLE_MS);
        return;
      }
      ev("Normal", "Created", "Container created");
      ev("Normal", "Started", "Container started");
      crt.program = res.program;
      crt.pc = 0;
      crt.wakeAt = 0;
      crt.startedAt = now;
      crt.lastRunStart = now;
      crt.exitCode = undefined;
      crt.exitReason = undefined;
      crt.exitMessage = undefined;
      set("running");
      runProgram(cluster, pod, c, crt);
      return;
    }
    case "running":
      runProgram(cluster, pod, c, crt);
      return;
    case "exited": {
      if (now < crt.until) return;
      const policy = pod.spec?.restartPolicy ?? "Always";
      const restart = policy === "Always" || (policy === "OnFailure" && crt.exitCode !== 0);
      if (!restart) {
        set("done");
        return;
      }
      crt.lastTerm = { exitCode: crt.exitCode ?? 0, reason: crt.exitReason ?? "Error", startedAt: crt.startedAt, finishedAt: crt.until - EXITED_VISIBLE_MS, message: crt.exitMessage };
      const ranMs = crt.lastTerm.finishedAt - (crt.lastRunStart ?? 0);
      if (ranMs > 600_000) crt.backoffMs = 0;
      if (crt.backoffMs === 0) {
        // First failure: restart at once, then back off from 10s.
        crt.backoffMs = INITIAL_BACKOFF;
        crt.restarts++;
        set("creating", now + CREATE_MS);
      } else {
        ev("Warning", "BackOff", "Back-off restarting failed container " + c.name + " in pod " + `${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})`);
        set("crashBackoff", crt.lastTerm.finishedAt + crt.backoffMs);
      }
      return;
    }
    case "crashBackoff":
      if (now >= crt.until) {
        crt.backoffMs = Math.min(crt.backoffMs * 2, MAX_BACKOFF);
        crt.restarts++;
        ev("Normal", "Pulled", `Container image "${c.image}" already present on machine and can be verified`);
        set("creating", now + CREATE_MS);
      }
      return;
    default:
      return;
  }
}

function runProgram(cluster: Cluster, pod: Pod, c: Container, crt: ContainerRuntime): void {
  const now = cluster.now;
  const prog = crt.program ?? [];
  if (crt.wakeAt > now) return;
  for (let guard = 0; guard < 200; guard++) {
    const op = prog[crt.pc];
    if (!op) {
      exit(cluster, crt, 0);
      return;
    }
    switch (op.op) {
      case "log":
        cluster.log(pod.metadata.uid, c.name, crt.restarts, now, op.text.replace(/\u0000DATE\u0000/g, unixDate(now)));
        cluster.markChanged();
        crt.pc++;
        break;
      case "sleep":
        crt.wakeAt = now + op.ms;
        crt.pc++;
        return;
      case "exit":
        exit(cluster, crt, op.code);
        return;
      case "serve":
        return;
      case "jump":
        crt.pc = op.to;
        break;
    }
  }
}

function exit(cluster: Cluster, crt: ContainerRuntime, code: number): void {
  crt.exitCode = code;
  crt.exitReason = code === 0 ? "Completed" : "Error";
  crt.phase = "exited";
  crt.until = cluster.now + EXITED_VISIBLE_MS;
  cluster.markChanged();
}

function containerState(pod: Pod, c: Container, crt: ContainerRuntime): { state: ContainerState; ready: boolean; started: boolean } {
  const waiting = (reason: string, message?: string) => ({ state: { waiting: { reason, ...(message ? { message } : {}) } }, ready: false, started: false });
  switch (crt.phase) {
    case "pulling":
      if (crt.exitReason === "ErrImageNeverPull") return waiting("ErrImageNeverPull", `Container image "${c.image}" is not present with pull policy of Never`);
      return crt.backoffMs ? waiting("ErrImagePull", crt.exitMessage) : waiting("ContainerCreating");
    case "creating":
      return crt.lastTerm ? { state: { terminated: termOf(crt.lastTerm) }, ready: false, started: false } : waiting("ContainerCreating");
    case "pullError":
      return waiting("ErrImagePull", crt.exitMessage);
    case "pullBackoff":
      return waiting("ImagePullBackOff", `Back-off pulling image "${c.image}": ErrImagePull: ${crt.exitMessage ?? ""}`);
    case "running":
    case "stopping":
    case "dead":
      return { state: { running: { startedAt: crt.startedAt ?? 0 } }, ready: true, started: true };
    case "exited":
    case "done":
      return {
        state: { terminated: { exitCode: crt.exitCode ?? 0, reason: crt.exitReason ?? "Completed", startedAt: crt.startedAt, finishedAt: crt.phase === "exited" ? crt.until - EXITED_VISIBLE_MS : (crt.until || crt.startedAt || 0), ...(crt.exitMessage ? { message: crt.exitMessage } : {}) } },
        ready: false,
        started: false,
      };
    case "crashBackoff":
      return waiting(
        "CrashLoopBackOff",
        `back-off ${goDuration(crt.backoffMs)} restarting failed container=${c.name} pod=${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})`,
      );
  }
}

function termOf(t: NonNullable<ContainerRuntime["lastTerm"]>) {
  return { exitCode: t.exitCode, reason: t.reason, ...(t.startedAt !== undefined ? { startedAt: t.startedAt } : {}), finishedAt: t.finishedAt, ...(t.message ? { message: t.message } : {}) };
}

function writeStatus(cluster: Cluster, pod: Pod, prt: PodRuntime, nodeName: string): void {
  const now = cluster.now;
  void nodeName;
  const statuses: ContainerStatus[] = [];
  let anyNeverStarted = false;
  let allDone = true;
  let anyFailed = false;
  for (const c of pod.spec!.containers) {
    const crt = prt.containers[c.name];
    if (!crt) continue;
    const { state, ready, started } = containerState(pod, c, crt);
    const { ref } = lookupImage(crt.image);
    const hasRun = crt.startedAt !== undefined || crt.restarts > 0;
    if (state.waiting && !hasRun) anyNeverStarted = true;
    if (crt.phase !== "done") allDone = false;
    if (crt.phase === "done" && (crt.exitCode ?? 0) !== 0) anyFailed = true;
    statuses.push({
      name: c.name,
      image: ref.full,
      imageID: hasRun ? imageDigest(ref) : "",
      ...(hasRun ? { containerID: `containerd://${cluster_hash(pod.metadata.uid + c.name + crt.restarts)}` } : {}),
      ready,
      started,
      restartCount: crt.restarts,
      state,
      lastState: crt.lastTerm ? { terminated: termOf(crt.lastTerm) } : {},
    });
  }
  let phase: PodPhase;
  if (allDone && statuses.length) phase = anyFailed ? "Failed" : "Succeeded";
  else if (anyNeverStarted || now < prt.sandboxAt) phase = "Pending";
  else phase = "Running";

  const allReady = statuses.length > 0 && statuses.every((s) => s.ready) && pod.metadata.deletionTimestamp === undefined;
  const unready = statuses.filter((s) => !s.ready).map((s) => s.name);
  const prev = pod.status?.conditions ?? [];
  const cond = (type: string, ok: boolean, reason?: string, message?: string): Condition => {
    const old = prev.find((c) => c.type === type);
    const status = ok ? "True" : "False";
    return {
      type,
      status,
      lastProbeTime: null,
      lastTransitionTime: old && old.status === status ? old.lastTransitionTime : now,
      ...(ok ? {} : reason ? { reason, message } : {}),
    };
  };
  const completed = phase === "Succeeded" || phase === "Failed";
  const conditions: Condition[] = [
    cond("PodReadyToStartContainers", now >= prt.sandboxAt && !completed),
    cond("Initialized", true),
    completed ? { ...cond("Ready", false), reason: "PodCompleted" } : cond("Ready", allReady, "ContainersNotReady", `containers with unready status: [${unready.join(" ")}]`),
    completed ? { ...cond("ContainersReady", false), reason: "PodCompleted" } : cond("ContainersReady", allReady, "ContainersNotReady", `containers with unready status: [${unready.join(" ")}]`),
    ...prev.filter((c) => c.type === "PodScheduled" || c.type === "DisruptionTarget"),
  ];
  const next: PodStatus = { ...(pod.status as PodStatus), phase, conditions, containerStatuses: statuses, qosClass: "BestEffort" };
  if (deepEqual(next, pod.status)) return; // most steps change nothing: skip the clone + store write
  cluster.put({ ...pod, status: next });
}

function cluster_hash(s: string): string {
  let h = "";
  let x = 0x811c9dc5;
  for (let r = 0; r < 8; r++) {
    for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 0x01000193) >>> 0;
    x = Math.imul(x ^ r, 0x01000193) >>> 0;
    h += x.toString(16).padStart(8, "0");
  }
  return h;
}
