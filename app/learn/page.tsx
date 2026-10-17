import { pageMetadata } from "@/lib/site";
import { LessonIndex } from "@/components/learn/Index";

export const metadata = pageMetadata({ path: "/learn/", title: "Lessons · kubesim", description: "Step-by-step Kubernetes lessons on a simulated cluster: Pods, Deployments, Services, storage, networking and security, checked as you go." });

export default function Page() {
  return <LessonIndex />;
}
