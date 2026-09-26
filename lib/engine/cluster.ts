// The Simulated Cluster: an in-memory API server (store + admission +
// validation), a simulated clock, and controllers that reconcile on each step.
// All state is plain JSON so a cluster can be snapshotted and restored.

import type { Program } from "./images";
import {
  API_VERSIONS,
  NAMESPACED_KINDS,
  type AnyObject,
  type KubeEvent,
  type KubeObject,
  type Node,
  type Pod,
  type NewObject,
} from "./types";
import { admit } from "./admission";
import { validate } from "./validation";
import { clone, deepEqual, Rng, randSuffix } from "./util";
import { runKubelets } from "./controllers/kubelet";
import { runScheduler } from "./controllers/scheduler";
import { runReplicaSets } from "./controllers/replicaset";
import { runDeployments } from "./controllers/deployment";
import { runNodeLifecycle } from "./controllers/node-lifecycle";
import { runEndpoints } from "./controllers/endpoints";
import { runGarbageCollector } from "./controllers/gc";
import { bootstrap } from "./bootstrap";

export const STEP_MS = 100;

export interface NodeConfig {
  name: string;
  role: "control-plane" | "worker";
}

export interface ClusterConfig {
  seed: number;
  nodes: NodeConfig[];
  /** How long without heartbeats before a Node goes NotReady (kube default 50s). */
  nodeMonitorGracePeriodMs: number;
  /** Default tolerationSeconds for not-ready/unreachable taints (kube default 300s). */
  defaultTolerationSeconds: number;
  /** Include kube-system Pods (etcd, apiserver, coredns, kube-proxy…). */
  systemPods: boolean;
}

export const DEFAULT_CONFIG: ClusterConfig = {
  seed: 42,
  nodes: [
    { name: "control-plane", role: "control-plane" },
    { name: "worker-1", role: "worker" },
    { name: "worker-2", role: "worker" },
  ],
  nodeMonitorGracePeriodMs: 50_000,
  defaultTolerationSeconds: 300,
  systemPods: true,
};

export type ContainerPhase =
  | "pulling"
  | "pullError" // shows ErrImagePull
  | "pullBackoff" // shows ImagePullBackOff
  | "creating"
  | "running"
  | "exited" // shows terminated (Error/Completed) briefly
  | "crashBackoff" // shows CrashLoopBackOff
  | "done" // terminated for good (restartPolicy says so)
  | "stopping"
  | "dead"; // killed with its Node; status is stale until the Node returns

export interface ContainerRuntime {
  phase: ContainerPhase;
  until: number;
  image: string;
  backoffMs: number;
  program?: Program;
  pc: number;
  wakeAt: number;
  startedAt?: number;
  exitCode?: number;
  exitReason?: string;
  exitMessage?: string;
  pullStartedAt?: number;
  /** Times this container has been restarted (status.restartCount). */
  restarts: number;
  /** Previous termination, shown as lastState. */
  lastTerm?: { exitCode: number; reason: string; startedAt?: number; finishedAt: number; message?: string };
  /** When the last container run started (for back-off reset). */
  lastRunStart?: number;
  /** Set once "Started" etc. have fired for this run. */
  announced?: boolean;
}

export interface PodRuntime {
  containers: Record<string, ContainerRuntime>;
  stoppingUntil?: number;
  /** Sandbox is ready (IP assigned) from this time. */
  sandboxAt: number;
  killingAnnounced?: boolean;
}

export interface NodeRuntime {
  up: boolean;
  lastHeartbeat: number;
  images: string[];
  nextPodIp: number;
  index: number;
  /** When the kubelet first reports Ready after registering. */
  readyAt: number;
}

export interface LogLine {
  t: number;
  text: string;
}

export interface ClusterState {
  config: ClusterConfig;
  now: number;
  rng: number;
  rv: number;
  objects: Record<string, AnyObject>;
  pods: Record<string, PodRuntime>;
  nodes: Record<string, NodeRuntime>;
  /** Logs keyed by `${podUid}/${container}/${restartCount}`. */
  logs: Record<string, LogLine[]>;
  nextClusterIp: number;
  scheduleAttempts: Record<string, number>;
  accum: number;
}

export type ClusterSignal =
  | { type: "change" }
  | { type: "event"; event: KubeEvent }
  | { type: "traffic"; serviceUid?: string; podUid: string; nodeName?: string; ok: boolean; via: "clusterip" | "nodeport" | "pod" };

