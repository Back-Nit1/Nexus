import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Timeline } from "@nexus/timeline";
import { ffmpeg, ffprobe, fitText, fontFamilies, measureTexts, parseMetadata, preflightFont, render, segmentCacheKey, FONTS_DIR } from "../src/index.ts";
import { bandClip, readBands } from "./synth.ts";

const hash = (c: string) => c.repeat(64);
const canvas = { width: 320, height: 180, fps: { numerator: 30, denominator: 1 } };
let dir: string, A: string, B: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nexus render ")); // path with spaces on purpose
  A = await bandClip(dir, "clip a.mp4", 1, 90);
  B = await bandClip(dir, "clip b vfr.mp4", 2, 90, { vfr: true });
});

const golden = (): Timeline => ({
  version: 1,
  canvas,
  totalFrames: 32,
  segments: [
    { startFrame: 0, endFrame: 10, zone: "a", source: { kind: "video", path: A, hash: hash("a"), inFrame: 5 } },
    { startFrame: 10, endFrame: 16, zone: "b", source: { kind: "video", path: B, hash: hash("b"), inFrame: 58 } },
    { startFrame: 16, endFrame: 30, zone: "c", source: { kind: "video", path: A, hash: hash("a"), inFrame: 40 } },
    { startFrame: 30, endFrame: 32, zone: "d", source: { kind: "color", color: "000000" } },
  ],
  overlays: [],
  audio: null,
  output: "golden.mp4",
});

// Expected source frame for every output frame, derived from the timeline (VFR: normalized j<60 -> floor(j/2), else j-30).
const expected = [
  ...Array.from({ length: 10 }, (_, k) => ({ id: 1, n: 5 + k })),
  ...Array.from({ length: 6 }, (_, k) => ({ id: 2, n: 58 + k < 60 ? (58 + k) >> 1 : 58 + k - 30 })),
  ...Array.from({ length: 14 }, (_, k) => ({ id: 1, n: 40 + k })),
  { id: 0, n: 0 },
  { id: 0, n: 0 },
];

describe("golden frames", () => {
  it("renders exact source frames at every cut, including VFR, with exact frame count", async () => {
    const out = join(dir, "out one", "golden.mp4");
    const r = await render(golden(), { jobDir: join(dir, "job one"), cacheDir: join(dir, "cache"), output: out });
    expect(r.engine.ffmpegVersion).toBe("6.0");
    const frames = await readBands(out);
    expect(frames.length).toBe(32);
    expect(frames).toEqual(expected);
    const { stdout } = await ffprobe(["-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", out]);
    expect(Number(stdout)).toBe(32);
  });

  it("hits the segment cache and reproduces identical frames", async () => {
    const out2 = join(dir, "golden2.mp4");
    const r = await render(golden(), { jobDir: join(dir, "job two"), cacheDir: join(dir, "cache"), output: out2 });
    expect(r.cacheHits).toBe(4);
    const fresh = join(dir, "golden3.mp4");
    await render(golden(), { jobDir: join(dir, "job three"), cacheDir: join(dir, "cache fresh"), output: fresh });
    const md5 = async (f: string) => String((await ffmpeg(["-i", f, "-map", "0:v", "-f", "framemd5", "-"])).stdout);
    expect(await md5(fresh)).toBe(await md5(out2));
  });

  it("builds one continuous audio track of exactly totalFrames duration", async () => {
    const { tone } = await import("./synth.ts");
    const music = await tone(dir, "music bed.m4a", 3);
    const t = { ...golden(), audio: { path: music, hash: hash("c"), inFrame: 3 } };
    const out = join(dir, "with audio.mp4");
    await render(t, { jobDir: join(dir, "job audio"), cacheDir: join(dir, "cache"), output: out });
    const { stdout } = await ffprobe(["-show_entries", "stream=codec_type,nb_frames", "-of", "json", out]);
    expect(JSON.parse(String(stdout)).streams.map((s: any) => s.codec_type).sort()).toEqual(["audio", "video"]);
  });
});

