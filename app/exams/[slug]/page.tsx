import { pageMetadata } from "@/lib/site";
import { notFound } from "next/navigation";
import { ExamPlayer } from "@/components/learn/ExamPlayer";
import { EXAMS, examBySlug } from "@/lib/lessons/exams";

export function generateStaticParams() {
  return EXAMS.map((e) => ({ slug: e.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const e = examBySlug((await params).slug);
  const key = (await params).slug;
  return pageMetadata({ path: `/exams/${key}/`, title: e ? `${e.title} (unofficial) · kubesim` : "Practice exam · kubesim" });
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!examBySlug(slug)) notFound();
  return <ExamPlayer slug={slug} />;
}
