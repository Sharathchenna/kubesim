import { pageMetadata } from "@/lib/site";
import { IncidentIndex } from "@/components/learn/Index";

export const metadata = pageMetadata({ path: "/incidents/", title: "Incidents · kubesim", description: "Production outages in a simulated Kubernetes cluster, with real traffic and a clock. Find the cause with kubectl and get the shop serving again." });

export default function Page() {
  return <IncidentIndex />;
}
