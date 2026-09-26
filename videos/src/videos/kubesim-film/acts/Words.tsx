/** Punchlines between scenes: nothing else on screen, one word per beat. */
import { Punchlines, type Card } from "../../../kit/punchlines";
import { b } from "../cues";
import { C, SANS } from "../tokens";

const w = (text: string, at: number, accent = false) => ({ text, at, accent });

const CARDS: Card[] = [
  { lines: [[w("Kubernetes,", b(3, 1))], [w("you", b(3, 2)), w("can", b(3, 3)), w("see.", b(3, 4), true)]], out: b(4) - 0.1, y: 540, size: 150 },
  { lines: [[w("Kill", b(6, 1)), w("a", b(6, 2)), w("Pod.", b(6, 3), true)]], out: b(7) - 0.1, y: 540, size: 160 },
  { lines: [[w("It", b(10, 1)), w("heals", b(10, 2)), w("itself.", b(10, 3), true)]], out: b(11) - 0.1, y: 540, size: 150 },
  { lines: [[w("One", b(13, 1)), w("line.", b(13, 2))], [w("Six", b(13, 3)), w("Pods.", b(13, 4), true)]], out: b(14) - 0.1, y: 540, size: 150 },
  { lines: [[w("Break", b(18, 1)), w("it.", b(18, 2))], [w("Watch", b(18, 3)), w("it", b(18, 3, 0.5)), w("recover.", b(18, 4), true)]], out: b(19) - 0.1, y: 540, size: 140 },
  { lines: [[w("Free.", b(21, 1)), w("No", b(21, 2)), w("sign-up.", b(21, 2, 0.5))], [w("Just", b(21, 3)), w("your", b(21, 3, 0.5)), w("browser.", b(21, 4), true)]], out: b(22) - 0.1, y: 540, size: 130 },
];

export function Words({ t }: { t: number }) {
  return (
    <div style={{ position: "absolute", inset: 0, letterSpacing: "-0.03em" }}>
      <Punchlines t={t} cards={CARDS} theme={{ font: SANS, color: C.ink, accent: C.accent, weight: 600 }} />
    </div>
  );
}
