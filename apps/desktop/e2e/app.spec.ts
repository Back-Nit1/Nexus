import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const repo = join(appDir, "..", "..");
const shots = join(appDir, "e2e", "screenshots");

test("templates -> map -> preview -> batch", async () => {
  const app = await electron.launch({
    args: [appDir],
    env: { ...process.env, NEXUS_USER_DATA: mkdtempSync(join(tmpdir(), "nexus e2e ")), NEXUS_E2E_PICK: join(repo, "fixtures", "batches", "folders") },
  });
  const page = await app.firstWindow();

  // Renderer isolation: no Node globals, only the typed bridge.
  expect(await page.evaluate(() => [typeof (window as any).require, typeof (window as any).process, typeof (window as any).nexus])).toEqual(["undefined", "undefined", "object"]);
  await expect(page.evaluate(() => (window as any).nexus.invoke("shell:exec"))).rejects.toThrow(/Blocked channel/);

  // Templates
  await expect(page.getByText("promo-short.nexus.json")).toBeVisible();
  await page.getByText("broken.nexus.json").click();
  await expect(page.getByText("CONFLICTING_DURATION")).toBeVisible();
  await expect(page.getByText("EXPRESSION_INVALID")).toBeVisible();
  await page.screenshot({ path: join(shots, "1-templates.png") });
  await page.getByText("promo-short.nexus.json").click();
  await page.getByRole("button", { name: "Open", exact: true }).click();

  // Map inputs (folder of subfolders; row.json keys auto-map to fields)
  await page.getByRole("button", { name: "Choose folder" }).click();
  await expect(page.getByText("2 rows")).toBeVisible();
  await expect(page.getByTestId("field-headline")).toHaveValue("headline");
  await expect(page.getByText("Unresolved")).toBeVisible();
  await page.getByTestId("slot-hookClip").selectOption("clip-b.mp4");
  await page.getByTestId("slot-logo").selectOption("logo.png");
  await expect(page.getByText("Unresolved")).toBeHidden();
  await page.getByRole("button", { name: "Preview row 1" }).click();
  await expect(page.getByTestId("total-frames")).toHaveText("240 frames", { timeout: 60_000 });
  await expect(page.getByText("row product-001")).toBeVisible();
  await page.screenshot({ path: join(shots, "2-map.png") });

  // Preview & tweak: edit text -> recompile; render preview
  await page.getByRole("button", { name: "Preview & tweak →" }).click();
  await page.getByTestId("text-0-0").fill("{row.headline} now");
  await expect(page.locator(".block.text").first()).toHaveText("Product one now", { timeout: 60_000 });
  await page.getByRole("button", { name: "Render preview" }).click();
  await expect(page.locator("video")).toHaveAttribute("src", /^nexus-media:/, { timeout: 120_000 });
  await page.waitForFunction(() => (document.querySelector("video") as HTMLVideoElement)?.readyState >= 1, null, { timeout: 30_000 });
  await page.screenshot({ path: join(shots, "3-preview.png") });

  // Batch
  await page.getByRole("button", { name: "Batch" }).click();
  await page.getByTestId("concurrency").fill("2");
  await page.getByRole("button", { name: "Start" }).click();
  for (const id of ["product-001", "product-002"]) await expect(page.getByTestId(`row-${id}`).getByText("passed", { exact: true })).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("batch-state")).toHaveText("done");
  await expect(page.getByTestId("row-product-001").getByText("QA pass")).toBeVisible();
  await page.screenshot({ path: join(shots, "4-batch.png") });
  await app.close();
});
