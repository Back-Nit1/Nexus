import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { render } from "@nexus/renderer";
import type { Template } from "@nexus/template";
import { Batch, defaultConcurrency, loadRows, parseCsv, type Mapping } from "../src/index.ts";
import { bandClip } from "../../renderer/test/synth.ts";

const template: Template = {
  schemaVersion: 1,
  id: "demo",
  name: "Demo",
  version: "1.0.0",
  canvas: { width: 320, height: 180, fps: { numerator: 30, denominator: 1 } },
  slots: [{ id: "hookClip", kind: "video", required: true }],
  fields: [{ id: "headline", required: true }, { id: "slug", required: true }],
  zones: [
    { id: "hook", frames: 20, fill: { type: "slot", slot: "hookClip" }, text: [{ text: "{row.headline}", font: "Inter", size: { min: 14, max: 28 }, color: "FFFFFF", position: { x: 0.5, y: 0.25 }, width: 0.9, maxLines: 2 }] },
    { id: "broll", frames: 15, fill: { type: "score", maximize: "motion * sharpness" }, text: [] },
    { id: "end", frames: 5, fill: { type: "color", color: "111111" }, text: [] },
  ],
  audio: null,
  output: "{row.slug}.mp4",
};

let root: string, mapping: Mapping;
const csv = `id,Headline,slug,hook,pool
r1,Hello world,one,clip1.mp4,clip3.mp4;clip4.mp4
r2,"Second, quoted",two,clip2.mp4,clip3.mp4
r3,,three,clip1.mp4,clip3.mp4
r4,Dup A,dup,clip1.mp4,clip3.mp4
r5,Dup B,dup,clip2.mp4,clip4.mp4
r6,Missing file,six,nope.mp4,clip3.mp4
`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nexus batch "));
  const media = join(root, "media dir");
  await mkdir(media);
  await Promise.all([1, 2, 3, 4].map((i) => bandClip(media, `clip${i}.mp4`, i, 30 + i * 5)));
  await writeFile(join(root, "rows.csv"), csv);
  mapping = { mode: "csv", csv: join(root, "rows.csv"), mediaDir: media, idColumn: "id", fields: { headline: "Headline", slug: "slug" }, slots: { hookClip: "hook" }, poolColumn: "pool" };
});

const open = (dir: string, extra: Partial<Parameters<typeof Batch.open>[0]> = {}) =>
  Batch.open({ dir: join(root, dir), template, mapping, batchId: dir, cacheDir: join(root, "cache"), concurrency: 2, ...extra });

describe("inputs", () => {
  it("parses RFC4180 CSV", () => expect(parseCsv('a,b\r\n"x, ""y""",z\n')).toEqual([["a", "b"], ['x, "y"', "z"]]));
  it("loads folder-of-subfolders rows", async () => {
    const f = join(root, "folders");
    await mkdir(join(f, "product-001"), { recursive: true });
    await cp(join(root, "media dir", "clip1.mp4"), join(f, "product-001", "clip1.mp4"));
    await cp(join(root, "media dir", "clip2.mp4"), join(f, "product-001", "clip2.mp4"));
    await writeFile(join(f, "product-001", "row.json"), JSON.stringify({ headline: "Folder row" }));
    const { rows, columns } = await loadRows({ mode: "folders", root: f, fields: { headline: "headline" }, slots: { hookClip: "clip1.mp4" } });
    expect(columns).toEqual(["headline"]);
    expect(rows).toEqual([{ id: "product-001", fields: { headline: "Folder row" }, slots: { hookClip: join(f, "product-001", "clip1.mp4") }, pool: [join(f, "product-001", "clip2.mp4")] }]);
  });
  it("defaults concurrency to half the logical CPUs, min 1", () => expect(defaultConcurrency()).toBeGreaterThanOrEqual(1));
});

