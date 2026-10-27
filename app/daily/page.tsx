import { pageMetadata } from "@/lib/site";
import { DailyIncident } from "@/components/learn/DailyIncident";

export const metadata = pageMetadata({ path: "/daily/", title: "Daily Incident · kubesim", description: "One Kubernetes outage a day, the same for everyone. Get the shop serving again, share your time, keep your streak." });

export default function Page() {
  return <DailyIncident />;
}
