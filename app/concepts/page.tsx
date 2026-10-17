import { pageMetadata } from "@/lib/site";
import { ConceptIndex } from "@/components/learn/Concepts";

export const metadata = pageMetadata({ path: "/concepts/", title: "Concepts · kubesim", description: "Step-through illustrations of the core Kubernetes concepts." });

export default function Page() {
  return <ConceptIndex />;
}
