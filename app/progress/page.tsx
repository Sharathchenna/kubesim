import { pageMetadata } from "@/lib/site";
import { ProgressPage } from "@/components/learn/Index";

export const metadata = pageMetadata({ path: "/progress/", title: "Your progress · kubesim", noindex: true });

export default function Page() {
  return <ProgressPage />;
}
