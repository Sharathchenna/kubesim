"use client";

// The Daily Incident, played as a short loop beside its pitch on the home page: the pager goes off, the
// on-call engineer finds the broken Pod and fixes it with kubectl, the errors drain and the pager turns
// green with a time to share. The pager is the real one's markup (IncidentPlayer's Pager and Resolved);
// the terminal is a satellite straddling its foot.

import { Collapse, Count, type Act } from "../stageshow/kit";
import { Scene } from "../stageshow/Scene";

type Phase = "down" | "recovering" | "resolved";
type S = { shown: boolean; clock: number; phase: Phase; err: number; input: string; ran: number; debrief: boolean };

const GET = "kubectl get pod shop-db-0";
const FIX = "kubectl create secret generic shop-db --from-literal=POSTGRES_PASSWORD=change-me";
const START: S = { shown: true, clock: 38, phase: "down", err: 100, input: "", ran: 0, debrief: false };
/** The poster tells the whole story on its own: both commands run, the pager green. */
const POSTER: S = { ...START, clock: 47, phase: "resolved", err: 0, ran: 2 };
const RESOLVED_IN = 47;

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

async function script(a: Act<S>) {
  // The pager's clock runs until it's resolved, as the real one does.
  const ticking = (async () => {
    try {
      for (;;) {
        await a.wait(1000);
        a.put((s) => (s.phase === "resolved" ? {} : { clock: s.clock + 1 }));
      }
    } catch {
      // the scene stopped
    }
  })();
  void ticking;

  await a.wait(900);
  await a.type("input", GET, { interval: 42 });
  await a.wait(350);
  await a.set({ input: "", ran: 1 });
  await a.wait(1900); // read it: the database can't start
  await a.type("input", FIX, { interval: 24 });
  await a.wait(350);
  await a.set({ input: "", ran: 2 });
  await a.wait(700);
  await a.set({ phase: "recovering", err: 0 });
  await a.wait(1700);
  await a.set({ phase: "resolved" });
  await a.wait(500);
  await a.set({ debrief: true });
  await a.wait(2800);
  // A new page comes in: the old one leaves as one, the next opens on a fresh pager.
  await a.set({ shown: false });
  await a.wait(450);
  await a.snap({ ...START, shown: false });
  await a.set({ shown: true });
  await a.wait(500);
}

const TONE: Record<Phase, string> = {
  down: "border-red-200 bg-red-50",
  recovering: "border-amber-200 bg-amber-50",
  resolved: "border-green-200 bg-green-50",
};
const DOT: Record<Phase, string> = { down: "bg-red-600 cv-blink", recovering: "bg-amber-500", resolved: "bg-green-600" };
const LABEL: Record<Phase, string> = { down: "Paged", recovering: "Recovering", resolved: "Resolved" };

