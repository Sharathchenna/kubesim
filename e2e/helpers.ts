import { expect, type Page } from "@playwright/test";

/** Types a command into the terminal and waits for its line to appear. */
export async function run(page: Page, cmd: string) {
  const input = page.getByRole("textbox", { name: "Terminal input" });
  await input.fill(cmd);
  await input.press("Enter");
  await expect(page.getByRole("log", { name: "Terminal output" })).toContainText(cmd);
}

/** Fails the test on uncaught page errors. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

/** Picks a simulation speed from the header's speed menu. */
export async function setSpeed(page: Page, speed: "1×" | "5×" | "30×" | "60×") {
  await page.getByRole("button", { name: /^Simulation speed/ }).click();
  await page.getByRole("group", { name: "Simulation speed" }).getByRole("button", { name: new RegExp(`^${speed}`) }).click();
}
