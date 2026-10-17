/** Challenge difficulty badges. Kept out of ChallengePlayer so index pages don't pull in the simulator. */
export const DIFFICULTY: Record<string, { label: string; cls: string }> = {
  easy: { label: "Easy", cls: "bg-green-50 text-green-700 border-green-200" },
  medium: { label: "Medium", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  hard: { label: "Hard", cls: "bg-red-50 text-red-700 border-red-200" },
};
