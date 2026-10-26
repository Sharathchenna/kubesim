import { chromium, devices } from "playwright";
const b = await chromium.launch();
const pages = [["sandbox","/sandbox"],["lesson","/learn/first-pod"],["challenge","/challenges/typo-image"],["exam","/exams/ckad-practice"],["explainer", process.argv[2]]];
const dir = new URL(".", import.meta.url).pathname;
for (const [n,u] of pages) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("http://localhost:4173"+u); await p.waitForTimeout(2500);
  await p.screenshot({ path: `${dir}before-${n}.png` });
  await p.close();
}
const m = await b.newContext({ ...devices["Pixel 7"] });
const mp = await m.newPage(); await mp.goto("http://localhost:4173/learn/first-pod"); await mp.waitForTimeout(2000);
await mp.screenshot({ path: `${dir}before-lesson-phone.png` });
await b.close();
