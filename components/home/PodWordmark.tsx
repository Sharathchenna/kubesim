"use client";

// The home page wordmark, drawn as a few hundred live Pods. The cluster keeps killing a
// few and the scheduler flies replacements back in from the top; hovering kills Pods and a
// click (or tap) takes out a whole patch, like a node failing. Static for reduced motion,
// and paused while it's scrolled out of view.

import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "../learn/checks";

type State = "fly" | "run" | "crash" | "pend";
interface Pod {
  x: number;
  y: number;
  state: State;
  t0: number;
  dur: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  spin: number;
  land: number;
}

const WORD = "kubesim";
const TOP = 30; // room above the word for the scheduler pill
const POD = "#ffffff";
const CRASH = "#ff5c61";
const PENDING = "rgb(255 255 255 / 0.55)";
const CRASH_MS = 380;
const PENDING_MS = 550;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const bezier = (a: number, b: number, c: number, t: number) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * b + t * t * c;

function hept(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rot = 0) {
  ctx.beginPath();
  for (let i = 0; i < 7; i++) {
    const a = rot - Math.PI / 2 + (i * 2 * Math.PI) / 7;
    if (i) ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
    else ctx.moveTo(x + r * Math.cos(a), y + r * Math.sin(a));
  }
  ctx.closePath();
}

/** Where the Pods sit: the centres of a hex grid that fall inside the word, fitted to the canvas. */
function slots(W: number, H: number, family: string, step: number): { x: number; y: number }[] {
  // Draw on a canvas three times as wide so an oversized first guess isn't clipped while we measure it.
  const BW = W * 3;
  const o = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!o) return [];
  o.canvas.width = BW;
  o.canvas.height = H;
  let size = 200;
  const draw = () => {
    o.font = `800 ${size}px ${family}`;
    o.letterSpacing = `${-size * 0.03}px`;
    o.textAlign = "center";
    o.clearRect(0, 0, BW, H);
    const asc = o.measureText(WORD).actualBoundingBoxAscent;
    o.fillText(WORD, BW / 2, TOP + (H - TOP - asc) / 2 + asc);
    const d = o.getImageData(0, 0, BW, H).data;
    let x0 = BW;
    let x1 = 0;
    for (let y = 0; y < H; y += 2)
      for (let x = 0; x < BW; x++)
        if (d[(y * BW + x) * 4 + 3] > 140) {
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
        }
    return { d, x0, x1 };
  };
  const first = draw();
  size = Math.min((size * (W - 8)) / (first.x1 - first.x0 + 1), (H - TOP - 6) / 0.76);
  const { d } = draw();
  const shift = Math.round(BW / 2 - W / 2);
  const out: { x: number; y: number }[] = [];
  for (let row = 0, y = step / 2; y < H; row++, y += step * 0.9)
    for (let x = step / 2 + (row % 2 ? step / 2 : 0); x < W; x += step) if (d[((y | 0) * BW + (x | 0) + shift) * 4 + 3] > 140) out.push({ x, y });
  return out;
}

