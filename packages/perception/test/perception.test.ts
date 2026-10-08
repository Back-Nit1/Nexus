import { writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

  it("normalizes a VFR source to the target fps before counting frames", async () => {
    // 90 encoded frames, but the first 30 each last 2/30s (settb 1/30): normalized at 30fps that's
    // 30*2 + 60*1 = 120 frames - the point is this comes from fps-normalization, not the raw frame count.
    const dir = await mkdtemp(join(tmpdir(), "nexus perception vfr "));
    const vfr = await bandClip(dir, "vfr.mp4", 4, 90, { vfr: true });
    const a = await analyze(vfr, f30);
    expect(a).toMatchObject({ kind: "video", frames: 120 });
  });

  it("classifies a multi-frame animated image as video, not a frozen still", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus perception animated "));
    const gif = join(dir, "anim.gif");
    await ffmpeg(["-f", "lavfi", "-i", "color=red:s=32x32:r=10", "-frames:v", "5", gif]);
    const still = join(dir, "still.gif");
    await ffmpeg(["-f", "lavfi", "-i", "color=blue:s=32x32", "-frames:v", "1", still]);
    expect(await analyze(gif, f30)).toMatchObject({ kind: "video", animated: true });
    expect(await analyze(still, f30)).toMatchObject({ kind: "image" });
    expect((await analyze(still, f30)).animated).toBeUndefined();
  });

  it("refuses rotated source footage with a structured error instead of silently cropping it sideways", async () => {
    // This ffmpeg build's mp4/mov muxer doesn't reliably surface a `rotate` tag or Display Matrix side data for
    // synthetic lavfi sources, so exercise the two real-world rotation signals (legacy `tags.rotate` and the
    // modern Display Matrix side_data) directly against ffprobe's own JSON shape via a scoped mock.
    vi.resetModules();
    vi.doMock("@nexus/renderer/ffmpeg", async () => {
      const actual = await vi.importActual<typeof import("@nexus/renderer/ffmpeg")>("@nexus/renderer/ffmpeg");
      return { ...actual, ffprobe: vi.fn(async () => ({ stdout: JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", width: 160, height: 90, tags: { rotate: "90" } }] }) })) };
    });
    const { analyze: analyzeWithMock } = await import("../src/index.ts");
    await expect(analyzeWithMock("irrelevant.mp4", f30)).rejects.toMatchObject({ error: { code: "ROTATION_UNSUPPORTED" } });

    vi.resetModules();
    vi.doMock("@nexus/renderer/ffmpeg", async () => {
      const actual = await vi.importActual<typeof import("@nexus/renderer/ffmpeg")>("@nexus/renderer/ffmpeg");
      return {
        ...actual,
        ffprobe: vi.fn(async () => ({
          stdout: JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", width: 160, height: 90, side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] }] }),
        })),
      };
    });
    const { analyze: analyzeWithMock2 } = await import("../src/index.ts");
    await expect(analyzeWithMock2("irrelevant.mp4", f30)).rejects.toMatchObject({ error: { code: "ROTATION_UNSUPPORTED" } });
    vi.resetModules();
    vi.doUnmock("@nexus/renderer/ffmpeg");
  });

  it("reports corrupt media with a structured error instead of throwing a raw ffprobe failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus perception corrupt "));
    const bad = join(dir, "corrupt.mp4");
    await writeFile(bad, "this is not a real video file, just garbage bytes");
    await expect(analyze(bad, f30)).rejects.toMatchObject({ error: { code: "MEDIA_CORRUPT" } });
  });

  it("reports a stream with neither video nor audio as unsupported", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus perception unsupported "));
    const srt = join(dir, "sub.srt");
    await writeFile(srt, "1\n00:00:00,000 --> 00:00:01,000\nHello\n\n");
    const out = join(dir, "subs.mp4");
    await ffmpeg(["-f", "srt", "-i", srt, "-c:s", "mov_text", out]);
    await expect(analyze(out, f30)).rejects.toMatchObject({ error: { code: "MEDIA_UNSUPPORTED" } });
  });
});
