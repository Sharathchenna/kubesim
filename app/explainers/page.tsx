import { pageMetadata } from "@/lib/site";
import { ExplainerIndex } from "@/components/learn/Index";

export const metadata = pageMetadata({ path: "/explainers/", title: "Explainers · kubesim", description: "Animated walkthroughs of how Kubernetes behaves: self-healing, rolling updates, scaling, node failure and more." });

export default function Page() {
  return <ExplainerIndex />;
}
