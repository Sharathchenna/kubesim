import { chromium } from "playwright";
const b = await chromium.launch();
const dir = new URL(".", import.meta.url).pathname;
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("http://localhost:4173/sandbox"); await p.waitForTimeout(1500);
await p.getByRole("button", { name: /Self-healing/ }).click(); await p.waitForTimeout(9000);
await p.locator("[data-kind='pod']").first().click(); await p.waitForTimeout(800);
await p.screenshot({ path: `${dir}after-sandbox-running.png` });
await b.close();