export class ApiError extends Error {
  constructor(
    message: string,
    public reason: "NotFound" | "AlreadyExists" | "Invalid" | "BadRequest" | "Forbidden" | "Conflict",
  ) {
    super(message);
  }
}

const RESOURCE_NAMES: Record<string, string> = {
  Pod: "pods",
  Service: "services",
  Endpoints: "endpoints",
  Node: "nodes",
  Namespace: "namespaces",
  Event: "events",
  ReplicaSet: "replicasets.apps",
  Deployment: "deployments.apps",
};

export function resourceName(kind: string): string {
  return RESOURCE_NAMES[kind] ?? kind.toLowerCase() + "s";
}

export function objKey(kind: string, namespace: string | undefined, name: string): string {
  return `${kind}/${NAMESPACED_KINDS.has(kind) ? (namespace ?? "default") : ""}/${name}`;
}

export interface DeleteOptions {
  gracePeriodSeconds?: number;
  force?: boolean;
}

export class Cluster {
  state: ClusterState;
  rng: Rng;
  private listeners = new Set<(s: ClusterSignal) => void>();
  /** kind → store keys, so list() doesn't scan every object. Derived; not part of snapshots. */
  private byKind = new Map<string, Set<string>>();
  private index(): Map<string, Set<string>> {
    if (this.byKind.size === 0 && Object.keys(this.state.objects).length) {
      for (const [key, o] of Object.entries(this.state.objects)) (this.byKind.get(o.kind) ?? this.byKind.set(o.kind, new Set()).get(o.kind)!).add(key);
    }
    return this.byKind;
  }
  private changed = false;
  /** Bumped whenever anything observable changes; handy for React. */
  version = 0;
  /** Set when cluster changes may let unschedulable Pods fit; the scheduler retries at once. */
  schedulerWake = false;

  constructor(configOrState?: Partial<ClusterConfig> | ClusterState) {
    if (configOrState && "objects" in configOrState) {
      this.state = clone(configOrState);
      this.rng = new Rng(this.state.rng);
    } else {
      const config = { ...DEFAULT_CONFIG, ...(configOrState ?? {}) };
      this.state = {
        config,
        now: 0,
        rng: config.seed,
        rv: 1000,
        objects: {},
        pods: {},
        nodes: {},
        logs: {},
        nextClusterIp: 1,
        scheduleAttempts: {},
        accum: 0,
      };
      this.rng = new Rng(config.seed);
      bootstrap(this);
      // Let system Pods come up before the Learner arrives.
      this.advance(config.systemPods ? 30_000 : 5_000);
      this.state.now = Math.max(this.state.now, 0);
    }
  }

  get now(): number {
    return this.state.now;
  }

  // ---------- signals ----------

