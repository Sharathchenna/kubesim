import { expect, test } from "@playwright/test";
import { run } from "./helpers";

test("on a phone, the lesson switches between steps, cluster and terminal", async ({ page }) => {
  await page.goto("/learn/first-pod/");
  const tabs = page.getByRole("navigation", { name: "Views" });
  await tabs.getByRole("button", { name: "Terminal" }).click();
  await run(page, "kubectl get nodes");
  await tabs.getByRole("button", { name: /Steps/ }).click();
  await expect(tabs.getByRole("button", { name: /Steps 1\/5/ })).toBeVisible();
});
