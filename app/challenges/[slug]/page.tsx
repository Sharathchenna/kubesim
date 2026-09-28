import { notFound } from "next/navigation";
import { ChallengePlayer } from "@/components/learn/ChallengePlayer";
import { CHALLENGES, challengeBySlug } from "@/lib/lessons/challenges";

export function generateStaticParams() {
  return CHALLENGES.map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const c = challengeBySlug((await params).slug);
  return { title: c ? `${c.title} · Challenge · kubesim` : "Challenge · kubesim" };
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!challengeBySlug(slug)) notFound();
  return <ChallengePlayer slug={slug} />;
}