  subscribe(fn: (s: ClusterSignal) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(s: ClusterSignal): void {
    for (const l of this.listeners) l(s);
  }

  private flush(): void {
    if (this.changed) {
      this.changed = false;
      this.version++;
      this.emit({ type: "change" });
    }
  }

  // ---------- time ----------

  /** Advances simulated time by `ms`, running controllers every STEP_MS. */
  tick(ms: number): void {
    this.state.accum += ms;
    while (this.state.accum >= STEP_MS) {
      this.state.accum -= STEP_MS;
      this.step();
    }
    this.flush();
  }

  /** Advances time without emitting per-step signals (setup, tests). */
  advance(ms: number): void {
    const steps = Math.round(ms / STEP_MS);
    for (let i = 0; i < steps; i++) this.step();
    this.flush();
  }

  private step(): void {
    this.state.now += STEP_MS;
    runKubelets(this);
    runNodeLifecycle(this);
    runScheduler(this);
    runEndpoints(this);
    runReplicaSets(this);
    runDeployments(this);
    runGarbageCollector(this);
    this.state.rng = this.rng.state;
  }

  // ---------- raw store ----------

  uid(): string {
    const h = () => this.rng.int(0x10000).toString(16).padStart(4, "0");
    return `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`;
  }

  genName(prefix: string): string {
    return `${prefix}${randSuffix(this.rng)}`;
  }

  raw(kind: string, namespace: string | undefined, name: string): AnyObject | undefined {
    return this.state.objects[objKey(kind, namespace, name)];
  }

  list<T extends KubeObject = AnyObject>(kind: string, namespace?: string): T[] {
    const out: T[] = [];
    for (const key of this.index().get(kind) ?? []) {
      const o = this.state.objects[key];
      if (!o) continue;
      if (namespace !== undefined && NAMESPACED_KINDS.has(kind) && o.metadata.namespace !== namespace) continue;
      out.push(o as unknown as T);
    }
    return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  }

  byUid(uid: string): AnyObject | undefined {
    for (const o of Object.values(this.state.objects)) if (o.metadata.uid === uid) return o;
    return undefined;
  }

  /** Stores an object if it differs from what's stored; bumps resourceVersion. */
  put<T extends KubeObject>(obj: T): T {
    const key = objKey(obj.kind, obj.metadata.namespace, obj.metadata.name);
    const prev = this.state.objects[key];
    if (prev && deepEqual({ ...prev, metadata: { ...prev.metadata, resourceVersion: "" } }, { ...obj, metadata: { ...obj.metadata, resourceVersion: "" } })) {
      return prev as unknown as T;
    }
    const next = { ...obj, metadata: { ...obj.metadata, resourceVersion: String(++this.state.rv) } } as T;
    if (!prev) {
      const idx = this.index();
      (idx.get(obj.kind) ?? idx.set(obj.kind, new Set()).get(obj.kind)!).add(key);
    }
    this.state.objects[key] = next as unknown as AnyObject;
    if (obj.kind === "Node") this.schedulerWake = true;
    this.changed = true;
    return next;
  }

  /** Clone-modify-put in one call. */
  update<T extends KubeObject>(obj: T, fn: (draft: T) => void): T {
    const draft = clone(obj);
    fn(draft);
    return this.put(draft);
  }

  remove(obj: KubeObject): void {
    const key = objKey(obj.kind, obj.metadata.namespace, obj.metadata.name);
    if (!this.state.objects[key]) return;
    this.index().get(obj.kind)?.delete(key);
    delete this.state.objects[key];
    this.schedulerWake = true;
    if (obj.kind === "Pod") {
      delete this.state.pods[obj.metadata.uid];
      delete this.state.scheduleAttempts[obj.metadata.uid];
    }
    this.changed = true;
  }

  markChanged(): void {
    this.changed = true;
  }

  // ---------- events ----------

  record(
    obj: KubeObject,
    type: "Normal" | "Warning",
    reason: string,
    message: string,
    component: string,
    host?: string,
    fieldPath?: string,
  ): void {
    const ns = obj.metadata.namespace ?? "default";
    const existing = this.list<KubeEvent>("Event", ns).find(
      (e) => e.involvedObject.uid === obj.metadata.uid && e.reason === reason && e.message === message,
    );
    let ev: KubeEvent;
    if (existing) {
      ev = this.update(existing, (e) => {
        e.count += 1;
        e.lastTimestamp = this.now;
      });
    } else {
      ev = this.put<KubeEvent>({
        apiVersion: "v1",
        kind: "Event",
        metadata: {
          name: `${obj.metadata.name}.${(this.rng.int(2 ** 30) * 64 + this.rng.int(64)).toString(16).padStart(16, "1")}`,
          namespace: ns,
          uid: this.uid(),
          resourceVersion: "",
          creationTimestamp: this.now,
        },
        involvedObject: {
          kind: obj.kind,
          name: obj.metadata.name,
          namespace: obj.metadata.namespace,
          uid: obj.metadata.uid,
          apiVersion: obj.apiVersion,
          ...(fieldPath ? { fieldPath } : {}),
        },
        reason,
        message,
        type,
        count: 1,
        firstTimestamp: this.now,
        lastTimestamp: this.now,
        source: { component, ...(host ? { host } : {}) },
        reportingComponent: component,
      });
    }
    this.emit({ type: "event", event: ev });
  }

  eventsFor(obj: KubeObject): KubeEvent[] {
    return this.list<KubeEvent>("Event", obj.metadata.namespace ?? "default")
      .filter((e) => e.involvedObject.uid === obj.metadata.uid)
      .sort((a, b) => a.firstTimestamp - b.firstTimestamp);
  }

  // ---------- API (what kubectl talks to) ----------

  get<T extends KubeObject = AnyObject>(kind: string, namespace: string | undefined, name: string): T {
    const o = this.raw(kind, namespace, name);
    if (!o) throw new ApiError(`Error from server (NotFound): ${resourceName(kind)} "${name}" not found`, "NotFound");
    return o as unknown as T;
  }

  private ensureNamespace(kind: string, ns: string | undefined): void {
    if (!NAMESPACED_KINDS.has(kind)) return;
    const n = this.raw("Namespace", undefined, ns ?? "default");
    if (!n) throw new ApiError(`Error from server (NotFound): namespaces "${ns}" not found`, "NotFound");
    if (n.status && (n.status as { phase: string }).phase === "Terminating")
      throw new ApiError(
        `Error from server (Forbidden): ${resourceName(kind)} "${"x"}" is forbidden: unable to create new content in namespace ${ns} because it is being terminated`,
        "Forbidden",
      );
  }

  create<T extends KubeObject>(input: NewObject<T> | T): T {
    const obj = clone(input) as unknown as AnyObject;
    obj.apiVersion ??= API_VERSIONS[obj.kind];
    obj.metadata = { ...(obj.metadata ?? {}) } as AnyObject["metadata"];
    const meta = obj.metadata as AnyObject["metadata"] & { generateName?: string };
    if (!meta.name && meta.generateName) meta.name = this.genName(meta.generateName);
    if (NAMESPACED_KINDS.has(obj.kind)) meta.namespace ??= "default";
    else delete meta.namespace;
    validate(this, obj, undefined);
    this.ensureNamespace(obj.kind, meta.namespace);
    if (this.raw(obj.kind, meta.namespace, meta.name)) {
      throw new ApiError(`Error from server (AlreadyExists): ${resourceName(obj.kind)} "${meta.name}" already exists`, "AlreadyExists");
    }
    meta.uid = this.uid();
    meta.creationTimestamp = this.now;
    delete (meta as { generateName?: string }).generateName;
    admit(this, obj, undefined);
    const stored = this.put(obj);
    this.flush();
    return stored as unknown as T;
  }

  /** Replaces an existing object's spec/metadata (like PUT). */
  replace<T extends KubeObject>(input: T): T {
    const prev = this.get(input.kind, input.metadata.namespace, input.metadata.name);
    const obj = clone(input) as unknown as AnyObject;
    obj.apiVersion ??= prev.apiVersion;
    obj.metadata = {
      ...obj.metadata,
      namespace: prev.metadata.namespace,
      uid: prev.metadata.uid,
      creationTimestamp: prev.metadata.creationTimestamp,
      generation: prev.metadata.generation,
      ownerReferences: obj.metadata.ownerReferences ?? prev.metadata.ownerReferences,
      deletionTimestamp: prev.metadata.deletionTimestamp,
    };
    if (!NAMESPACED_KINDS.has(obj.kind)) delete obj.metadata.namespace;
    obj.status = prev.status;
    validate(this, obj, prev);
    admit(this, obj, prev);
    if (!deepEqual(obj.spec, prev.spec) || ("subsets" in obj && !deepEqual(obj.subsets, prev.subsets))) {
      obj.metadata.generation = (prev.metadata.generation ?? 1) + 1;
    }
    const stored = this.put(obj);
    this.flush();
    return stored as unknown as T;
  }

  /** kubectl-apply semantics, simplified: create, or replace spec/labels/annotations. */
  apply<T extends KubeObject>(input: NewObject<T> | T): { obj: T; action: "created" | "configured" | "unchanged" } {
    const ns = NAMESPACED_KINDS.has(input.kind) ? (input.metadata?.namespace ?? "default") : undefined;
    const annotated = clone(input) as unknown as AnyObject;
    const lastApplied = JSON.stringify(input);
    annotated.metadata = {
      ...annotated.metadata,
      annotations: { ...(annotated.metadata?.annotations ?? {}), "kubectl.kubernetes.io/last-applied-configuration": lastApplied + "\n" },
    };
    const prev = this.raw(input.kind, ns, input.metadata?.name ?? "");
    if (!prev) return { obj: this.create(annotated as unknown as T), action: "created" };
    const merged = clone(prev) as AnyObject;
    merged.metadata.labels = annotated.metadata.labels;
    merged.metadata.annotations = { ...annotated.metadata.annotations };
    // Keep annotations that controllers own.
    for (const [k, v] of Object.entries(prev.metadata.annotations ?? {})) {
      if (k.startsWith("deployment.kubernetes.io/")) merged.metadata.annotations![k] = v;
    }
    const spec = clone(annotated.spec ?? {}) as Record<string, unknown>;
    const prevSpec = (prev.spec ?? {}) as Record<string, unknown>;
    // Fields the applied config leaves out keep their live values (e.g. replicas after `kubectl scale`,
    // or a Service's allocated clusterIP).
    for (const keep of ["replicas", "clusterIP", "clusterIPs", "nodeName"]) {
      if (spec[keep] === undefined && prevSpec[keep] !== undefined) spec[keep] = prevSpec[keep];
    }
    if (input.kind === "Service" && Array.isArray(spec.ports) && Array.isArray(prevSpec.ports)) {
      spec.ports = (spec.ports as { nodePort?: number; port: number }[]).map((p) => ({
        ...p,
        nodePort: p.nodePort ?? (prevSpec.ports as { nodePort?: number; port: number }[]).find((q) => q.port === p.port)?.nodePort,
      }));
    }
    merged.spec = spec;
    if ("subsets" in annotated) merged.subsets = annotated.subsets;
    // Compare after defaulting so an identical re-apply reports "unchanged".
    const probe = clone(merged);
    admit(this, probe, prev);
    if (deepEqual(probe.spec, prev.spec) && deepEqual(probe.metadata.labels, prev.metadata.labels) && deepEqual(probe.metadata.annotations, prev.metadata.annotations)) {
      return { obj: prev as unknown as T, action: "unchanged" };
    }
    return { obj: this.replace(merged) as unknown as T, action: "configured" };
  }

  delete(kind: string, namespace: string | undefined, name: string, opts: DeleteOptions = {}): AnyObject {
    const obj = this.get(kind, namespace, name);
    this.deleteObject(obj, opts);
    this.flush();
    return obj;
  }

  deleteObject(obj: KubeObject, opts: DeleteOptions = {}): void {
    if (obj.kind === "Pod") {
      const pod = obj as Pod;
      if (opts.force || opts.gracePeriodSeconds === 0 || !pod.spec?.nodeName) {
        this.remove(pod);
        return;
      }
      if (pod.metadata.deletionTimestamp !== undefined) return;
      const grace = opts.gracePeriodSeconds ?? pod.spec?.terminationGracePeriodSeconds ?? 30;
      this.update(pod, (p) => {
        p.metadata.deletionTimestamp = this.now + grace * 1000;
        p.metadata.deletionGracePeriodSeconds = grace;
      });
      return;
    }
    if (obj.kind === "Namespace") {
      if (["default", "kube-system", "kube-public", "kube-node-lease"].includes(obj.metadata.name)) {
        throw new ApiError(`Error from server (Forbidden): namespaces "${obj.metadata.name}" is forbidden: this namespace may not be deleted`, "Forbidden");
      }
      this.update(obj, (n) => {
        n.metadata.deletionTimestamp = this.now;
        (n.status as { phase: string }) = { phase: "Terminating" };
      });
      return;
    }
    if (obj.kind === "Node") {
      for (const p of this.list<Pod>("Pod")) if (p.spec?.nodeName === obj.metadata.name) this.remove(p);
      delete this.state.nodes[obj.metadata.name];
    }
    this.remove(obj);
  }

  // ---------- Pod logs ----------

  log(podUid: string, container: string, restart: number, t: number, text: string): void {
    const key = `${podUid}/${container}/${restart}`;
    (this.state.logs[key] ??= []).push({ t, text });
  }

  logsFor(pod: Pod, container: string, previous = false): LogLine[] | undefined {
    const status = pod.status?.containerStatuses?.find((s) => s.name === container);
    const restart = (status?.restartCount ?? 0) - (previous ? 1 : 0);
    if (restart < 0) return undefined;
    return this.state.logs[`${pod.metadata.uid}/${container}/${restart}`] ?? [];
  }

  // ---------- helpers for controllers ----------

  nodeReady(node: Node): boolean {
    return node.status?.conditions.find((c) => c.type === "Ready")?.status === "True";
  }

  snapshot(): ClusterState {
    this.state.rng = this.rng.state;
    return clone(this.state);
  }
}

export function isPodTerminal(p: Pod): boolean {
  return p.status?.phase === "Succeeded" || p.status?.phase === "Failed";
}

export function isPodReady(p: Pod): boolean {
  return p.status?.conditions?.find((c) => c.type === "Ready")?.status === "True";
}

export function controllerOf(o: KubeObject): { kind: string; name: string; uid: string } | undefined {
  return o.metadata.ownerReferences?.find((r) => r.controller);
}