function Pager({ s, compact }: { s: S; compact: boolean }) {
  return (
    <div className="overflow-hidden rounded-2xl ring-1 ring-black/5 shadow-[0_24px_60px_-24px_rgb(0_0_0/0.55)]">
      <div className={`border-b px-5 pt-4 transition-colors duration-200 ${TONE[s.phase]} ${compact ? "pb-12" : "pb-11"}`}>
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 font-mono text-[12px] font-semibold uppercase tracking-[0.08em]">
            <span className={`h-2 w-2 rounded-full transition-colors duration-200 ${DOT[s.phase]}`} />
            {LABEL[s.phase]}
          </span>
          <span className="font-mono text-[22px] font-semibold tabular-nums">{clock(s.clock)}</span>
        </div>
        <div className="mt-1 text-[16px] font-medium">{s.phase === "resolved" ? "The shop is serving again." : "shop-web is returning 503s"}</div>
        <div className="mt-2.5 flex items-baseline gap-6 font-mono tabular-nums">
          <span>
            <Count value={s.err} duration={1100} format={(n) => `${Math.round(n)}%`} className={`text-[28px] font-semibold transition-colors duration-200 ${s.err >= 1 ? "text-red-700" : "text-green-700"}`} />
            <span className="ml-1 text-[11px] uppercase tracking-[0.06em] text-ink-soft">errors</span>
          </span>
          <span>
            <span className="text-[28px] font-semibold">10</span>
            <span className="ml-1 text-[11px] uppercase tracking-[0.06em] text-ink-soft">req/s</span>
          </span>
        </div>
        <div className="mt-1.5 text-[13px] text-ink-soft">{s.phase === "down" ? "100% of requests are failing." : s.phase === "recovering" ? "Healthy for 12s of 15s…" : "Healthy for 15s."}</div>
      </div>
      <Collapse open={s.debrief}>
        <div className="bg-paper px-5 pb-12 pt-4">
          <div className="font-display text-[20px]">Resolved in {clock(RESOLVED_IN)}</div>
          <p className="mt-0.5 text-[14px] text-ink-soft">2 commands, with no hints.</p>
          <div className="mt-3 flex gap-2">
            <span className="inline-flex h-9 items-center rounded-lg bg-signal px-3.5 text-[14px] font-medium text-white">Share on X</span>
            <span className="inline-flex h-9 items-center rounded-lg border border-ink/15 px-3.5 text-[14px] font-medium">Copy result</span>
          </div>
        </div>
      </Collapse>
    </div>
  );
}

function Terminal({ s }: { s: S }) {
  const prompt = <span className="select-none text-ink-soft">$ </span>;
  return (
    <div className="overflow-hidden rounded-xl border border-ink/10 bg-paper shadow-[0_0_0_1px_rgb(0_0_0/0.03),0_16px_36px_-10px_rgb(0_0_0/0.45)]">
      <div className="flex gap-4 border-b border-ink/10 px-3.5 text-[12.5px]">
        <span className="-mb-px border-b-2 border-ink py-2 font-medium">Terminal</span>
        <span className="py-2 text-ink-soft">YAML editor</span>
        <span className="py-2 text-ink-soft">Events</span>
      </div>
      <div className="space-y-px whitespace-pre px-3.5 py-2.5 font-mono text-[11.5px] leading-[18px]">
        {s.ran >= 1 && (
          <>
            <div>
              {prompt}
              {GET}
            </div>
            <div className="text-ink-soft">NAME        READY   STATUS                       RESTARTS   AGE</div>
            <div>
              shop-db-0   0/1     <span className="font-semibold text-red-700">CreateContainerConfigError</span>   0          38s
            </div>
          </>
        )}
        {s.ran >= 2 && (
          <>
            <div className="whitespace-pre-wrap break-all">
              {prompt}
              {FIX}
            </div>
            <div className="text-green-700">secret/shop-db created</div>
          </>
        )}
        <div className="whitespace-pre-wrap break-all">
          {prompt}
          {s.input}
          <span className="ml-px inline-block h-[13px] w-[7px] translate-y-[2px] bg-ink/70 cv-blink" />
        </div>
      </div>
    </div>
  );
}

export function IncidentDemo() {
  return (
    <Scene<S> width={480} height={345} compact={{ below: 470, width: 358, height: 340 }} initial={START} poster={POSTER} script={script} play="loop" className="ks-incident">
      {(s, _rect, layout) => {
        const compact = layout === "compact";
        return (
          <div className="absolute inset-x-0 top-0 transition-opacity duration-[450ms]" style={{ opacity: s.shown ? 1 : 0 }}>
            <div style={{ width: compact ? 342 : 420 }}>
              <Pager s={s} compact={compact} />
            </div>
            {/* Its work done, the terminal steps back as the pager opens its result. */}
            <div
              className="relative -mt-8 transition-[opacity,transform] duration-[450ms] ease-[cubic-bezier(0.45,0,0.1,1)]"
              style={{ marginLeft: compact ? 8 : 60, width: compact ? 350 : 420, opacity: s.debrief ? 0 : 1, transform: s.debrief ? "translateY(18px)" : "none" }}
            >
              <Terminal s={s} />
            </div>
          </div>
        );
      }}
    </Scene>
  );
}
