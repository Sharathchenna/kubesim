"use client";

import Link from "next/link";
import { AppHeader } from "../AppHeader";
import { Illustration } from "../illustrations/Illustration";
import { SCENES } from "../illustrations/scenes";

const WHERE: Record<string, { href: string; label: string }> = {
  architecture: { href: "/learn/first-pod", label: "Your first Pod" },
  apply: { href: "/learn/declarative-yaml", label: "Declarative YAML" },
  service: { href: "/learn/services", label: "Services & networking" },
};

export function ConceptIndex() {
  return (
    <div className="min-h-screen bg-[#f7f8fa]">
      <AppHeader />
      <main className="mx-auto max-w-4xl px-6 pb-24 pt-14">
        <div className="text-[12px] font-semibold uppercase tracking-[0.1em] text-slate-400">Concepts</div>
        <h1 className="mt-2 text-[34px] font-semibold tracking-tight text-slate-900">The ideas behind the cluster</h1>
        <p className="mt-3 max-w-2xl text-[15.5px] leading-relaxed text-slate-500">Illustrated walk-throughs of how Kubernetes is put together. Step through each one, then try it for real in the lesson it belongs to.</p>
        <div className="mt-10 flex flex-col gap-10">
          {Object.values(SCENES).map((s) => (
            <section key={s.id}>
              <Illustration scene={s} />
              {WHERE[s.id] && (
                <Link href={WHERE[s.id].href} className="mt-3 inline-block text-[13px] font-medium text-slate-700 hover:text-slate-900">
                  Try it in “{WHERE[s.id].label}” →
                </Link>
              )}
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
