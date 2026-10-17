import { pageMetadata } from "@/lib/site";
import { ExamIndex } from "@/components/learn/Index";

export const metadata = pageMetadata({ path: "/exams/", title: "Practice exams · kubesim", description: "Unofficial timed practice exams in the style of the CKAD and CKA, graded from the state of a simulated cluster." });

export default function Page() {
  return <ExamIndex />;
}
