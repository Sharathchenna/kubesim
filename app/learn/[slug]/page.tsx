import { pageMetadata } from "@/lib/site";
import { notFound } from "next/navigation";
import { LessonPlayer } from "@/components/learn/LessonPlayer";
import { LESSONS, lessonBySlug } from "@/lib/lessons/lessons";

export function generateStaticParams() {
  return LESSONS.map((l) => ({ slug: l.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const l = lessonBySlug((await params).slug);
  const key = (await params).slug;
  return pageMetadata({ path: `/learn/${key}/`, title: l ? `${l.title} · kubesim` : "Lesson · kubesim" });
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!lessonBySlug(slug)) notFound();
  return <LessonPlayer slug={slug} />;
}
