// The order to take Lessons in: track by track (TRACKS order), then as listed.

import { LESSONS, TRACKS, trackOf, type Lesson } from "./lessons";

export const CURRICULUM: Lesson[] = TRACKS.flatMap((t) => LESSONS.filter((l) => trackOf(l) === t.id));

export const curriculumIndex = (slug: string) => CURRICULUM.findIndex((l) => l.slug === slug);
