import { pageMetadata } from "@/lib/site";
import { notFound } from "next/navigation";
import { IncidentPlayer } from "@/components/learn/IncidentPlayer";
import { INCIDENTS, incidentBySlug } from "@/lib/sim/incidents";

export function generateStaticParams() {
  return INCIDENTS.map((i) => ({ slug: i.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const i = incidentBySlug(slug);
  return pageMetadata({ path: `/incidents/${slug}/`, title: i ? `${i.title} · Incident · kubesim` : "Incident · kubesim", description: i ? `${i.page}. ${i.brief}` : undefined });
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!incidentBySlug(slug)) notFound();
  return <IncidentPlayer slug={slug} />;
}
