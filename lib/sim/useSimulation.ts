"use client";

// Runs a Simulated Cluster in the browser. A SimStore owns the cluster and
// advances sim time on requestAnimationFrame; React subscribes to it with
// useSyncExternalStore and re-renders only when something visible changed
// (cluster state, the clock's second, packets in flight, terminal output).

import { useEffect, useState, useSyncExternalStore } from "react";
import { Cluster, request, type ClusterState, type KubeEvent } from "@/lib/engine";
import type { ActionResult } from "./actions";
import { applyYaml, runKubectl } from "@/lib/kubectl/kubectl";

export const DEFAULT_MANIFEST = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: web
        image: nginx:1.27
        ports:
        - containerPort: 80
`;

export interface Packet {
  id: number;
  serviceUid?: string;
  ingressUid?: string;
  /** Pod the request came from (Pod-to-Pod traffic, load generators). */
  fromUid?: string;
  podUid: string;
  ok: boolean;
  /** Dropped by a NetworkPolicy. */
  blocked?: boolean;
  born: number; // performance.now()
}

export interface LogEntry extends ActionResult {
  id: number;
  at: number; // sim ms
}

export interface TermEntry {
  id: number;
  cmd?: string;
  out: string;
  ok: boolean;
  /** Streaming command line, re-run until Ctrl+C (or until done, see untilDone). */
  live?: string;
  untilDone?: boolean;
  /** kubectl's namespace when the command ran (shown in the prompt). */
  ns?: string;
}

export const PACKET_MS = 900;

/** Scrollback and history limits: a long session must not get slower and slower. */
const LOG_MAX = 100;
const TERM_MAX = 300;
const HISTORY_MAX = 500;
/** localStorage holds ~5 MB per origin; a save bigger than this would fail anyway. */
const SAVE_MAX_CHARS = 4_000_000;
/** A cluster from a shared link must run cleanly this long (real time) before it's autosaved. */
const LINK_TRUST_MS = 5000;
/** Sim time between the requests of a `curl` loop. */
const CURL_GAP_MS = 220;

const backupKey = (key: string) => `${key}.backup`;
const originKey = (key: string) => `${key}.origin`;

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
function storageRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage unavailable.
  }
}

/** Builds a Cluster from a snapshot and proves it can run: a save from an older engine can load and still fail on its first steps. */
function trial(state: ClusterState, ms: number): Cluster {
  const c = new Cluster(state);
  new Cluster(c.snapshot()).advance(ms);
  return c;
}

export class SimStore {
  cluster: Cluster | null = null;
  events: KubeEvent[] = [];
  packets: Packet[] = [];
  log: LogEntry[] = [];
  /** Steps at simulated times. `bg` steps (curl loops) don't count as a running scenario. */
  queue: { at: number; fn: () => void; bg?: boolean }[] = [];
  /** Stable Pod → slot assignment per Node for the Cluster View. */
  slots = new Map<string, Map<string, number>>();
  speed = 1;
  paused = false;
  frameNow = 0;
  version = 0;
  /** kubectl's current namespace. */
  namespace = "default";
  /** Sim time when the current cluster was shown (after warm-up). */
  bootAt = 0;
  /** Every command line the Learner ran (Lesson Checks look at this). */
  history: string[] = [];
  /** Terminal scrollback. `live` entries are streaming commands, re-run until Ctrl+C. */
  term: TermEntry[] = [];
  /** The Learner's virtual files; the Editor edits `editorFile`. */
  files: Record<string, string> = {};
  editorFile = "manifest.yaml";
  /** Bumped to ask the UI to show the Editor / Terminal tab. */
  editSeq = 0;
  termSeq = 0;
  /** Which namespace the canvas and stats show ("*" = all). */
  viewNs = "*";
  private lastLive = 0;
  private lastSave = 0;
  /** Cluster resourceVersion at the last autosave (skip saving when nothing changed). */
  private savedRv = -1;
  /** What the last frame showed, to skip re-rendering when nothing changed. */
  private shownRv = -1;
  private shownSec = -1;
  private shownPackets = 0;
  /** True when the cluster came from an autosave. */
  restoredFromSave = false;
  /** True when the cluster came from a shared link. */
  loadedFromLink = false;
  /** Set when the cluster is too big to autosave. */
  saveTooBig = false;
  /** performance.now() before which a cluster from a shared link isn't autosaved yet. */
  private holdSaveUntil = 0;
  /** Set when the engine threw while advancing: the simulation is paused and nothing is autosaved. */
  crashed?: string;
  private id = 1;
  constructor(private opts: SimOptions = {}) {}
  private raf = 0;
  private running = false;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  private bump() {
    this.version++;
    for (const l of this.listeners) l();
  }

  private attach(c: Cluster) {
    this.cluster = c;
    this.events = [];
    this.packets = [];
    this.slots = new Map();
    this.savedRv = -1;
    c.subscribe((s) => {
      if (s.type === "event") {
        const i = this.events.findIndex((e) => e.metadata.uid === s.event.metadata.uid);
        if (i >= 0) this.events.splice(i, 1);
        this.events.unshift(s.event);
        if (this.events.length > 300) this.events.pop();
      } else if (s.type === "traffic") {
        // Busy load generators send many requests a second; cap what's drawn.
        if (this.packets.length < 60) this.packets.push({ id: this.id++, serviceUid: s.serviceUid, ingressUid: s.ingressUid, fromUid: s.fromUid, podUid: s.podUid, ok: s.ok, blocked: s.blocked, born: performance.now() });
      }
    });
  }

  private restored(): Cluster | undefined {
    const key = this.opts.persistKey;
    if (!key || typeof localStorage === "undefined") return undefined;
    const raw = storageGet(key);
    if (!raw) return undefined;
    try {
      return trial(JSON.parse(raw), 100);
    } catch {
      storageRemove(key);
      storageRemove(originKey(key));
      return undefined;
    }
  }

  /** Autosaves the cluster (best-effort). Skipped while crashed, while a shared cluster is still on probation, and when nothing changed. */
  persist(force = false) {
    const key = this.opts.persistKey;
    const c = this.cluster;
    if (!key || !c || this.crashed) return;
    if (typeof performance !== "undefined" && performance.now() < this.holdSaveUntil) return;
    if (!force && c.state.rv === this.savedRv) return;
    try {
      const snap = c.snapshot();
      for (const k of Object.keys(snap.logs)) snap.logs[k] = snap.logs[k].slice(-100);
      const json = JSON.stringify(snap);
      const tooBig = json.length > SAVE_MAX_CHARS;
      if (tooBig !== this.saveTooBig) {
        this.saveTooBig = tooBig;
        this.bump();
      }
      if (tooBig) return;
      if (storageSet(key, json)) {
        this.savedRv = c.state.rv;
        if (this.loadedFromLink) storageSet(originKey(key), "link");
      }
    } catch {
      // Autosave is best-effort.
    }
  }

  private boot() {
    const saved = this.restored();
    if (saved) {
      this.files = { "manifest.yaml": this.opts.editor ?? DEFAULT_MANIFEST, ...(this.opts.files ?? {}) };
      this.editorFile = "manifest.yaml";
      this.attach(saved);
      this.savedRv = saved.state.rv;
      this.bootAt = saved.now;
      this.restoredFromSave = true;
      if (this.opts.speed) this.speed = this.opts.speed;
      return;
    }
    const c = new Cluster({ seed: this.opts.seed ?? 42, systemPods: this.opts.systemPods ?? true });
    this.opts.setup?.(c);
    this.files = { "manifest.yaml": this.opts.editor ?? DEFAULT_MANIFEST, ...(this.opts.files ?? {}) };
    this.editorFile = "manifest.yaml";
    c.advance(this.opts.warmupMs ?? 0);
    this.attach(c);
    this.bootAt = c.now;
    if (this.opts.speed) this.speed = this.opts.speed;
    this.opts.onStart?.(this);
  }

  private onHide = () => {
    if (typeof document === "undefined" || document.visibilityState === "hidden") this.persist();
  };

  /** Runs the steps whose simulated time has come. */
  runDue() {
    const c = this.cluster;
    if (!c || !this.queue.length) return;
    const due = this.queue.filter((q) => q.at <= c.now);
    if (!due.length) return;
    this.queue = this.queue.filter((q) => q.at > c.now);
    for (const q of due) q.fn();
  }

  start() {
    if (this.running) return;
    if (!this.cluster) this.boot();
    this.running = true;
    let last = performance.now();
    if (typeof window !== "undefined") window.addEventListener("pagehide", this.onHide);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onHide);
    const loop = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      this.frameNow = now;
      const c = this.cluster!;
      try {
        if (!this.paused && !this.crashed) c.tick(dt * this.speed);
        this.runDue();
      } catch (e) {
        // Keep the page alive: stop the clock and say so, rather than freezing silently.
        this.crashed = (e as Error)?.message || String(e);
        this.paused = true;
        this.queue = [];
        this.shownRv = -1;
        console.error("kubesim: the simulation stopped", e);
      }
      const before = this.packets.length;
      if (before) this.packets = this.packets.filter((p) => now - p.born < PACKET_MS);
      if (now - this.lastSave > 5000) {
        this.lastSave = now;
        this.persist();
      }
      let changed = false;
      if (now - this.lastLive > 250) {
        this.lastLive = now;
        changed = this.refreshLive();
      }
      // Re-render only when something on screen can have changed.
      const sec = Math.floor(c.now / 1000);
      if (changed || c.state.rv !== this.shownRv || sec !== this.shownSec || this.packets.length || this.shownPackets) {
        this.shownRv = c.state.rv;
        this.shownSec = sec;
        this.shownPackets = this.packets.length;
        this.bump();
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    this.bump();
  }

  /** Stops the clock (component unmounted or scrolled away) and saves. */
  stop() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this.onHide);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onHide);
    this.persist();
  }

  setSpeed = (s: number) => {
    this.speed = s;
    this.bump();
  };
  setPaused = (p: boolean) => {
    if (this.crashed) return;
    this.paused = p;
    this.bump();
  };

  private pushLog(e: LogEntry) {
    this.log.unshift(e);
    if (this.log.length > LOG_MAX) this.log.length = LOG_MAX;
  }
  private pushTerm(e: Omit<TermEntry, "id" | "ns">) {
    this.term.push({ ...e, id: this.id++, ns: this.namespace });
    if (this.term.length > TERM_MAX) this.term.splice(0, this.term.length - TERM_MAX);
  }
  private pushHistory(cmd: string) {
    this.history.push(cmd);
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
  }

  run = (fn: (c: Cluster) => ActionResult) => {
    const c = this.cluster;
    if (!c) return;
    const r = fn(c);
    this.pushLog({ ...r, id: this.id++, at: c.now });
    // Show it in the terminal too, and let Lesson Checks see it.
    if (!r.cmd.startsWith("#")) this.pushHistory(r.cmd);
    this.pushTerm({ cmd: r.cmd, out: r.out, ok: r.ok });
    this.bump();
    return r;
  };

  /** Sends `count` requests spread over simulated time (so packets are visible and replays are deterministic). */
  curl = (target: string, count: number) => {
    const c = this.cluster;
    if (!c) return;
    const results: string[] = [];
    const entry: LogEntry = { id: this.id++, at: c.now, cmd: `for i in $(seq ${count}); do curl -s ${target}; done`, out: "…", ok: true };
    this.pushLog(entry);
    const cluster = c;
    const send = () => {
      // A reset or a loaded link replaced the cluster: this loop belongs to the old one.
      if (this.cluster !== cluster) return;
      const r = request(cluster, target);
      results.push(r.ok ? `${r.status} ← ${r.podName}` : r.error!);
      if (!r.ok) entry.ok = false;
      entry.out = results.join("\n");
      this.bump();
    };
    send();
    for (let i = 1; i < count; i++) this.queue.push({ at: c.now + i * CURL_GAP_MS, fn: send, bg: true });
  };

  /** Runs steps at simulated-time offsets (ms from now), for guided scenarios. */
  schedule = (steps: { after: number; fn: () => void }[]) => {
    const c = this.cluster;
    if (!c) return;
    for (const s of steps) this.queue.push({ at: c.now + s.after, fn: s.fn });
  };

  /** True while a guided scenario still has steps to run. */
  get scenarioRunning() {
    return this.queue.some((q) => !q.bg);
  }

  private ctx() {
    return { cluster: this.cluster!, namespace: this.namespace, files: this.files };
  }

  /** Re-runs streaming commands; true when any output changed. */
  private refreshLive(): boolean {
    let changed = false;
    for (const t of this.term) {
      if (!t.live) continue;
      const r = runKubectl(this.ctx(), t.live);
      if (r.out !== t.out || r.ok !== t.ok) changed = true;
      t.out = r.out;
      t.ok = r.ok;
      // rollout status and wait stop by themselves once their condition holds;
      // get -w / logs -f re-run a flag-less command and stream until Ctrl+C.
      if (t.untilDone && !r.watch) {
        t.live = undefined;
        changed = true;
      }
    }
    return changed;
  }

  /** Ctrl+C: stop every streaming command. */
  stopWatch = () => {
    let stopped = false;
    for (const t of this.term)
      if (t.live) {
        t.live = undefined;
        t.out += "\n^C";
        stopped = true;
      }
    if (stopped) this.bump();
    return stopped;
  };

  /** Runs a terminal command line. */
  exec = (line: string) => {
    const c = this.cluster;
    if (!c) return;
    const trimmed = line.trim();
    if (trimmed === "clear") {
      this.term = [];
      this.bump();
      return;
    }
    this.stopWatch();
    const ns = this.namespace;
    const ctx = this.ctx();
    const r = runKubectl(ctx, trimmed);
    if (trimmed) this.pushHistory(trimmed);
    this.term.push({ id: this.id++, cmd: trimmed, out: r.out, ok: r.ok, ns, live: r.watch, untilDone: !/(^watch\s|\s(-w|--watch|-f|--follow)(\s|=|$))/.test(trimmed) });
    if (this.term.length > TERM_MAX) this.term.splice(0, this.term.length - TERM_MAX);
    if (ctx.namespace !== this.namespace) {
      this.namespace = ctx.namespace;
      this.viewNs = ctx.namespace;
    }
    if (trimmed) this.pushLog({ id: this.id++, at: c.now, cmd: trimmed, out: r.out, ok: r.ok });
    if (r.openFile) this.openFile(r.openFile);
    this.termSeq++;
    this.bump();
    return r;
  };

  /** Opens a file in the Editor, optionally replacing its contents. */
  openFile = (name: string, content?: string) => {
    if (content !== undefined) this.files[name] = content;
    this.files[name] ??= "";
    this.editorFile = name;
    this.editSeq++;
    this.bump();
  };

  /** Asks the UI to show the Terminal tab. */
  showTerminal = () => {
    this.termSeq++;
    this.bump();
  };

  /** Applies YAML (the Editor's Apply button). */
  apply = (yaml: string, file?: string) => {
    const c = this.cluster;
    if (!c) return;
    const name = file ?? this.editorFile;
    this.files[name] = yaml;
    const r = applyYaml(this.ctx(), yaml);
    const cmd = `kubectl apply -f ${name}`;
    this.pushHistory(cmd);
    this.pushTerm({ cmd, out: r.out, ok: r.ok });
    this.pushLog({ id: this.id++, at: c.now, cmd, out: r.out, ok: r.ok });
    this.bump();
    return r;
  };

  private clearSession() {
    this.crashed = undefined;
    this.paused = false;
    this.queue = [];
    this.log = [];
    this.term = [];
    this.history = [];
    this.namespace = "default";
    this.viewNs = "*";
    this.saveTooBig = false;
    this.holdSaveUntil = 0;
    this.shownRv = -1;
  }

  /**
   * Replaces the cluster with a snapshot from a shared link. The Learner's own
   * autosave is kept as a backup (see restoreBackup), and the shared cluster
   * isn't autosaved until it has run cleanly for a few seconds.
   */
  load = (state: ClusterState) => {
    let next: Cluster;
    try {
      next = trial(state, 5000);
    } catch {
      throw new Error("the cluster in it doesn't run in this version of kubesim.");
    }
    const key = this.opts.persistKey;
    if (key && typeof localStorage !== "undefined") {
      // Save the Learner's latest work first, then keep it as the backup,
      // unless what's saved is itself a shared cluster (keep the older backup).
      if (!this.loadedFromLink) this.persist();
      const current = storageGet(key);
      if (current && storageGet(originKey(key)) !== "link") storageSet(backupKey(key), current);
    }
    this.clearSession();
    this.attach(next);
    this.bootAt = next.now;
    this.restoredFromSave = false;
    this.loadedFromLink = true;
    this.holdSaveUntil = performance.now() + LINK_TRUST_MS;
    this.bump();
  };

  /** True when there is a cluster saved from before a shared link replaced it. */
  hasBackup = () => {
    const key = this.opts.persistKey;
    return !!key && typeof localStorage !== "undefined" && !!storageGet(backupKey(key));
  };

  /** Brings back the cluster the Learner had before opening a shared link. */
  restoreBackup = (): boolean => {
    const key = this.opts.persistKey;
    if (!key) return false;
    const raw = storageGet(backupKey(key));
    if (!raw) return false;
    let c: Cluster;
    try {
      c = trial(JSON.parse(raw), 100);
    } catch {
      storageRemove(backupKey(key));
      this.bump();
      return false;
    }
    this.clearSession();
    this.attach(c);
    this.bootAt = c.now;
    this.restoredFromSave = true;
    this.loadedFromLink = false;
    storageSet(key, raw);
    this.savedRv = c.state.rv;
    storageRemove(originKey(key));
    storageRemove(backupKey(key));
    this.bump();
    return true;
  };

  /** Forgets the backup made when a shared link was opened. */
  dropBackup = () => {
    const key = this.opts.persistKey;
    if (key) storageRemove(backupKey(key));
    this.bump();
  };

  /** The current cluster, for sharing. */
  snapshot = () => this.cluster?.snapshot();

  setViewNs = (ns: string) => {
    this.viewNs = ns;
    this.bump();
  };

  reset = () => {
    this.clearSession();
    this.opts.onReset?.();
    const key = this.opts.persistKey;
    if (key) {
      storageRemove(key);
      storageRemove(originKey(key));
    }
    this.restoredFromSave = false;
    this.loadedFromLink = false;
    this.cluster = null;
    this.boot();
    this.bump();
  };
}

export interface SimOptions {
  seed?: number;
  systemPods?: boolean;
  /** Builds the starting cluster (Lessons, Explainers). */
  setup?: (c: Cluster) => void;
  /** Sim time to run after setup before showing it. */
  warmupMs?: number;
  /** Initial sim speed. */
  speed?: number;
  /** Called after each fresh boot (first start and every reset; not when restoring an autosave). */
  onStart?: (s: SimStore) => void;
  /** Autosave the cluster to localStorage under this key and restore it on load. */
  persistKey?: string;
  /** Called when the Learner resets, before the new boot. */
  onReset?: () => void;
  /** Initial contents of manifest.yaml. */
  editor?: string;
  files?: Record<string, string>;
}

/** Runs a SimStore while mounted (and while `active`, e.g. on screen). */
export function useSimulation(opts?: SimOptions, active = true): SimStore {
  const [store] = useState(() => new SimStore(opts));
  useSyncExternalStore(store.subscribe, store.getVersion, () => 0);
  useEffect(() => {
    if (!active) return;
    store.start();
    return () => store.stop();
  }, [store, active]);
  return store;
}
