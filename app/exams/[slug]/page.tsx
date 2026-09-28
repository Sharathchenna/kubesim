import { notFound } from "next/navigation";
import { ExamPlayer } from "@/components/learn/ExamPlayer";
import { EXAMS, examBySlug } from "@/lib/lessons/exams";

export function generateStaticParams() {
  return EXAMS.map((e) => ({ slug: e.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const e = examBySlug((await params).slug);
  return { title: e ? `${e.title} · Practice exam · kubesim` : "Practice exam · kubesim" };
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!examBySlug(slug)) notFound();
  return <ExamPlayer slug={slug} />;
}
