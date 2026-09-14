import { describe, expect, it } from "vitest";
import { framesToSamples, framesToTimestamp, secondsToFrames, stableStringify, TimelineSchema, zodErrors } from "../src/index.ts";

const f30 = { numerator: 30, denominator: 1 };
const ntsc = { numerator: 30000, denominator: 1001 };
const film = { numerator: 24000, denominator: 1001 };
const hash = "a".repeat(64);

const base = () => ({
  version: 1,
  canvas: { width: 320, height: 180, fps: f30 },
  totalFrames: 90,
  segments: [
    { startFrame: 0, endFrame: 30, zone: "a", source: { kind: "video", path: "a.mp4", hash, inFrame: 0 } },
    { startFrame: 30, endFrame: 90, zone: "b", source: { kind: "color", color: "111111" } },
  ],
  overlays: [{ id: "t", startFrame: 0, endFrame: 90, font: "Inter", size: 40, color: "FFFFFF", lines: [{ text: "Hi", x: 160, baseline: 50, width: 30 }] }],
  audio: null,
  output: "row.mp4",
});
const errs = (t: unknown) => {
  const r = TimelineSchema.safeParse(t);
  return r.success ? [] : zodErrors(r.error);
};

describe("quantization (round-half-up, exact)", () => {
  it("handles zero, one and exact boundaries", () => {
    expect(secondsToFrames(0, f30)).toBe(0);
    expect(secondsToFrames("0.0333333", f30)).toBe(1); // 0.999999 frames
    expect(secondsToFrames(1, f30)).toBe(30);
    expect(secondsToFrames("2", f30)).toBe(60);
  });
  it("rounds around the half frame at 30fps (1/60 s = half frame)", () => {
    expect(secondsToFrames("0.016666", f30)).toBe(0); // just below half
    expect(secondsToFrames("0.05", f30)).toBe(2); // exactly 1.5 frames -> up
    expect(secondsToFrames("0.016667", f30)).toBe(1); // just above half
  });
  it("is not fooled by binary floating point: 2.05s @30 = 61.5 frames -> 62", () => {
    expect(secondsToFrames(2.05, f30)).toBe(62);
    expect(secondsToFrames("1.05", { numerator: 10, denominator: 1 })).toBe(11); // exactly 10.5
    expect(secondsToFrames(1.005, { numerator: 1000, denominator: 1 })).toBe(1005); // float: 1.005*1000 = 1004.9999999999999
  });
  it("uses rational NTSC rates", () => {
    expect(secondsToFrames(1001, ntsc)).toBe(30000);
    expect(secondsToFrames("1.001", ntsc)).toBe(30);
    // 0.5 frame at 29.97 = 1001/60000 s = 0.0166833.. s
    expect(secondsToFrames("0.01668", ntsc)).toBe(0);
    expect(secondsToFrames("0.016684", ntsc)).toBe(1);
    expect(secondsToFrames("1.001", film)).toBe(24);
    expect(secondsToFrames("10", film)).toBe(240); // 239.76
  });
  it("rejects garbage", () => {
    expect(() => secondsToFrames("-1", f30)).toThrow();
    expect(() => secondsToFrames("abc", f30)).toThrow();
  });
  it("formats timestamps and samples", () => {
    expect(framesToTimestamp(30000, ntsc)).toBe("00:16:41.000");
    expect(framesToTimestamp(1, ntsc)).toBe("00:00:00.033");
    expect(framesToSamples(1, ntsc, 48000)).toBe(1602); // 1601.6
    expect(framesToSamples(30000, ntsc, 48000)).toBe(48048000);
  });
});

describe("timeline schema", () => {
  it("accepts a tiled timeline", () => expect(errs(base())).toEqual([]));

  it("rejects bad fps / canvas", () => {
    const t = base();
    (t.canvas.fps as any) = 29.97;
    expect(errs(t).length).toBeGreaterThan(0);
    const u = base();
    u.canvas.fps.denominator = 0;
    u.canvas.width = 321;
    expect(errs(u).map((e) => e.path)).toEqual(["canvas.width", "canvas.fps.denominator"]);
  });

  it("rejects non-integer frames", () => {
    const t = base();
    t.segments[0].endFrame = 30.5;
    expect(errs(t).some((e) => e.path === "segments[0].endFrame")).toBe(true);
  });

  it("rejects gaps", () => {
    const t = base();
    t.segments[1].startFrame = 31;
    expect(errs(t)).toContainEqual(expect.objectContaining({ path: "segments[1].startFrame", message: expect.stringContaining("Gap") }));
  });

  it("rejects overlaps", () => {
    const t = base();
    t.segments[1].startFrame = 29;
    expect(errs(t)).toContainEqual(expect.objectContaining({ path: "segments[1].startFrame", message: expect.stringContaining("Overlap") }));
  });

  it("requires first segment at 0 and last at totalFrames", () => {
    const t = base();
    t.totalFrames = 91;
    expect(errs(t)).toContainEqual(expect.objectContaining({ path: "segments" }));
    const u = base();
    u.segments.shift();
    u.segments[0].startFrame = 30;
    expect(errs(u).some((e) => e.path === "segments[0].startFrame")).toBe(true);
  });

  it("rejects malformed overlay timing", () => {
    const t = base();
    t.overlays[0].endFrame = 0;
    expect(errs(t).some((e) => e.path === "overlays[0]")).toBe(true);
    const u = base();
    u.overlays[0].endFrame = 91;
    expect(errs(u).some((e) => e.path === "overlays[0].endFrame")).toBe(true);
  });

  it("rejects unsupported fields and colors", () => {
    const t: any = base();
    t.transition = "wipe";
    t.overlays[0].color = "#fff";
    const e = errs(t);
    expect(e).toContainEqual(expect.objectContaining({ code: "UNSUPPORTED_FIELD" }));
    expect(e.some((x) => x.path === "overlays[0].color")).toBe(true);
  });

  it("serializes deterministically regardless of key order", () => {
    const a = base();
    const b = JSON.parse(JSON.stringify(a), (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(stableStringify(a)).toBe(stableStringify(b));
  });
});
