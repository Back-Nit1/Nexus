import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ffmpeg } from "@nexus/renderer/ffmpeg";
import { analyze, hashFile } from "../src/index.ts";
import { bandClip } from "../../renderer/test/synth.ts";

const f30 = { numerator: 30, denominator: 1 };

describe("perception", () => {
  it("computes deterministic metadata and scores that rank motion, sharpness and brightness", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus perception "));
    const moving = await bandClip(dir, "moving.mp4", 3, 45);
    const still = join(dir, "still.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "color=0x808080:s=160x90:r=30", "-frames:v", "45", "-c:v", "libx264", "-pix_fmt", "yuv420p", still]);
    const png = join(dir, "logo.png");
    await ffmpeg(["-f", "lavfi", "-i", "color=white:s=64x64", "-frames:v", "1", png]);

    const a = await analyze(moving, f30);
    expect(a).toMatchObject({ kind: "video", width: 160, height: 90, frames: 45 });
    expect(await analyze(moving, f30)).toEqual(a);
    expect(await analyze(moving, { numerator: 15, denominator: 1 })).toMatchObject({ frames: 23 });

    const b = await analyze(still, f30);
    expect(b.scores!.motion).toBe(0);
    expect(a.scores!.motion).toBeGreaterThan(0);
    expect(a.scores!.sharpness).toBeGreaterThan(b.scores!.sharpness);
    expect(b.scores!.brightness).toBeCloseTo(128 / 255, 1);

    expect(await analyze(png, f30)).toMatchObject({ kind: "image", width: 64, height: 64, scores: { motion: 0 } });
    expect(await hashFile(moving)).toMatch(/^[0-9a-f]{64}$/);
  });
});
