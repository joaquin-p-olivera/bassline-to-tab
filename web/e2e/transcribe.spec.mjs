// End-to-end: the real page, the real WebAssembly build, a synthetic riff.
// Separation is turned off (CI has no GPU); it is covered by manual tests.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, test } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const riffPath = path.join(here, "riff.wav");
const BPM = 100;
const LEAD_IN_S = 0.5;
const SIXTEENTH_S = 60 / BPM / 4;

test.beforeAll(() => {
  execFileSync("python3", [path.join(here, "make_riff.py"), riffPath], { stdio: "inherit" });
});

function collectLogs(page) {
  const logs = [];
  page.on("console", (message) => logs.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}`));
  return logs;
}

async function transcribeRiff(page, logs) {
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
}

test("transcribes an isolated bass riff into tab", async ({ page }) => {
  const logs = collectLogs(page);
  await transcribeRiff(page, logs);

  const summary = await page.locator("#summary").innerText();
  expect(summary).toContain("48");
  expect(summary).toMatch(/100\.\d BPM/);

  const tab = await page.locator("#tab-view").innerText();
  const eString = tab.split("\n").find((line) => line.startsWith("E|"));
  expect(eString.startsWith("E|0-------0---3---")).toBe(true);
  console.log(await page.locator("#timings").innerText());
});

test("switches between the two fingerings", async ({ page }) => {
  const logs = collectLogs(page);
  await transcribeRiff(page, logs);
  const eString = async () =>
    (await page.locator("#tab-view").innerText()).split("\n").find((line) => line.startsWith("E|"));
  // Open position plays A1 B1 C2 on the open A string; lower strings keeps them on E.
  const lowerStart = "E|0-------0---3---5-------7---8---";
  expect(await eString()).not.toContain(lowerStart);
  await page.locator('[data-fingering="lower-strings"]').click();
  expect((await eString()).startsWith(lowerStart)).toBe(true);
  await page.locator('[data-fingering="open-position"]').click();
  expect(await eString()).not.toContain(lowerStart);
});

test("tab fits the width at phone and desktop sizes", async ({ page }) => {
  const logs = collectLogs(page);
  await transcribeRiff(page, logs);
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(300);
    const overflow = await page.locator("#tab-view").evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);
  }
});

test("clicking a bar seeks the audio and shows the cursor", async ({ page }) => {
  const logs = collectLogs(page);
  await transcribeRiff(page, logs);
  await page.waitForFunction(() => document.getElementById("player").readyState >= 1);

  // Click the middle of the first sixteenth of bar 2 on the first tab line.
  await page.locator(".tab-line").first().evaluate((line) => {
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(100);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    line.append(probe);
    const charWidth = probe.getBoundingClientRect().width / 100;
    probe.remove();
    const firstRow = line.querySelector("pre").textContent.split("\n")[1];
    const barTwoColumn = firstRow.indexOf("|", 2) + 1;
    const rect = line.getBoundingClientRect();
    line.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: rect.left + (barTwoColumn + 0.5) * charWidth,
        clientY: rect.top + rect.height / 2,
      }),
    );
  });

  const time = await page.evaluate(() => document.getElementById("player").currentTime);
  expect(Math.abs(time - (LEAD_IN_S + 16 * SIXTEENTH_S))).toBeLessThan(0.05);
  await expect(page.locator(".tab-cursor:not([hidden])")).toHaveCount(1);
});

test("while playing, the line being played scrolls to the top", async ({ page }) => {
  const logs = collectLogs(page);
  await page.setViewportSize({ width: 390, height: 700 });
  await transcribeRiff(page, logs);
  await page.waitForFunction(() => document.getElementById("player").readyState >= 1);
  // Room below the tab, so any line can reach the top of the window.
  await page.evaluate(() => (document.body.style.paddingBottom = "3000px"));
  const lines = page.locator(".tab-line");
  expect(await lines.count()).toBeGreaterThan(2);

  await lines.nth(2).click();
  await page.evaluate(() => {
    const player = document.getElementById("player");
    player.muted = true;
    return player.play();
  });
  // The line with the cursor sits just below the (sticky) player.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const line = document.querySelector(".tab-cursor:not([hidden])")?.closest(".tab-line");
          if (!line) return null;
          const playerHeight = document.getElementById("player-box").offsetHeight;
          return Math.abs(line.getBoundingClientRect().top - playerHeight - 8) < 4;
        }),
      { timeout: 5_000 },
    )
    .toBe(true);
});

test("songs are kept in the history after a reload", async ({ page }) => {
  const logs = collectLogs(page);
  await transcribeRiff(page, logs);
  await page.reload();
  await expect(page.locator("#history")).toBeVisible();
  await expect(page.locator("#history-list")).toContainText("riff.wav");
  await page.locator("#history-list button", { hasText: "Open" }).first().click();
  await expect(page.locator("#result")).toBeVisible();
  await expect(page.locator("#timings")).toContainText("Opened from your songs");
  const tab = await page.locator("#tab-view").innerText();
  expect(tab).toContain("E|0-------0---3---");
});
