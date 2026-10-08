import { describe, expect, it } from "vitest";
import { checkOutputName, compile, evaluate, parseExpression, serializeTimeline, textRequests, validateTemplate, type Media, type Prepared, type RowInput, type Template } from "../src/index.ts";

const h = (c: string) => c.repeat(64);
export const demoTemplate = (): Template => ({
  schemaVersion: 1,
  id: "promo",
  name: "Promo",
  version: "1.0.0",
  canvas: { width: 320, height: 180, fps: { numerator: 30, denominator: 1 } },
  totalFrames: 90,
  slots: [
    { id: "hookClip", kind: "video", required: true },
    { id: "music", kind: "audio", required: false },
  ],
  fields: [
    { id: "headline", required: true },
    { id: "slug", required: true },
  ],
  zones: [
    { id: "hook", frames: 30, fill: { type: "slot", slot: "hookClip" }, text: [{ text: "{row.headline}", font: "Inter", size: { min: 20, max: 30 }, color: "FFFFFF", position: { x: 0.5, y: 0.2 }, width: 0.8, maxLines: 2 }] },
    { id: "broll", frames: 30, fill: { type: "score", maximize: "motion * sharpness" }, text: [] },
    { id: "broll2", frames: 20, fill: { type: "score", maximize: "motion * sharpness" }, text: [] },
    { id: "end", frames: 10, fill: { type: "color", color: "111111" }, text: [] },
  ],
  audio: { slot: "music" },
  output: "{row.id}-{row.slug}.mp4",
});

const vid = (id: string, hash: string, frames = 100): Media => ({ id, path: `/m/${id}`, hash, kind: "video", frames });
const row = (pool: Media[]): RowInput => ({ id: "r1", fields: { headline: "Hello", slug: "hello" }, slots: { hookClip: vid("hook.mp4", h("0")) }, pool });
const prep = (scores: Prepared["scores"]): Prepared => ({ scores, text: { "zones[0].text[0]": { size: 30, lines: [{ text: "Hello", width: 60 }] } } });
const s = (motion: number, sharpness: number, brightness = 0.5) => ({ motion, sharpness, brightness });

describe("scoring expressions", () => {
  const S = s(0.5, 0.25, 0.8);
  const cases: [string, number][] = [
    ["motion", 0.5], ["sharpness", 0.25], ["brightness", 0.8],
    ["motion * sharpness", 0.125], ["motion + sharpness", 0.75], ["motion / sharpness", 2],
    ["motion - sharpness * brightness", 0.3], ["(motion - sharpness) * brightness", 0.2], ["((motion))", 0.5],
  ];
  it.each(cases)("%s", (src, want) => expect(evaluate(parseExpression(src), S)).toBeCloseTo(want, 12));
  it("handles zero values", () => {
    expect(evaluate(parseExpression("motion * sharpness"), s(0, 0.9))).toBe(0);
    expect(evaluate(parseExpression("motion / sharpness"), s(1, 0))).toBe(Infinity);
  });
  it.each(["", "motion *", "2 * motion", "motion ** sharpness", "Math.random()", "motion; sharpness", "contrast", "(motion", "motion)", "-motion", "motion sharpness"])("rejects %j", (src) =>
    expect(() => parseExpression(src)).toThrow(),
  );
  it("rejects deeply nested parentheses with a structured error instead of overflowing the stack", () => {
    const deep = "(".repeat(10_000) + "motion" + ")".repeat(10_000);
    expect(() => parseExpression(deep)).toThrow(/nested too deeply/);
  });
});

describe("validator", () => {
  it("accepts the demo template", () => expect(validateTemplate(demoTemplate())).toMatchObject({ ok: true }));
  it("reports structured, path-addressed errors", () => {
    const t: any = demoTemplate();
    t.totalFrames = 91;
    t.zones[1].fill.maximize = "motion ^ 2";
    t.zones[0].fill.slot = "nope";
    t.zones[0].text[0].text = "{row.missing}";
    const r = validateTemplate(t);
    expect(r.ok).toBe(false);
    const codes = !r.ok && r.errors.map((e) => `${e.code}@${e.path}`);
    expect(codes).toEqual(expect.arrayContaining(["CONFLICTING_DURATION@totalFrames", "EXPRESSION_INVALID@zones[1].fill.maximize", "UNKNOWN_SLOT@zones[0].fill.slot", "UNKNOWN_FIELD@zones[0].text[0].text"]));
  });
  it("rejects unsupported colors and fields", () => {
    for (const color of ["#fff", "white", "rgb(255,255,255)", "FFF"]) {
      const t: any = demoTemplate();
      t.zones[0].text[0].color = color;
      expect(validateTemplate(t)).toMatchObject({ ok: false, errors: [{ path: "zones[0].text[0].color" }] });
    }
    const t: any = demoTemplate();
    t.zones[0].transition = "wipe";
    expect(validateTemplate(t)).toMatchObject({ ok: false, errors: [{ code: "UNSUPPORTED_FIELD" }] });
  });
});