describe("batch", () => {
  it("renders valid rows, isolates invalid rows and collisions, persists results.json", async () => {
    const b = await open("run");
    const events: string[] = [];
    b.on("row", (r) => events.push(`${r.rowId}:${r.status}`));
    const res = await b.start();
    const by = Object.fromEntries(res.rows.map((r) => [r.rowId, r]));
    expect(Object.fromEntries(res.rows.map((r) => [r.rowId, r.status]))).toEqual({ r1: "passed", r2: "passed", r3: "invalid", r4: "invalid", r5: "invalid", r6: "invalid" });
    expect(by.r3.error!.code).toBe("MISSING_BINDING");
    expect(by.r4.error!.code).toBe("OUTPUT_NAME_COLLISION");
    expect(by.r6.error!.code).toBe("INPUT_MISSING");
    expect(by.r1.qa!.passed).toBe(true);
    expect([by.r1.attempts, by.r2.attempts, by.r1.error, by.r2.error]).toEqual([1, 1, undefined, undefined]); // shared cached segments must not race
    expect(by.r1.timeline!.segments[1].source).toMatchObject({ kind: "video", path: expect.stringContaining("clip4.mp4") }); // longest clip wins motion*sharpness? recorded deterministically
    expect(Object.keys(by.r1.inputHashes).sort()).toEqual(["clip1.mp4", "clip3.mp4", "clip4.mp4"]);
    expect(existsSync(by.r1.output!) && existsSync(by.r1.thumbnail!)).toBe(true);
    expect(events).toContain("r1:rendering");
    const disk = JSON.parse(await readFile(join(root, "run", "results.json"), "utf8"));
    expect(disk).toMatchObject({ batchId: "run", templateId: "demo", templateVersion: "1.0.0", ffmpegVersion: "6.0" });
    expect(disk.rows).toEqual(JSON.parse(JSON.stringify(res.rows)));
  });

  it("retries a failed render once", async () => {
    let calls = 0;
    const flaky: typeof render = async (t, o) => (t.output === "two.mp4" && calls++ === 0 ? Promise.reject(new Error("boom")) : render(t, o));
    const res = await (await open("retry", { render: flaky })).start();
    expect(res.rows.find((r) => r.rowId === "r2")).toMatchObject({ status: "passed", attempts: 2 });
    let always = 0;
    const broken: typeof render = async () => (always++, Promise.reject(new Error("dead")));
    const res2 = await (await open("fail", { render: broken })).start();
    expect(res2.rows.find((r) => r.rowId === "r1")).toMatchObject({ status: "failed", attempts: 2, error: { code: "RENDER_FAILED" } });
  });

  it("recovers after a crash: rendering rows become pending, finished rows are kept", async () => {
    const dir = join(root, "crash");
    await (await open("crash")).start();
    const file = join(dir, "results.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    saved.rows[0].status = "rendering"; // process died mid-render
    await writeFile(file, JSON.stringify(saved));
    const rendered: string[] = [];
    const spy: typeof render = (t, o) => (rendered.push(t.output), render(t, o));
    const b = await open("crash", { render: spy });
    expect(b.results.rows[0]).toMatchObject({ status: "pending", attempts: 1 });
    const res = await b.start();
    expect(rendered).toEqual(["one.mp4"]);
    expect(res.rows[0]).toMatchObject({ status: "passed", attempts: 2 });
    expect(res.rows[1].status).toBe("passed");
  });

  it("pauses, resumes and cancels", async () => {
    const b = await open("pause", { concurrency: 1 });
    b.once("row", () => b.pause());
    const done = b.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(b.state).toBe("paused");
    b.resume();
    expect((await done).rows.filter((r) => r.status === "passed").length).toBe(2);

    const hang: typeof render = (_t, o) => new Promise((_, reject) => o.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
    const c = await open("cancel", { render: hang, concurrency: 1 });
    c.on("row", (r) => r.status === "rendering" && c.cancel());
    const res = await c.start();
    expect(res.rows.filter((r) => r.status === "cancelled").map((r) => r.rowId)).toEqual(["r1", "r2"]);
  });
});
