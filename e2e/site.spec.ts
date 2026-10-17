import { expect, test } from "@playwright/test";
import { run, setSpeed, watchErrors } from "./helpers";

test("home page links to every way to learn", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Learn Kubernetes");
  for (const name of ["Lessons", "Challenges", "Exams", "Explainers", "Sandbox", "Progress"]) {
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("the first lesson ticks off a step from the terminal", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/learn/first-pod/");
  await run(page, "kubectl get nodes");
  await expect(page.getByRole("log", { name: "Terminal output" })).toContainText("control-plane");
  await expect(page.getByText("1/5", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the curriculum map groups lessons by track", async ({ page }) => {
  await page.goto("/learn/");
  const map = page.getByRole("navigation", { name: "Curriculum map" });
  for (const t of ["Foundations", "Workloads", "Configuration", "Networking", "Storage", "Operations", "Security"]) await expect(map.getByText(t)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Networking", exact: true })).toBeVisible();
});

test("a lesson's progress shows on the progress page", async ({ page }) => {
  await page.goto("/learn/first-pod/");
  await run(page, "kubectl get nodes");
  await expect(page.getByText("1/5", { exact: true })).toBeVisible();
  await page.goto("/progress/");
  await expect(page.getByRole("link", { name: /^Your first Pod \(started\)/ })).toContainText("1/5");
});

test("sandbox: the Ingress scenario routes by path", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/sandbox/");
  await page.getByRole("button", { name: /Ingress routing/ }).click();
  await setSpeed(page, "30×");
  const log = page.getByRole("log", { name: "Terminal output" });
  await expect(log).toContainText("curl http://localhost/apple", { timeout: 30_000 });
  await expect(log).toContainText("banana");
  await expect(log).toContainText("404 Not Found");
  expect(errors).toEqual([]);
});

test("sandbox: a shared link opens a copy of the cluster", async ({ page, context }) => {
  await page.goto("/sandbox/");
  await run(page, "kubectl create deployment shared-web --image=nginx --replicas=2");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Link copied" })).toBeVisible();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toContain("#cluster=1.");
  const other = await context.newPage();
  await other.addInitScript(() => localStorage.clear());
  await other.goto(url);
  await expect(other.getByRole("status").filter({ hasText: "Loaded the shared cluster" })).toBeVisible();
  await run(other, "kubectl get deploy");
  await expect(other.getByRole("log", { name: "Terminal output" })).toContainText("shared-web");
});

test("the Cluster View has a text alternative and keyboard access", async ({ page }) => {
  await page.goto("/sandbox/");
  await run(page, "kubectl run solo --image=nginx");
  await page.getByRole("button", { name: "Text view" }).click();
  await expect(page.getByRole("heading", { name: /Nodes \(3\)/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^solo: / })).toBeVisible();
  await page.getByRole("button", { name: /^solo: / }).click();
  await expect(page.getByText("Pod", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Diagram view" }).click();
  const pod = page.getByRole("button", { name: /^Pod solo,/ });
  await pod.focus();
  await page.keyboard.press("Enter");
  await expect(pod).toHaveAttribute("aria-pressed", "true");
});

test("a challenge hides the fix until asked", async ({ page }) => {
  await page.goto("/challenges/");
  const first = page.getByRole("main").locator("a[href^='/challenges/']").first();
  await first.click();
  await expect(page.getByText("The situation")).toBeVisible();
  const goal = page.getByRole("list", { name: "Goals" }).getByRole("listitem").first();
  await expect(goal.getByText("One way to fix it")).toHaveCount(0);
  await goal.getByRole("button", { name: "Show the fix" }).click();
  await expect(goal.getByText("One way to fix it")).toBeVisible();
});

// The practice exam flow is covered in flow.spec.ts ("exam: submitting grades the attempt…").

test("explainers play", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/explainers/");
  await page.getByRole("main").locator("a[href^='/explainers/']").first().click();
  await expect(page.locator("svg[aria-label='Cluster diagram']")).toBeVisible();
  expect(errors).toEqual([]);
});