describe("output names", () => {
  it.each(["../x.mp4", "/abs.mp4", "a/b.mp4", "a\\b.mp4", "con.mp4", "x.mov", "a:b.mp4", ".mp4"])("rejects %j", (n) => expect(checkOutputName(n)).not.toBeNull());
  it("accepts ordinary names with spaces", () => expect(checkOutputName("row 1-hello.mp4")).toBeNull());
});

describe("compiler", () => {
  const pool = [vid("a.mp4", h("a")), vid("b.mp4", h("b")), vid("c.mp4", h("c")), vid("short.mp4", h("d"), 10)];
  const scores = { [h("a")]: s(0.5, 0.5), [h("b")]: s(0.9, 0.9), [h("c")]: s(0.25, 1), [h("d")]: s(1, 1) };

  it("is byte-identical across runs and pool permutations", () => {
    const outs = new Set<string>();
    for (const order of [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2]]) {
      for (let i = 0; i < 3; i++) {
        const r = compile(demoTemplate(), row(order.map((k) => pool[k])), prep(scores));
        if (!r.ok) throw new Error(JSON.stringify(r.errors));
        outs.add(serializeTimeline(r.value));
      }
    }
    expect(outs.size).toBe(1);
    const [json] = outs;
    const t = JSON.parse(json);
    expect(t.segments.map((x: any) => x.source.path ?? x.source.color)).toEqual(["/m/hook.mp4", "/m/b.mp4", "/m/a.mp4", "111111"]); // short.mp4 excluded, no reuse
    expect(t.output).toBe("r1-hello.mp4");
    expect(t.totalFrames).toBe(90);
  });

  it("breaks ties by media id, independent of order", () => {
    const tied = { [h("a")]: s(0.5, 0.5), [h("b")]: s(0.5, 0.5), [h("c")]: s(0.5, 0.5) };
    for (const p of [pool.slice(0, 3), pool.slice(0, 3).reverse()]) {
      const r = compile(demoTemplate(), row(p), prep(tied));
      expect(r.ok && r.value.segments.slice(1, 3).map((x) => (x.source as any).path)).toEqual(["/m/a.mp4", "/m/b.mp4"]);
    }
  });

  it("fails clearly on missing bindings, non-finite scores and missing candidates", () => {
    const r1 = row(pool.slice(0, 1));
    r1.fields.headline = "";
    delete (r1.slots as any).hookClip;
    const res = compile(demoTemplate(), r1, prep({ [h("a")]: s(1, 0) }));
    expect(res.ok).toBe(false);
    const codes = !res.ok && res.errors.map((e) => e.code);
    expect(codes).toEqual(expect.arrayContaining(["MISSING_BINDING", "NO_CANDIDATE_CLIP"]));

    const t = demoTemplate();
    t.zones[1].fill = { type: "score", maximize: "motion / sharpness" };
    const r2 = compile(t, row(pool.slice(0, 2)), prep({ [h("a")]: s(1, 0), [h("b")]: s(1, 1) }));
    expect(!r2.ok && r2.errors.map((e) => e.code)).toContain("SCORE_NOT_FINITE");
  });

  it("passes text measurement errors through and resolves bindings for requests", () => {
    const req = textRequests(demoTemplate(), row(pool));
    expect(req).toEqual({ ok: true, value: [{ path: "zones[0].text[0]", text: "Hello", font: "Inter", minSize: 20, maxSize: 30, maxWidth: 256, maxLines: 2 }] });
    const fitErr = { code: "TEXT_DOES_NOT_FIT", path: "zones[0].text[0]", message: "x", details: { requiredLines: 3, maxLines: 2, minimumFontSize: 20 } };
    const r = compile(demoTemplate(), row(pool), { scores, text: { "zones[0].text[0]": fitErr } });
    expect(r).toEqual({ ok: false, errors: [fitErr] });
  });
});
