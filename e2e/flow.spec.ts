// Whole-app flow: crawl every page, finish every Lesson and Challenge through
// the UI, drive the Sandbox terminal/editor, and check basic UX quality
// (console errors, broken links, horizontal overflow, load time).

import { expect, test, type Page } from "@playwright/test";
import { run, setSpeed } from "./helpers";

const LESSONS = ["first-pod", "replicasets-self-healing", "deployments-scaling", "rolling-updates", "services", "declarative-yaml", "namespaces", "configmaps-and-secrets", "health-checks", "resources-and-limits", "jobs-and-cronjobs", "scheduling", "statefulsets", "persistent-storage", "ingress", "network-policies", "autoscaling", "rbac", "troubleshooting"];
const CHALLENGES = ["typo-image", "service-selector", "missing-configmap", "postgres-password", "readiness-wrong-port", "oversized-request", "wrong-storageclass", "forbidden-sa", "egress-dns", "after-maintenance"];
const EXPLAINERS = ["autoscaling", "crashloop", "ingress-routing", "network-policy", "node-failure", "readiness-vs-liveness", "rolling-update", "scaling", "self-healing", "service-load-balancing", "statefulset-ordering"];

/** Collects page errors and console errors (ignoring favicon noise). */
function watch(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

const term = (page: Page) => page.getByRole("log", { name: "Terminal output" });

// ------------------------------------------------------------------ crawl

test("crawl: every internal link resolves, pages render without errors", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watch(page);
  const seen = new Set<string>();
  const queue = ["/"];
  const broken: string[] = [];
  const slow: string[] = [];
  const noH1: string[] = [];
  const overflow: string[] = [];
  while (queue.length) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const t0 = Date.now();
    const res = await page.goto(path);
    if (!res || res.status() >= 400) {
      broken.push(`${path} → ${res?.status()}`);
      continue;
    }
    await page.waitForLoadState("networkidle");
    const ms = Date.now() - t0;
    // Generous on CI runners: this catches pages that hang, not small regressions.
    if (ms > (process.env.CI ? 10_000 : 5000)) slow.push(`${path} ${ms}ms`);
    if ((await page.locator("h1").count()) === 0) noH1.push(path);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (wide > 1) overflow.push(`${path} +${wide}px`);
    const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")!));
    for (const h of hrefs) {
      if (!h.startsWith("/") || h.startsWith("//")) continue;
      const clean = h.split("#")[0].split("?")[0] || "/";
      if (!seen.has(clean)) queue.push(clean);
    }
  }
  test.info().annotations.push({ type: "pages", description: String(seen.size) });
  expect(broken, "broken links").toEqual([]);
  expect(noH1, "pages without an h1").toEqual([]);
  expect(overflow, "horizontal overflow").toEqual([]);
  expect(slow, "slow pages").toEqual([]);
  expect(errors, "console/page errors").toEqual([]);
  expect(seen.size).toBeGreaterThan(40);
});

test("unknown URLs show a helpful 404 with a way home", async ({ page }) => {
  const res = await page.goto("/does-not-exist/");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("link", { name: /home|lessons|back/i }).first()).toBeVisible();
});

// ------------------------------------------------------------------ lessons

