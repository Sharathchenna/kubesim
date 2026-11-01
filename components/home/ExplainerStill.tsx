"use client";

// A still of a narrated Explainer for the home page's "The path": the beat list from "How self-healing
// works", one beat done and the next playing, fading out at its foot over the beats still to come.

import { Check } from "../stageshow/kit";
import { Scene } from "../stageshow/Scene";
import { EXPLAINERS } from "@/lib/lessons/meta";

const EXPLAINER = EXPLAINERS.find((e) => e.id === "self-healing") ?? EXPLAINERS[0];

export function ExplainerStill() {
  const beats = EXPLAINER.beats(EXPLAINER.param?.default ?? 0).map((b) => b.title);
  return (
    <Scene width={440} height={300}>
      {() => (
        <div className="ss-fade-b absolute left-0 right-0 top-0 h-[340px] overflow-hidden rounded-2xl border border-ink/10 bg-paper shadow-[0_18px_40px_-24px_rgb(15_23_42/0.35)] [--ss-fade:110px]">
          <div className="border-b border-ink/10 px-5 py-3.5">
            <div className="font-mono text-[11.5px] uppercase tracking-[0.08em] text-ink-soft">Explainer · {beats.length} beats</div>
            <div className="mt-0.5 text-[16px] font-semibold">{EXPLAINER.title}</div>
          </div>
          <div className="px-5 py-3">
            <div className="flex items-center gap-2.5 py-1.5 text-[14px]">
              <Check on size={16} className="shrink-0" />
              <span>{beats[0]}</span>
            </div>
            <div className="-mx-2.5 rounded-lg bg-signal-soft px-2.5 py-2">
              <div className="flex items-center gap-2.5 text-[14px] font-medium">
                <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-signal font-mono text-[10px] font-semibold text-white">2</span>
                <span>{beats[1]}</span>
              </div>
              <div className="ml-[26px] mt-1 text-[13px] leading-snug text-ink-soft">We delete one Pod, as if its process was killed or someone removed it by mistake.</div>
              <div className="ml-[26px] mt-2.5 flex items-center gap-3">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink/10">
                  <div className="h-full w-[38%] rounded-full bg-signal" />
                </div>
                <span className="text-[12.5px] font-medium text-signal">Next step →</span>
              </div>
            </div>
            {beats.slice(2, 5).map((t, i) => (
              <div key={t} className="flex items-center gap-2.5 py-1.5 text-[14px] text-ink-soft">
                <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full border border-ink/20 font-mono text-[10px]">{i + 3}</span>
                <span>{t}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Scene>
  );
}
