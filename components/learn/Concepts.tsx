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
      <div className="bg-field">
        <AppHeader glass />
        <header className="mx-auto max-w-4xl px-6 pb-12 pt-16">
          <div className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-slate-500">Concepts</div>
          <h1 className="font-display text-balance mt-3 text-[46px] leading-[1.02] text-slate-900 sm:text-[56px]">The ideas behind the cluster</h1>
          <p className="text-pretty mt-4 max-w-2xl text-[16px] leading-relaxed text-slate-600">Illustrated walk-throughs of how Kubernetes is put together. Step through each one, then try it for real in the lesson it belongs to.</p>
        </header>
      </div>
      <main className="mx-auto max-w-4xl px-6 pb-24 pt-4">
        <div className="flex flex-col gap-10">
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