for (const slug of LESSONS) {
  test(`lesson ${slug}: completes end-to-end with Show me`, async ({ page }) => {
    test.setTimeout(180_000);
    const errors = watch(page);
    await page.goto(`/learn/${slug}/`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const counter = page.locator("aside span.font-mono").filter({ hasText: /^\d+\/\d+$/ }).first();
    const total = Number((await counter.innerText()).split("/")[1]);
    for (let guard = 0; guard < total * 2; guard++) {
      const done = Number((await counter.innerText()).split("/")[0]);
      if (done >= total) break;
      await page.getByRole("button", { name: "Show me" }).click();
      const skip = page.getByRole("button", { name: /Skip ahead/ });
      await expect(async () => {
        if (await skip.isVisible()) await skip.click({ timeout: 1000 }).catch(() => {});
        expect(Number((await counter.innerText()).split("/")[0])).toBeGreaterThan(done);
      }, `step ${done + 1} of ${slug} never passed after Show me`).toPass({ timeout: 60_000 });
    }
    await expect(page.getByText("Lesson complete")).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("lesson progress survives a reload and shows the welcome-back note", async ({ page }) => {
  await page.goto("/learn/first-pod/");
  await run(page, "kubectl get nodes");
  await expect(page.getByText("1/5", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("1/5", { exact: true })).toBeVisible();
  await expect(page.getByText(/Welcome back/)).toBeVisible();
});

test("lesson Hint toggles and Start over resets progress", async ({ page }) => {
  await page.goto("/learn/first-pod/");
  await run(page, "kubectl get nodes");
  await expect(page.getByText("1/5", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hint" }).click();
  await expect(page.locator("p.bg-amber-50")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Start over" }).click();
  await expect(page.getByText("0/5", { exact: true })).toBeVisible();
});

// ------------------------------------------------------------------ challenges

for (const slug of CHALLENGES) {
  test(`challenge ${slug}: solves by running the revealed fix`, async ({ page }) => {
    test.setTimeout(180_000);
    const errors = watch(page);
    await page.goto(`/challenges/${slug}/`);
    const goals = page.getByRole("list", { name: "Goals" }).getByRole("listitem");
    const n = await goals.count();
    for (let i = 0; i < n; i++) {
      const g = goals.nth(i);
      if ((await g.getByLabel("Done", { exact: true }).count()) > 0) continue;
      await g.getByRole("button", { name: "Show the fix" }).click();
      const runs = g.getByRole("button", { name: "Run", exact: true });
      for (let r = 0; r < (await runs.count()); r++) await runs.nth(r).click();
      const edit = g.getByRole("button", { name: "Open in editor" });
      if (await edit.count()) {
        await edit.first().click();
        await page.getByRole("button", { name: "Apply" }).click();
      }
    }
    await setSpeed(page, "30×");
    await expect(page.getByRole("status").filter({ hasText: "Challenge solved" })).toBeVisible({ timeout: 90_000 });
    expect(errors).toEqual([]);
  });
}

// ------------------------------------------------------------------ explainers

for (const id of EXPLAINERS) {
  test(`explainer ${id}: plays through without errors`, async ({ page }) => {
    const errors = watch(page);
    await page.goto(`/explainers/${id}/`);
    await expect(page.locator("svg[aria-label='Cluster diagram']")).toBeVisible();
    await setSpeed(page, "30×");
    // Let it play for a while of simulated time (the clock passes 00:30).
    await expect.poll(async () => (await page.getByTitle("Simulated time").innerText()).trim(), { timeout: 20_000 }).toMatch(/^(0[1-9]|[1-9]\d+):|^00:[3-5]\d/);
    expect(errors).toEqual([]);
  });
}

// ------------------------------------------------------------------ sandbox

test("sandbox terminal: history, tab completion, errors, watch + Ctrl+C, clear", async ({ page }) => {
  const errors = watch(page);
  await page.goto("/sandbox/");
  const input = page.getByRole("textbox", { name: "Terminal input" });

  await run(page, "kubectl create deployment web --image=nginx --replicas=3");
  await expect(term(page)).toContainText("deployment.apps/web created");

  // History recall.
  await input.press("ArrowUp");
  await expect(input).toHaveValue("kubectl create deployment web --image=nginx --replicas=3");
  await input.fill("");

  // Tab completion of a resource name.
  await input.fill("kubectl get deployment w");
  await input.press("Tab");
  await expect(input).toHaveValue("kubectl get deployment web ");
  await input.fill("");

  // Errors are shown, not swallowed.
  await run(page, "kubectl get pods --bogus");
  await expect(term(page)).toContainText("unknown flag: --bogus");
  await run(page, "kubctl get pods");
  await expect(term(page)).toContainText(/not found|unknown|did you mean/i);

  // Streaming command stops with Ctrl+C.
  await run(page, "kubectl get pods -w");
  await input.press("Control+c");
  await expect(term(page)).toContainText("^C");

  // Scale reflects in the cluster.
  await run(page, "kubectl scale deploy web --replicas=5");
  await setSpeed(page, "30×");
  await expect(async () => {
    await run(page, "kubectl get deploy web --no-headers");
    await expect(term(page)).toContainText(/web\s+5\/5/);
  }).toPass({ timeout: 30_000 });

  // clear empties the scrollback.
  await run(page, "clear").catch(() => {});
  await expect(term(page)).not.toContainText("deployment.apps/web created");
  expect(errors).toEqual([]);
});

test("sandbox editor: Apply a manifest creates the objects", async ({ page }) => {
  const errors = watch(page);
  await page.goto("/sandbox/");
  await page.getByRole("button", { name: "YAML editor", exact: true }).click();
  await page.getByRole("button", { name: /kubectl apply -f/ }).click();
  // The editor shows the apply result next to the button.
  await expect(page.locator("pre").filter({ hasText: /deployment\.apps\/web (created|configured|unchanged)/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("sandbox autosaves across reloads; Start over wipes it", async ({ page }) => {
  await page.goto("/sandbox/");
  await run(page, "kubectl create deployment keepme --image=nginx");
  // No waiting for the 5 s autosave: leaving the page saves.
  await page.reload();
  await run(page, "kubectl get deploy");
  await expect(term(page)).toContainText("keepme");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Start over" }).click();
  await run(page, "kubectl get deploy");
  await expect(term(page)).not.toContainText("keepme");
});

test("sandbox pause freezes simulated time; resume continues", async ({ page }) => {
  await page.goto("/sandbox/");
  const clock = page.getByTitle("Simulated time");
  await page.getByRole("button", { name: "Pause simulation" }).click();
  const a = await clock.innerText();
  // Proving "nothing changes" needs some wall time: 1.5 s is three clock seconds at 1×.
  await page.waitForTimeout(1500);
  expect(await clock.innerText()).toBe(a);
  await page.getByRole("button", { name: "Resume simulation" }).click();
  await expect.poll(() => clock.innerText(), { timeout: 5000 }).not.toBe(a);
});

test("sandbox: a corrupted autosave doesn't break the page", async ({ page }) => {
  const errors = watch(page);
  // The real keys: a broken autosave, and one that parses but isn't a cluster.
  await page.addInitScript(() => localStorage.setItem("kubesim.sandbox.v1", "{not json"));
  await page.goto("/sandbox/");
  await run(page, "kubectl get nodes");
  await expect(term(page)).toContainText("control-plane");
  await page.addInitScript(() => localStorage.setItem("kubesim.sandbox.v1", JSON.stringify({ objects: { x: 1 }, now: "soon" })));
  await page.reload();
  await run(page, "kubectl get nodes");
  await expect(term(page)).toContainText("control-plane");
  expect(errors.filter((e) => e.startsWith("pageerror"))).toEqual([]);
});

test("a damaged share link shows a message instead of crashing", async ({ page }) => {
  const errors = watch(page);
  await page.goto("/sandbox/#cluster=1.AAAAgarbage");
  await expect(page.getByRole("status").filter({ hasText: /damaged|doesn't|different version/ })).toBeVisible();
  expect(errors.filter((e) => e.startsWith("pageerror"))).toEqual([]);
});

test("a share link with broken percent-encoding shows a friendly message", async ({ page }) => {
  const errors = watch(page);
  await page.goto("/sandbox/#cluster=%E0%A4%A");
  await expect(page.getByRole("status").filter({ hasText: /Couldn't open that link/ })).toBeVisible();
  await run(page, "kubectl get nodes");
  await expect(term(page)).toContainText("control-plane");
  expect(errors.filter((e) => e.startsWith("pageerror"))).toEqual([]);
});

/** Makes a share link for a cluster that holds one Deployment called `name`. */
async function linkWith(page: Page, name: string): Promise<string> {
  await page.goto("/sandbox/");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Start over" }).click();
  await run(page, `kubectl create deployment ${name} --image=nginx`);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Link copied" })).toBeVisible();
  return page.evaluate(() => navigator.clipboard.readText());
}

test("opening a share link keeps the visitor's own cluster and can restore it", async ({ page, context }) => {
  const url = await linkWith(page, "theirs");
  // A different visitor with their own saved cluster.
  const other = await context.newPage();
  await other.goto("/sandbox/");
  other.once("dialog", (d) => d.accept());
  await other.getByRole("button", { name: "Start over" }).click();
  await run(other, "kubectl create deployment mine --image=nginx");
  await other.reload(); // saved on the way out
  await other.goto(url);
  await expect(other.getByRole("status").filter({ hasText: "Loaded the shared cluster" })).toBeVisible();
  await run(other, "kubectl get deploy");
  await expect(term(other)).toContainText("theirs");
  await other.getByRole("button", { name: "Restore my cluster" }).click();
  await expect(other.getByRole("status").filter({ hasText: "Restored your cluster" })).toBeVisible();
  await run(other, "kubectl get deploy");
  await expect(term(other).locator("pre").last()).toContainText("mine");
  await expect(term(other).locator("pre").last()).not.toContainText("theirs");
  // And it stays restored after a reload.
  await other.reload();
  await run(other, "kubectl get deploy");
  await expect(term(other).locator("pre").last()).toContainText("mine");
});

test("a share link opened on the Sandbox page itself (hash change) loads", async ({ page }) => {
  const url = await linkWith(page, "hashy");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Start over" }).click();
  await page.evaluate((u) => (window.location.hash = new URL(u).hash), url);
  await expect(page.getByRole("status").filter({ hasText: "Loaded the shared cluster" })).toBeVisible();
  await run(page, "kubectl get deploy");
  await expect(term(page).locator("pre").last()).toContainText("hashy");
});

test("terminal: scrolling back through output stays put while the cluster runs", async ({ page }) => {
  await page.goto("/sandbox/");
  for (let i = 0; i < 6; i++) await run(page, "kubectl get pods -A");
  const log = term(page);
  await log.evaluate((el) => (el.scrollTop = 0));
  await setSpeed(page, "30×");
  // Many frames and cluster changes later, the Learner is still reading the top.
  await expect.poll(async () => (await page.getByTitle("Simulated time").innerText()).trim(), { timeout: 10_000 }).not.toBe("00:00");
  const clock = page.getByTitle("Simulated time");
  const t1 = await clock.innerText();
  await expect.poll(() => clock.innerText()).not.toBe(t1);
  expect(await log.evaluate((el) => el.scrollTop)).toBe(0);
  // Running a command brings the prompt back to the bottom.
  await run(page, "kubectl get nodes");
  expect(await log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(30);
});

// ------------------------------------------------------------------ exams & progress

test("exam: submitting grades the attempt and Progress reflects it", async ({ page }) => {
  await page.goto("/exams/ckad-practice/");
  await page.getByRole("button", { name: /^Start the/ }).click();
  await expect(page.getByRole("timer")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Submit exam" }).click();
  await expect(page.getByRole("status").filter({ hasText: /You scored \d+%/ })).toBeVisible();
  // Submitting without answering is a fail: the Progress page still counts 0/2 passed.
  await page.goto("/progress/");
  await expect(page.getByRole("main")).toContainText(/Practice exams\s*0\/2/);
});

test("progress page survives corrupted storage", async ({ page }) => {
  const errors = watch(page);
  // The real keys, holding garbage or the wrong shapes.
  await page.addInitScript(() => {
    localStorage.setItem("kubesim.progress.v1", JSON.stringify({ "first-pod": "half", "exam:ckad-practice": { done: "x" }, services: null }));
    localStorage.setItem("kubesim.lesson.first-pod.v1", "{");
    localStorage.setItem("kubesim.exam.ckad-practice.results.v1", JSON.stringify([{ score: "lots" }, null, 7]));
    localStorage.setItem("kubesim.exam.cka-practice.results.v1", "[");
  });
  for (const p of ["/progress/", "/learn/", "/challenges/", "/exams/", "/exams/ckad-practice/", "/learn/first-pod/"]) {
    await page.goto(p);
    await expect(page.locator("h1")).toBeVisible();
  }
  expect(errors.filter((e) => e.startsWith("pageerror"))).toEqual([]);
});

// ------------------------------------------------------------------ keyboard

test("keyboard: skip to content / focus is visible on the first tab stop", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const s = getComputedStyle(el);
    return { tag: el.tagName, text: el.innerText.slice(0, 40), outline: s.outlineStyle !== "none" || s.boxShadow !== "none" };
  });
  expect(outline.outline, `focused ${outline.tag} "${outline.text}" has no visible focus ring`).toBe(true);
});
