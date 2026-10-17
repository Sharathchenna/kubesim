import { Sandbox } from "@/components/sim/Sandbox";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  path: "/sandbox/",
  title: "Sandbox · kubesim",
  description: "A free-play simulated Kubernetes cluster: kubectl, a YAML editor, guided scenarios and drag-and-drop, all in your browser. Share a link to a copy of your cluster.",
});

export default function Page() {
  return <Sandbox />;
}