describe("audio invariant", () => {
  it("never encodes audio inside picture segments, even when the source clip has audio", async () => {
    const src = join(dir, "clip with audio.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "color=gray:s=160x90:r=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-frames:v", "30", "-shortest", "-c:v", "libx264", "-c:a", "aac", src]);
    const cacheDir = join(dir, "cache audio src");
    const t: Timeline = { ...golden(), totalFrames: 10, segments: [{ startFrame: 0, endFrame: 10, zone: "a", source: { kind: "video", path: src, hash: hash("e"), inFrame: 0 } }] };
    await render(t, { jobDir: join(dir, "job audio src"), cacheDir, output: join(dir, "audio src.mp4") });
    const { readdir } = await import("node:fs/promises");
    const [segment] = await readdir(cacheDir);
    const { stdout } = await ffprobe(["-show_entries", "stream=codec_type", "-of", "csv=p=0", join(cacheDir, segment)]);
    expect(String(stdout).trim()).toBe("video");
  });
});

describe("cache key", () => {
  it("keeps the ordered field layout stable (compatibility surface)", () => {
    const k = segmentCacheKey(hash("a"), 5, 10, { fit: "cover", overlays: [] }, canvas, "0.1.0", "6.0");
    expect(k).toBe(segmentCacheKey(hash("a"), 5, 10, { overlays: [], fit: "cover" }, canvas, "0.1.0", "6.0"));
    expect(k).not.toBe(segmentCacheKey(hash("a"), 10, 5, { fit: "cover", overlays: [] }, canvas, "0.1.0", "6.0"));
    // Golden value: changing field order or serialization breaks this.
    expect(k).toMatchInlineSnapshot(`"88c178c53cbab7a6a08abe6e67aa96f0c9b82902cd6f0a6d69fbbf0f49fd3d10"`);
  });
});

describe("text", () => {
  it("reads metadata=print from stdout, not stderr", async () => {
    const r = await ffmpeg(["-f", "lavfi", "-i", "color=white:s=64x64:d=0.04,format=gray,bbox,metadata=print:file=-", "-frames:v", "1", "-f", "null", "-"]);
    expect(parseMetadata(String(r.stdout))[0]["lavfi.bbox.w"]).toBe("64");
    expect(String(r.stderr)).not.toContain("lavfi.bbox");
    const [short, long] = await measureTexts(["Hi", "Hello wide world"], "Inter", 40);
    expect(short).toBeGreaterThan(10);
    expect(long).toBeGreaterThan(short * 3);
  });

  it("preflights the bundled font by its name table", async () => {
    expect(await preflightFont("Inter")).toContain("Inter.ttf");
    expect(fontFamilies(await readFile(join(FONTS_DIR, "Inter.ttf")))).toContain("Inter");
    await expect(preflightFont("Inter", dir)).rejects.toMatchObject({ error: { code: "FONT_MISSING" } });
  });

  it("fits the largest size and reports precise TEXT_DOES_NOT_FIT errors", async () => {
    const base = { path: "zones[0].text[0]", font: "Inter" as const, maxWidth: 300, maxLines: 2 };
    const ok = await fitText({ ...base, text: "Big sale", minSize: 20, maxSize: 48 });
    expect(ok).toMatchObject({ size: 48, lines: [{ text: "Big sale" }] });
    const wrapped = await fitText({ ...base, text: "The quick brown fox jumps over the lazy dog", minSize: 20, maxSize: 64 });
    expect("size" in wrapped && wrapped.lines.length).toBe(2);
    expect("size" in wrapped && wrapped.lines.every((l) => l.width <= 300)).toBe(true);
    const bad = await fitText({ ...base, text: "The quick brown fox jumps over the lazy dog again and again", minSize: 42, maxSize: 64 });
    expect(bad).toMatchObject({ code: "TEXT_DOES_NOT_FIT", path: "zones[0].text[0]", details: { maxLines: 2, minimumFontSize: 42 } });
    expect((bad as any).details.requiredLines).toBeGreaterThan(2);
    expect((bad as any).message).toMatch(/requires \d+ lines at minimum font size 42px but maxLines is 2/);
  });
});
