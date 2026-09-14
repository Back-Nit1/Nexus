import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@nexus/renderer";
import type { Timeline } from "@nexus/timeline";
import { runQA } from "../src/index.ts";

describe("qa", () => {
  it("passes a correct render and reports mismatches without repairing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus qa "));
    const t: Timeline = {
      version: 1,
      canvas: { width: 320, height: 180, fps: { numerator: 30000, denominator: 1001 } },
      totalFrames: 20,
      segments: [{ startFrame: 0, endFrame: 20, zone: "z", source: { kind: "color", color: "224466" } }],
      overlays: [{ id: "zones[0].text[0]", startFrame: 5, endFrame: 15, font: "Inter", size: 24, color: "FFFFFF", lines: [{ text: "Hello QA", x: 160, baseline: 60, width: 100 }] }],
      audio: null,
      output: "qa.mp4",
    };
    const out = join(dir, "qa.mp4");
    await render(t, { jobDir: join(dir, "job"), cacheDir: join(dir, "cache"), output: out });
    const ok = await runQA(t, out);
    expect(ok.checks.filter((c) => !c.passed)).toEqual([]);

    const wrong = await runQA({ ...t, totalFrames: 21, canvas: { ...t.canvas, width: 640 } }, out);
    expect(wrong.passed).toBe(false);
    expect(wrong.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual(["frameCount", "dimensions", "timelineConsistency"]);
    expect((await runQA(t, join(dir, "missing.mp4"))).checks[0]).toMatchObject({ name: "decode", passed: false });
  });
});
