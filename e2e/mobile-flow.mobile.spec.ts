import { expect, test } from "@playwright/test";

const PAGES = ["/", "/learn/", "/challenges/", "/exams/", "/explainers/", "/concepts/", "/progress/", "/sandbox/", "/learn/first-pod/", "/challenges/typo-image/", "/exams/cka-practice/", "/explainers/scaling/"];

/** WCAG 2.2 target size (minimum): 24×24 CSS px, with its spacing and inline-link exceptions. */
const MIN = 24;

for (const p of PAGES) {
  test(`mobile ${p}: no horizontal overflow, tap targets usable`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(p);
    await expect(page.locator("h1").first()).toBeAttached();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(wide, "horizontal overflow px").toBeLessThanOrEqual(1);
    const tiny = await page.$$eval(
      "a:visible, button:visible, [role=button]:visible, input:visible, select:visible",
      (els, min) => {
        const targets = els
          .filter((e) => {
            // Visually hidden (a skip link until focused).
            const r = e.getBoundingClientRect();
            if (r.width <= 1 || r.height <= 1) return false;
            // Inline links in running text are exempt.
            if (e.tagName === "A" && getComputedStyle(e).display === "inline" && e.parentElement?.tagName === "P") return false;
            // SVG objects on the canvas zoom with it; they're not fixed-size controls.
            if (e.closest("svg")) return false;
            return true;
          })
          .map((e) => {
            const r = e.getBoundingClientRect();
            return { t: (e as HTMLElement).innerText?.trim().slice(0, 30) || e.getAttribute("aria-label") || e.tagName, h: Math.round(r.height), w: Math.round(r.width), cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
          });
        // WCAG spacing exception: an undersized target is fine if a 24 px circle on its centre clears every other target's centre.
        return targets
          .filter((r) => r.h < min || r.w < min)
          .filter((r) => targets.some((o) => o !== r && Math.hypot(o.cx - r.cx, o.cy - r.cy) < min))
          .map(({ t, h, w }) => ({ t, h, w }));
      },
      MIN,
    );
    expect(tiny, "tap targets smaller than 24×24").toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("mobile Sandbox: fit-to-screen shows every Node", async ({ page }) => {
  await page.goto("/sandbox/");
  await expect(page.locator("svg[aria-label='Cluster diagram'] [data-kind='node']").first()).toBeVisible();
  await expect.poll(async () => page.locator("[data-kind='node'], [data-kind='cp']").count()).toBeGreaterThanOrEqual(3);
  // Let the fit animation settle, then every Node box must be inside the canvas.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const canvas = document.querySelector("[aria-label^='Cluster View']")!.getBoundingClientRect();
        return [...document.querySelectorAll("[data-kind='node'], [data-kind='cp']")].every((n) => {
          const r = n.getBoundingClientRect();
          return r.left >= canvas.left - 1 && r.right <= canvas.right + 1 && r.top >= canvas.top - 1 && r.bottom <= canvas.bottom + 1;
        });
      }),
    )
    .toBe(true);
});
