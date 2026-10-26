import { chromium, devices } from "playwright";
const b = await chromium.launch();
const dir = new URL(".", import.meta.url).pathname;
const pages = [["sandbox","/sandbox"],["lesson","/learn/first-pod"],["challenge","/challenges/typo-image"],["exam","/exams/ckad-practice"],["explainer","/explainers/scaling"],["home","/"]];
for (const [n,u] of pages) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("http://localhost:4173"+u); await p.waitForTimeout(3000);
  await p.screenshot({ path: `${dir}after-${n}.png` });
  await p.close();
}
const m = await b.newContext({ ...devices["Pixel 7"] });
for (const [n,u] of [["lesson","/learn/first-pod"],["sandbox","/sandbox"]]) {
  const mp = await m.newPage(); await mp.goto("http://localhost:4173"+u); await mp.waitForTimeout(2500);
  await mp.screenshot({ path: `${dir}after-${n}-phone.png` }); await mp.close();
}
await b.close();
