import { pageMetadata } from "@/lib/site";
import { notFound } from "next/navigation";
import { ExplainerPlayer } from "@/components/learn/ExplainerPlayer";
import { EXPLAINERS, explainerById } from "@/lib/explainers/explainers";

export function generateStaticParams() {
  return EXPLAINERS.map((e) => ({ id: e.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const e = explainerById((await params).id);
  const key = (await params).id;
  return pageMetadata({ path: `/explainers/${key}/`, title: e ? `${e.title} · kubesim` : "Explainer · kubesim" });
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!explainerById(id)) notFound();
  return <ExplainerPlayer id={id} />;
}
