"use client";

// Runs a Simulated Cluster in the browser. A SimStore owns the cluster and
// advances sim time on requestAnimationFrame; React subscribes to it with
// useSyncExternalStore and re-renders once per animation frame.

import { useEffect, useState, useSyncExternalStore } from "react";
import { Cluster, request, type KubeEvent } from "@/lib/engine";
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
  podUid: string;
  ok: boolean;
  born: number; // performance.now()
}

export interface LogEntry extends ActionResult {
  id: number;
  at: number; // sim ms
}

export const PACKET_MS = 900;

export class SimStore {
  cluster: Cluster | null = null;
  events: KubeEvent[] = [];
  packets: Packet[] = [];
  log: LogEntry[] = [];
  queue: { at: number; fn: () => void }[] = [];
  /** Stable Pod → slot assignment per Node for the Cluster View. */
  slots = new Map<string, Map<string, number>>();
  speed = 1;
  paused = false;
  frameNow = 0;
  /** performance.now() when the view started, for the intro assembly animation. */
  startedAt = 0;
  version = 0;
  /** kubectl's current namespace. */
  namespace = "default";
  /** Sim time when the current cluster was shown (after warm-up). */
  bootAt = 0;
  /** Every command line the Learner ran (Lesson Checks look at this). */
  history: string[] = [];
  /** Terminal scrollback. `live` entries are streaming commands, re-run until Ctrl+C. */
  term: { id: number; cmd?: string; out: string; ok: boolean; live?: string }[] = [];
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
  /** True when the cluster came from an autosave. */
  restoredFromSave = false;
  private id = 1;
  constructor(private opts: SimOptions = {}) {}
  private raf = 0;
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
    c.subscribe((s) => {
      if (s.type === "event") {
        const i = this.events.findIndex((e) => e.metadata.uid === s.event.metadata.uid);
        if (i >= 0) this.events.splice(i, 1);
        this.events.unshift(s.event);
        if (this.events.length > 300) this.events.pop();
      } else if (s.type === "traffic") {
        this.packets.push({ id: this.id++, serviceUid: s.serviceUid, podUid: s.podUid, ok: s.ok, born: performance.now() });
      }
    });
  }

  private restored(): Cluster | undefined {
    const key = this.opts.persistKey;
    if (!key || typeof localStorage === "undefined") return undefined;
    try {
      const raw = localStorage.getItem(key);
      return raw ? new Cluster(JSON.parse(raw)) : undefined;
    } catch {
      localStorage.removeItem(key);
      return undefined;
    }
  }

  private persist() {
    const key = this.opts.persistKey;
    if (!key || !this.cluster) return;
    try {
      const snap = this.cluster.snapshot();
      for (const k of Object.keys(snap.logs)) snap.logs[k] = snap.logs[k].slice(-100);
      localStorage.setItem(key, JSON.stringify(snap));
    } catch {
      // Storage full or unavailable: autosave is best-effort.
    }
  }

  private boot() {
    const saved = this.restored();
    if (saved) {
      this.files = { "manifest.yaml": this.opts.editor ?? DEFAULT_MANIFEST, ...(this.opts.files ?? {}) };
      this.attach(saved);
      this.bootAt = saved.now;
      this.restoredFromSave = true;
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

  start() {
    if (!this.cluster) this.boot();
    let last = performance.now();
    if (!this.startedAt) this.startedAt = last;
    const loop = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      this.frameNow = now;
      const c = this.cluster!;
      if (!this.paused) c.tick(dt * this.speed);
      const due = this.queue.filter((q) => q.at <= c.now);
      if (due.length) {
        this.queue = this.queue.filter((q) => q.at > c.now);
        for (const q of due) q.fn();
      }
      this.packets = this.packets.filter((p) => now - p.born < PACKET_MS);
      if (now - this.lastSave > 5000) {
        this.lastSave = now;
        this.persist();
      }
      if (now - this.lastLive > 250) {
        this.lastLive = now;
        this.refreshLive();
      }
      this.bump();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    this.bump();
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  setSpeed = (s: number) => {
    this.speed = s;
    this.bump();
  };
  setPaused = (p: boolean) => {
    this.paused = p;
    this.bump();
  };

  run = (fn: (c: Cluster) => ActionResult) => {
    const c = this.cluster;
    if (!c) return;
    const r = fn(c);
    this.log.unshift({ ...r, id: this.id++, at: c.now });
    if (this.log.length > 100) this.log.pop();
    // Show it in the terminal too, and let Lesson Checks see it.
    if (!r.cmd.startsWith("#")) this.history.push(r.cmd);
    this.term.push({ id: this.id++, cmd: r.cmd, out: r.out, ok: r.ok });
    this.bump();
    return r;
  };

  /** Sends `count` requests spread over real time, so packets are visible. */
  curl = (target: string, count: number) => {
    const c = this.cluster;
    if (!c) return;
    const results: string[] = [];
    const entry: LogEntry = { id: this.id++, at: c.now, cmd: `for i in $(seq ${count}); do curl -s ${target}; done`, out: "…", ok: true };
    this.log.unshift(entry);
    let i = 0;
    const tick = () => {
      const r = request(this.cluster!, target);
      results.push(r.ok ? `${r.status} ← ${r.podName}` : r.error!);
      if (!r.ok) entry.ok = false;
      entry.out = results.join("\n");
      if (++i < count) setTimeout(tick, 220);
      this.bump();
    };
    tick();
  };

  /** Runs steps at simulated-time offsets (ms from now), for guided scenarios. */
  schedule = (steps: { after: number; fn: () => void }[]) => {
    const c = this.cluster;
    if (!c) return;
    for (const s of steps) this.queue.push({ at: c.now + s.after, fn: s.fn });
  };

  private ctx() {
    return { cluster: this.cluster!, namespace: this.namespace, files: this.files };
  }

  private refreshLive() {
    for (const t of this.term) {
      if (!t.live) continue;
      const r = runKubectl(this.ctx(), t.live);
      t.out = r.out;
      t.ok = r.ok;
      // rollout status stops by itself once the rollout finishes.
      if (/rollout status/.test(t.live) && !r.watch) t.live = undefined;
    }
  }

  /** Ctrl+C: stop every streaming command. */
  stopWatch = () => {
    let stopped = false;
    for (const t of this.term) if (t.live) {
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
    const ctx = this.ctx();
    const r = runKubectl(ctx, trimmed);
    if (ctx.namespace !== this.namespace) {
      this.namespace = ctx.namespace;
      this.viewNs = ctx.namespace;
    }
    if (trimmed) this.history.push(trimmed);
    this.term.push({ id: this.id++, cmd: trimmed, out: r.out, ok: r.ok, live: r.watch });
    if (trimmed) this.log.unshift({ id: this.id++, at: c.now, cmd: trimmed, out: r.out, ok: r.ok });
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
  apply = (yaml: string) => {
    const c = this.cluster;
    if (!c) return;
    const name = this.editorFile;
    this.files[name] = yaml;
    const r = applyYaml(this.ctx(), yaml);
    const cmd = `kubectl apply -f ${name}`;
    this.history.push(cmd);
    this.term.push({ id: this.id++, cmd, out: r.out, ok: r.ok });
    this.log.unshift({ id: this.id++, at: c.now, cmd, out: r.out, ok: r.ok });
    this.bump();
    return r;
  };

  setViewNs = (ns: string) => {
    this.viewNs = ns;
    this.bump();
  };

  reset = () => {
    this.queue = [];
    this.log = [];
    this.term = [];
    this.history = [];
    this.namespace = "default";
    this.viewNs = "*";
    this.opts.onReset?.();
    if (this.opts.persistKey) localStorage.removeItem(this.opts.persistKey);
    this.restoredFromSave = false;
    this.boot();
    this.startedAt = performance.now();
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
  /** Called after each boot (first start and every reset). */
  onStart?: (s: SimStore) => void;
  /** Autosave the cluster to localStorage under this key and restore it on load. */
  persistKey?: string;
  /** Called when the Learner resets, before the new boot. */
  onReset?: () => void;
  /** Initial contents of manifest.yaml. */
  editor?: string;
  files?: Record<string, string>;
}

export function useSimulation(opts?: SimOptions): SimStore {
  const [store] = useState(() => new SimStore(opts));
  useSyncExternalStore(store.subscribe, store.getVersion, () => 0);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  return store;
}
