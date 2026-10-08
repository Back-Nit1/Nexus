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

  it("checks exact audio sample duration, not just stream presence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus qa audio "));
    const { tone } = await import("../../renderer/test/synth.ts");
    const { createHash } = await import("node:crypto");
    const { createReadStream } = await import("node:fs");
    const sha256File = async (path: string) => {
      const h = createHash("sha256");
      for await (const chunk of createReadStream(path)) h.update(chunk);
      return h.digest("hex");
    };
    const music = await tone(dir, "music.m4a", 2);
    const t: Timeline = {
      version: 1,
      canvas: { width: 160, height: 90, fps: { numerator: 30, denominator: 1 } },
      totalFrames: 30,
      segments: [{ startFrame: 0, endFrame: 30, zone: "z", source: { kind: "color", color: "112233" } }],
      overlays: [],
      audio: { path: music, hash: await sha256File(music), inFrame: 0 },
      output: "qa-audio.mp4",
    };
    const out = join(dir, "qa-audio.mp4");
    await render(t, { jobDir: join(dir, "job"), cacheDir: join(dir, "cache"), output: out });

    const ok = await runQA(t, out);
    expect(ok.checks.find((c) => c.name === "audioDuration")).toMatchObject({ passed: true });

    const wrong = await runQA({ ...t, totalFrames: 45 }, out);
    const audioCheck = wrong.checks.find((c) => c.name === "audioDuration")!;
    expect(audioCheck.passed).toBe(false);
    expect(audioCheck.expected).not.toBe(audioCheck.actual);
  });

  it("detects a declared overlay that never actually painted any pixels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus qa overlay "));
    const t: Timeline = {
      version: 1,
      canvas: { width: 320, height: 180, fps: { numerator: 30, denominator: 1 } },
      totalFrames: 20,
      // Rendered with no overlays at all.
      segments: [{ startFrame: 0, endFrame: 20, zone: "z", source: { kind: "color", color: "224466" } }],
      overlays: [],
      audio: null,
      output: "qa-missing.mp4",
    };
    const out = join(dir, "qa-missing.mp4");
    await render(t, { jobDir: join(dir, "job"), cacheDir: join(dir, "cache"), output: out });

    // QA is handed a timeline that claims an overlay exists; its coordinates are perfectly in-bounds, so a
    // metadata-only check would pass, but nothing was ever actually drawn there in the rendered file.
    const claimed: Timeline = { ...t, overlays: [{ id: "zones[0].text[0]", startFrame: 5, endFrame: 15, font: "Inter", size: 24, color: "FFFFFF", lines: [{ text: "Ghost", x: 160, baseline: 60, width: 100 }] }] };
    const result = await runQA(claimed, out);
    expect(result.checks.find((c) => c.name === "textFit")).toMatchObject({ passed: true }); // in-bounds, metadata alone wouldn't catch it
    expect(result.checks.find((c) => c.name === "overlayPixels")).toMatchObject({ passed: false, actual: ["zones[0].text[0]: Ghost"] });
  });
});
