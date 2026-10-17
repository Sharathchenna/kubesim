import type { MetadataRoute } from "next";
import { CHALLENGES } from "@/lib/lessons/challenges";
import { EXAMS } from "@/lib/lessons/exams";
import { LESSONS } from "@/lib/lessons/lessons";
import { EXPLAINERS } from "@/lib/explainers/explainers";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";

/** Every page of the static export (with the trailing slash the export uses). The Progress page is private to each browser and left out. */
export default function sitemap(): MetadataRoute.Sitemap {
  const paths = [
    "/",
    "/learn/",
    "/challenges/",
    "/exams/",
    "/explainers/",
    "/concepts/",
    "/sandbox/",
    ...LESSONS.map((l) => `/learn/${l.slug}/`),
    ...CHALLENGES.map((c) => `/challenges/${c.slug}/`),
    ...EXAMS.map((e) => `/exams/${e.slug}/`),
    ...EXPLAINERS.map((e) => `/explainers/${e.id}/`),
  ];
  return paths.map((p) => ({ url: `${SITE_URL}${p}`, changeFrequency: "monthly", priority: p === "/" ? 1 : p.split("/").length > 3 ? 0.6 : 0.8 }));
}
