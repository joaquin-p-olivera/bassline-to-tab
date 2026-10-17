// End-to-end: the real page, the real WebAssembly build, a synthetic riff.
// Separation is turned off (CI has no GPU); it is covered by manual tests.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, test } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const riffPath = path.join(here, "riff.wav");

test.beforeAll(() => {
  execFileSync("python3", [path.join(here, "make_riff.py"), riffPath], { stdio: "inherit" });
});

test("transcribes an isolated bass riff into tab", async ({ page }) => {
  const logs = [];
  page.on("console", (message) => logs.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}`));

  await page.goto("./");
  await page.locator("#separate").uncheck();
  await page.locator("#audio").setInputFiles(riffPath);
  await page.locator("#submit").click();

  try {
    await expect(page.locator("#result")).toBeVisible({ timeout: 150_000 });
  } finally {
    console.log(logs.join("\n"));
  }

  await expect(page.locator("#error")).toBeHidden();
  const summary = await page.locator("#summary").innerText();
  expect(summary).toContain("48");
  expect(summary).toMatch(/100\.\d BPM/);

  const tab = await page.locator("#tab").innerText();
  const eString = tab.split("\n").find((line) => line.startsWith("E|"));
  expect(eString.startsWith("E|0-------0---3---")).toBe(true);
  console.log(await page.locator("#timings").innerText());
});
