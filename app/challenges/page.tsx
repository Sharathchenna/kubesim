import { pageMetadata } from "@/lib/site";
import { ChallengeIndex } from "@/components/learn/Index";

export const metadata = pageMetadata({ path: "/challenges/", title: "Challenges · kubesim", description: "Broken Kubernetes clusters to troubleshoot with kubectl: no steps, just a symptom to fix." });

export default function Page() {
  return <ChallengeIndex />;
}