/** Runs the wordmark on a canvas until the returned function is called. */
function run(cv: HTMLCanvasElement, counter: HTMLElement | null): () => void {
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext("2d");
  if (!ctx || W < 50 || H < 50) return () => {};
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const step = Math.max(4.2, Math.min(10, W / 88));
  const r = step * 0.47;
  const family = getComputedStyle(cv).fontFamily;
  const mono = getComputedStyle(cv).getPropertyValue("--font-geist-mono") || "monospace";
  const origin = { x: W / 2, y: 14 };
  const now0 = performance.now();
  const pods: Pod[] = slots(W, H, family, step).map((s) => ({ ...s, state: "run", t0: 0, dur: 0, fx: 0, fy: 0, cx: 0, cy: 0, spin: 0, land: -1e9 }));

  if (prefersReducedMotion()) {
    ctx.fillStyle = POD;
    for (const p of pods) {
      hept(ctx, p.x, p.y, r);
      ctx.fill();
    }
    if (counter) counter.textContent = `${pods.length} / ${pods.length} Running`;
    return () => {};
  }

  let restarts = 0;
  let lastKill = 0;
  let lastCount = 0;
  let mx = -1e9;
  let my = -1e9;
  const launch = (p: Pod, t: number) => {
    Object.assign(p, { state: "fly", t0: t, dur: rand(650, 1000), fx: origin.x + rand(-30, 30), fy: origin.y + 6, spin: rand(-4, 4) });
    p.cx = (p.fx + p.x) / 2 + rand(-120, 120);
    p.cy = Math.min(p.fy, p.y) - rand(10, 60);
  };
  const kill = (p: Pod, t: number) => {
    if (p.state !== "run") return;
    p.state = "crash";
    p.t0 = t;
    restarts++;
  };
  // Arrive left to right, as if the scheduler is placing the whole word.
  for (const p of pods) launch(p, now0 + (p.x / W) * 900 + rand(0, 600));

  const ac = new AbortController();
  const at = (e: PointerEvent) => {
    const b = cv.getBoundingClientRect();
    mx = e.clientX - b.left;
    my = e.clientY - b.top;
  };
  cv.addEventListener("pointermove", (e) => (e.pointerType === "mouse" ? at(e) : undefined), { signal: ac.signal });
  cv.addEventListener("pointerleave", () => (mx = my = -1e9), { signal: ac.signal });
  cv.addEventListener(
    "pointerdown",
    (e) => {
      const b = cv.getBoundingClientRect();
      const x = e.clientX - b.left;
      const y = e.clientY - b.top;
      const t = performance.now();
      for (const p of pods) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < step * 8) kill(p, t + d * 3);
      }
    },
    { signal: ac.signal },
  );

  const hover = step * 2;
  const frame = (now: number) => {
    ctx.clearRect(0, 0, W, H);
    if (now - lastKill > 70 && now - now0 > 2600) {
      lastKill = now;
      kill(pods[(Math.random() * pods.length) | 0], now);
    }
    let running = 0;
    for (const p of pods) {
      if (p.state === "run" && Math.abs(p.x - mx) < hover && Math.abs(p.y - my) < hover && Math.hypot(p.x - mx, p.y - my) < hover) kill(p, now);
      if (p.state === "fly") {
        const k = (now - p.t0) / p.dur;
        if (k < 0) continue;
        if (k < 1) {
          const e = easeInOut(k);
          ctx.fillStyle = POD;
          hept(ctx, bezier(p.fx, p.cx, p.x, e), bezier(p.fy, p.cy, p.y, e), r * (0.55 + 0.45 * e), (1 - e) * p.spin);
          ctx.fill();
          continue;
        }
        p.state = "run";
        p.land = now;
      }
      if (p.state === "run") {
        running++;
        const pop = Math.max(0, 1 - (now - p.land) / 260);
        ctx.fillStyle = POD;
        hept(ctx, p.x, p.y, r * (1 + 0.35 * pop));
        ctx.fill();
      } else if (p.state === "crash") {
        const k = (now - p.t0) / CRASH_MS;
        if (k < 0) {
          // A node failure spreads out from the click, so some Pods are still waiting to go.
          running++;
          ctx.fillStyle = POD;
          hept(ctx, p.x, p.y, r);
          ctx.fill();
        } else if (k < 1) {
          ctx.fillStyle = CRASH;
          hept(ctx, p.x, p.y, r * (k < 0.25 ? 1 + k * 1.4 : 1.35 * (1 - (k - 0.25) / 0.75)));
          ctx.fill();
        } else {
          p.state = "pend";
          p.t0 = now;
        }
      } else if (p.state === "pend") {
        ctx.setLineDash([1.6, 1.6]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = PENDING;
        hept(ctx, p.x, p.y, r * 0.9);
        ctx.stroke();
        ctx.setLineDash([]);
        if (now - p.t0 > PENDING_MS) launch(p, now);
      }
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = PENDING;
    ctx.beginPath();
    ctx.roundRect(origin.x - 54, 2, 108, 19, 10);
    ctx.fillStyle = "#326ce5";
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgb(255 255 255 / 0.9)";
    ctx.font = `500 9.5px ${mono}`;
    ctx.textAlign = "center";
    ctx.fillText("kube-scheduler", origin.x, 15.5);
    if (counter && now - lastCount > 200) {
      lastCount = now;
      counter.textContent = `${running} / ${pods.length} Running · ${restarts} restarts`;
    }
    raf = requestAnimationFrame(frame);
  };

  let raf = 0;
  const io = new IntersectionObserver(([e]) => {
    if (e.isIntersecting && !raf) raf = requestAnimationFrame(frame);
    if (!e.isIntersecting) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  });
  io.observe(cv);
  return () => {
    io.disconnect();
    cancelAnimationFrame(raf);
    ac.abort();
  };
}

export function PodWordmark({ children }: { children?: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const counter = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = box.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    let alive = true;
    let started = false;
    let width = 0;
    let stop = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      stop();
      width = el.clientWidth;
      started = true;
      stop = run(cv, counter.current);
    };
    const ro = new ResizeObserver(() => {
      if (!started || Math.abs(el.clientWidth - width) < 24) return;
      clearTimeout(timer);
      timer = setTimeout(start, 150);
    });
    ro.observe(el);
    // The word is sampled from the real font, so wait for it.
    document.fonts
      .load(`800 100px ${getComputedStyle(cv).fontFamily}`)
      .catch(() => [])
      .then(() => alive && start());
    return () => {
      alive = false;
      ro.disconnect();
      clearTimeout(timer);
      stop();
    };
  }, []);

  return (
    <div ref={box}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        {children}
        <span ref={counter} aria-hidden className="font-mono text-[11.5px] uppercase tracking-[0.06em] text-white/80" />
      </div>
      <canvas ref={canvas} aria-hidden className="mt-2 block h-[clamp(96px,27vw,330px)] w-full cursor-crosshair font-sans" />
    </div>
  );
}
