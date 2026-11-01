"use client";

// "Ways to learn" as one picture: a lesson checking itself (the lead tile), a Node switched off in the
// Sandbox, a Challenge's broken Pods coming back, an exam clock, and one line about the project. Each
// picture is its own Stage at 1:1 and plays once as the grid scrolls in, staggered in reading order; the
// copy is page type outside the pictures.

import Link from "next/link";
import { Check, Count, type Act } from "../stageshow/kit";
import { Scene } from "../stageshow/Scene";

const GITHUB = "https://github.com/Sharathchenna/kubesim";

/** Tiles start one after another in reading order, about 100ms apart. */
const after = (a: Act<object>, i: number) => a.wait(500 + i * 110);

/* ------------------------------------------------------------------ the lesson: a step that checks itself */

type L = { input: string; ran: boolean; done: boolean };
const STEPS = ["Look at the cluster", "Run a Pod", "Wait for it to be Running", "Read its logs"];
const LESSON_CMD = "kubectl get pod web";

async function lessonScript(a: Act<L>) {
  await after(a as Act<object>, 0);
  await a.type("input", LESSON_CMD, { interval: 55 });
  await a.wait(300);
  await a.set({ input: "", ran: true });
  await a.wait(500);
  await a.set({ done: true });
}

function LessonPicture() {
  return (
    <Scene<L> width={720} height={222} compact={{ below: 560, width: 358, height: 222 }} initial={{ input: "", ran: false, done: false }} poster={{ input: "", ran: true, done: true }} script={lessonScript} play="once">
      {(s, _r, layout) => {
        const compact = layout === "compact";
        const steps = (
          <div className="px-5 pb-5 pt-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[16px] font-semibold">Your first Pod</span>
              <span className="text-[12.5px] text-ink-soft">Lesson 1 of 19</span>
            </div>
            <div className="mt-2.5 flex items-center gap-3">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink/10">
                <div className="h-full rounded-full bg-signal transition-[width] duration-700 ease-[cubic-bezier(0.45,0,0.1,1)]" style={{ width: s.done ? "60%" : "40%" }} />
              </div>
              <span className="font-mono text-[12px] tabular-nums text-ink-soft">
                <Count value={s.done ? 3 : 2} duration={500} />
                /5
              </span>
            </div>
            <div className="mt-3 space-y-0.5">
              {STEPS.map((t, i) => {
                const on = i < 2 || (i === 2 && s.done);
                const current = s.done ? i === 3 : i === 2;
                return (
                  <div key={t} className={`-mx-2.5 flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[14px] leading-[1.3] transition-colors duration-300 ${current ? "bg-signal-soft font-medium" : ""} ${!on && !current ? "text-ink-soft" : ""}`}>
                    <Check on={on} pending={current && !on} size={16} className="shrink-0" />
                    <span>{t}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
        if (compact)
          return (
            <div className="absolute left-4 right-0 top-0 overflow-hidden rounded-tl-xl border-l border-t border-ink/10 bg-paper shadow-[0_18px_40px_-20px_rgb(15_23_42/0.35)]">
              {steps}
            </div>
          );
        return (
          <div className="absolute left-6 top-0 grid h-[260px] w-[760px] grid-cols-[318px_1fr] overflow-hidden rounded-tl-xl border-l border-t border-ink/10 bg-paper shadow-[0_18px_40px_-20px_rgb(15_23_42/0.35)]">
            <div className="border-r border-ink/10">{steps}</div>
            <div>
              <div className="flex gap-4 border-b border-ink/10 px-4 text-[12.5px]">
                <span className="-mb-px border-b-2 border-ink py-2 font-medium">Terminal</span>
                <span className="py-2 text-ink-soft">YAML editor</span>
                <span className="py-2 text-ink-soft">Events</span>
              </div>
              <div className="whitespace-pre px-4 py-3 font-mono text-[12px] leading-[19px]">
                <div>
                  <span className="text-ink-soft">$ </span>kubectl run web --image=nginx
                </div>
                <div className="text-ink-soft">pod/web created</div>
                {s.ran && (
                  <>
                    <div>
                      <span className="text-ink-soft">$ </span>
                      {LESSON_CMD}
                    </div>
                    <div className="text-ink-soft">NAME   READY   STATUS    RESTARTS   AGE</div>
                    <div>
                      web    1/1     <span className="font-semibold text-green-700">Running</span>   0          14s
                    </div>
                  </>
                )}
                <div>
                  <span className="text-ink-soft">$ </span>
                  {s.input}
                  <span className="ml-px inline-block h-[13px] w-[7px] translate-y-[2px] bg-ink/70 cv-blink" />
                </div>
              </div>
            </div>
          </div>
        );
      }}
    </Scene>
  );
}

/* ------------------------------------------------------------------ the Sandbox: switch a Node off */

type N = { down: boolean; moved: boolean };
const POD_W = 64,
  POD_H = 26,
  GAP = 8;
// Two Node cards; each holds Pods in a 2-wide grid under its header.
const CARD = [
  { x: 16, name: "worker-1" },
  { x: 188, name: "worker-2" },
];

const slot = (card: number, i: number) => ({ left: CARD[card].x + 12 + (i % 2) * (POD_W + GAP), top: 66 + Math.floor(i / 2) * (POD_H + GAP) });
const PODS = [
  { name: "76hc8", from: [0, 0], to: [0, 0] },
  { name: "qmfvv", from: [0, 1], to: [0, 1] },
  { name: "1zh7s", from: [1, 0], to: [0, 2] },
  { name: "krm7k", from: [1, 1], to: [0, 3] },
] as const;

async function nodeScript(a: Act<N>) {
  await after(a as Act<object>, 1);
  await a.wait(300);
  await a.set({ down: true });
  await a.wait(900);
  await a.set({ moved: true });
}

function SandboxPicture() {
  return (
    <Scene<N> width={360} height={190} initial={{ down: false, moved: false }} poster={{ down: true, moved: true }} script={nodeScript} play="once">
      {(s) => (
        <>
          {CARD.map((c, ci) => {
            const off = ci === 1 && s.down;
            return (
              <div key={c.name} className={`absolute top-2 h-[240px] w-[160px] rounded-xl border bg-paper px-3 py-2.5 transition-colors duration-300 ${off ? "border-red-200 bg-red-50" : "border-ink/10"}`} style={{ left: c.x }}>
                <div className="flex items-center justify-between gap-1.5 whitespace-nowrap">
                  <span className="text-[13.5px] font-semibold">{c.name}</span>
                  <span className={`flex items-center gap-1 text-[11px] font-medium ${off ? "text-red-700" : "text-green-700"}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${off ? "bg-red-600" : "bg-green-600"}`} />
                    {off ? "NotReady" : "Ready"}
                  </span>
                </div>
                <div className="mt-0.5 text-[11.5px] text-ink-soft">
                  worker · <Count value={ci === 0 ? (s.moved ? 4 : 2) : s.moved ? 0 : 2} duration={400} /> pods
                </div>
              </div>
            );
          })}
          {PODS.map((p, i) => {
            const [card, at] = s.moved ? p.to : p.from;
            const stranded = s.down && !s.moved && p.from[0] === 1;
            return (
              <div
                key={p.name}
                className={`absolute flex items-center rounded-md border border-ink/10 bg-paper font-mono text-[11.5px] transition-[left,top,opacity] duration-[900ms] ease-[cubic-bezier(0.45,0,0.1,1)] ${stranded ? "opacity-45" : ""}`}
                style={{ ...slot(card, at), width: POD_W, height: POD_H, transitionDelay: s.moved ? `${(i - 2) * 120}ms` : "0ms" }}
              >
                <span className="ml-1 mr-1.5 h-3.5 w-[3px] rounded-full bg-[hsl(217_70%_55%)]" />
                {p.name}
              </div>
            );
          })}
        </>
      )}
    </Scene>
  );
}

/* ------------------------------------------------------------------ a Challenge: broken Pods, a goal */

type C = { fixed: number; goal: boolean };
const BROKEN = ["9pgml", "5h59g", "skzwr"];

async function challengeScript(a: Act<C>) {
  await after(a as Act<object>, 2);
  await a.wait(400);
  for (let i = 1; i <= 3; i++) {
    await a.set({ fixed: i });
    await a.wait(260);
  }
  await a.wait(300);
  await a.set({ goal: true });
}

function ChallengePicture() {
  return (
    <Scene<C> width={360} height={226} initial={{ fixed: 0, goal: false }} poster={{ fixed: 3, goal: true }} script={challengeScript} play="once">
      {(s) => (
        <div className="absolute left-4 right-0 top-3 rounded-l-xl border-y border-l border-ink/10 bg-paper px-4 py-3.5">
          <div className="text-[12px] text-ink-soft">
            Challenge · Easy · <Count value={s.goal ? 1 : 0} duration={400} />
            /1 goals
          </div>
          <div className="mt-0.5 text-[16px] font-semibold">The site is down</div>
          <div className="mt-2.5 space-y-1">
            {BROKEN.map((n, i) => {
              const ok = s.fixed > i;
              return (
                <div key={n} className={`flex items-center gap-3 rounded-md border px-2.5 py-1 font-mono text-[11.5px] leading-[1.35] transition-colors duration-200 ${ok ? "border-ink/10 bg-paper" : "border-red-200 bg-red-50"}`}>
                  <span className="w-12">{n}</span>
                  <span className={`flex items-center gap-1.5 font-sans text-[12px] font-medium ${ok ? "text-green-700" : "text-red-700"}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-green-600" : "bg-red-600"}`} />
                    {ok ? "Running" : "ImagePullBackOff"}
                  </span>
                </div>
              );
            })}
          </div>
          <div className={`mt-3 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] transition-colors duration-300 ${s.goal ? "bg-green-50" : "bg-ink/[0.03]"}`}>
            <Check on={s.goal} pending={!s.goal} size={16} />
            All three web Pods Running and Ready
          </div>
        </div>
      )}
    </Scene>
  );
}

/* ------------------------------------------------------------------ an exam: the clock */

type E = { left: number };
async function examScript(a: Act<E>) {
  await after(a as Act<object>, 3);
  for (let i = 1; i <= 3; i++) {
    await a.wait(1000);
    await a.set({ left: 3600 - i });
  }
}

function ExamClock() {
  return (
    <Scene<E> width={320} height={80} initial={{ left: 3600 }} poster={{ left: 3600 }} script={examScript} play="once">
      {(s) => (
        <div className="absolute left-0 top-0 flex font-mono text-[72px] font-semibold leading-none tracking-[-0.04em] tabular-nums">
          <Count value={Math.floor(s.left / 60)} duration={450} />
          <span className="-mx-[0.08em]">:</span>
          <Count value={s.left % 60} format={(n) => String(Math.round(n)).padStart(2, "0")} duration={450} />
        </div>
      )}
    </Scene>
  );
}

/* ------------------------------------------------------------------ the grid */

const TILE = "group relative flex min-w-0 flex-col overflow-hidden rounded-2xl border border-ink/10 bg-paper transition-[border-color,box-shadow] duration-300 hover:border-ink/20 hover:shadow-[0_12px_32px_-12px_rgb(15_23_42/0.18)]";
const COPY = "px-6 pt-6 text-[18px] leading-snug";
const LEAD = "font-semibold text-ink group-hover:text-signal";

export function WaysBento({ lessons, tracks, challenges, exams }: { lessons: number; tracks: number; challenges: number; exams: number }) {
  return (
    <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      <Link href="/learn" className={`${TILE} md:col-span-2`}>
        <p className={COPY}>
          <span className={LEAD}>Lessons.</span> <span className="text-ink-soft">One step at a time. Each step checks itself as you type.</span>
        </p>
        <p className="px-6 pt-1 text-[13.5px] text-ink-soft">
          {lessons} lessons in {tracks} tracks
        </p>
        <div aria-hidden className="mt-5 min-w-0">
          <LessonPicture />
        </div>
      </Link>

      <Link href="/sandbox" className={TILE}>
        <p className={COPY}>
          <span className={LEAD}>Sandbox.</span> <span className="text-ink-soft">A cluster that&apos;s all yours. Switch a Node off and watch.</span>
        </p>
        <div aria-hidden className="mt-auto min-w-0 pt-5">
          <SandboxPicture />
        </div>
      </Link>

      <Link href="/challenges" className={TILE}>
        <p className={COPY}>
          <span className={LEAD}>Challenges.</span> <span className="text-ink-soft">A broken cluster and a goal. No instructions.</span>
        </p>
        <p className="px-6 pt-1 text-[13.5px] text-ink-soft">{challenges} challenges</p>
        <div aria-hidden className="mt-auto min-w-0 pt-5">
          <ChallengePicture />
        </div>
      </Link>

      <Link href="/exams" className={`${TILE} p-6`}>
        <p className="text-[18px] leading-snug">
          <span className={LEAD}>Practice exams.</span> <span className="text-ink-soft">On the clock, like the real thing.</span>
        </p>
        <div aria-hidden className="mt-6 min-w-0">
          <ExamClock />
        </div>
        <p className="mt-3 text-[13.5px] text-ink-soft">
          {exams} exams in the style of the CKAD and CKA · tasks, a timer and a pass mark
        </p>
      </Link>

      <a href={GITHUB} className="group flex flex-col justify-between rounded-2xl bg-[#326ce5] p-6 text-white transition-colors hover:bg-[#2a5bc4]">
        <p className="text-balance text-[30px] font-extrabold leading-[1.08] tracking-[-0.03em]">Free and open source. Nothing to install.</p>
        <p className="mt-6 text-[14px] text-white/80">
          MIT licence · <span className="font-medium text-white underline-offset-4 group-hover:underline">Read the code on GitHub →</span>
        </p>
      </a>
    </div>
  );
}
