import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { runQA, type QAResult } from "@nexus/qa";
import { ENGINE_VERSION, ffmpeg, FFMPEG_VERSION, render as renderTimeline } from "@nexus/renderer";
import type { Template } from "@nexus/template";
import type { StructuredError, Timeline } from "@nexus/timeline";
import { loadRows, Preparer, type Mapping, type RawRow } from "./inputs.ts";

export * from "./inputs.ts";

export type RowStatus = "invalid" | "pending" | "rendering" | "passed" | "failed" | "cancelled";
export type BatchRowResult = { rowId: string; status: RowStatus; output?: string; inputHashes: Record<string, string>; timeline?: Timeline; qa?: QAResult; error?: StructuredError; attempts: number; thumbnail?: string };
export type BatchResults = { batchId: string; templateId: string; templateVersion: string; engineVersion: string; ffmpegVersion: string; rows: BatchRowResult[] };
export type BatchState = "idle" | "running" | "paused" | "cancelled" | "done";

export const defaultConcurrency = () => Math.max(1, Math.floor(availableParallelism() / 2));
const MAX_ATTEMPTS = 2; // one automatic retry after a render failure

export type BatchOptions = { dir: string; template: Template; mapping: Mapping; batchId: string; cacheDir: string; concurrency?: number; render?: typeof renderTimeline };

/**
 * One template x N rows. results.json is the persisted queue: it is rewritten (atomically) on every row transition,
 * so a restart resumes finished/failed/pending rows and retry counts. Rows found "rendering" on open were interrupted
 * by a crash and go back to pending — a crash is never a success.
 */
export class Batch extends EventEmitter {
  state: BatchState = "idle";
  concurrency: number;
  private raw = new Map<string, RawRow>();
  private controllers = new Set<AbortController>();
  private pump = () => {};
  private saving = Promise.resolve();
  private preparer = new Preparer();

  readonly o: BatchOptions;
  readonly results: BatchResults;

  private constructor(o: BatchOptions, results: BatchResults) {
    super();
    this.o = o;
    this.results = results;
    this.concurrency = o.concurrency ?? defaultConcurrency();
  }

  static async open(o: BatchOptions): Promise<Batch> {
    const file = join(o.dir, "results.json");
    const { rows } = await loadRows(o.mapping);
    let results: BatchResults;
    if (existsSync(file)) {
      results = JSON.parse(await readFile(file, "utf8"));
      for (const r of results.rows) if (r.status === "rendering") r.status = "pending";
    } else {
      results = { batchId: o.batchId, templateId: o.template.id, templateVersion: o.template.version, engineVersion: ENGINE_VERSION, ffmpegVersion: FFMPEG_VERSION, rows: rows.map((r) => ({ rowId: r.id, status: "pending", inputHashes: {}, attempts: 0 })) };
    }
    const b = new Batch(o, results);
    rows.forEach((r) => b.raw.set(r.id, r));
    await mkdir(o.dir, { recursive: true });
    await writeFile(join(o.dir, "mapping.json"), JSON.stringify(o.mapping, null, 2));
    await writeFile(join(o.dir, "template.nexus.json"), JSON.stringify(o.template, null, 2));
    await b.save();
    return b;
  }

  private save() {
    const file = join(this.o.dir, "results.json");
    const body = JSON.stringify(this.results, null, 2);
    return (this.saving = this.saving.then(() => writeFile(`${file}.tmp`, body)).then(() => rename(`${file}.tmp`, file)));
  }

  private async update(row: BatchRowResult, patch: Partial<BatchRowResult>) {
    Object.assign(row, patch);
    this.emit("row", row);
    await this.save();
  }

  private setState(s: BatchState) {
    this.state = s;
    this.emit("state", s);
  }

  /** Runs `work` over `rows` with live-adjustable concurrency, honoring pause/cancel. */
  private drain(rows: BatchRowResult[], work: (r: BatchRowResult) => Promise<void>) {
    const queue = [...rows];
    let active = 0;
    return new Promise<void>((resolve) => {
      this.pump = () => {
        while (this.state === "running" && active < this.concurrency && queue.length) {
          active++;
          work(queue.shift()!).finally(() => (active--, this.pump()));
        }
        if (!active && (!queue.length || this.state === "cancelled")) resolve();
      };
      this.pump();
    });
  }

  async start(): Promise<BatchResults> {
    this.setState("running");
    const { template: t, dir } = this.o;
    const pending = () => this.results.rows.filter((r) => r.status === "pending");

    // 1. validate + compile every pending row that has no timeline yet. Bad rows become invalid; the batch continues.
    await this.drain(pending().filter((r) => !r.timeline), async (row) => {
      const raw = this.raw.get(row.rowId);
      if (!raw) return this.update(row, { status: "invalid", error: { code: "ROW_MISSING", path: "", message: `Row '${row.rowId}' no longer exists in inputs` } });
      const c = await this.preparer.compileRow(t, raw);
      await this.update(row, c.timeline ? { inputHashes: c.inputHashes, timeline: c.timeline } : { inputHashes: c.inputHashes, status: "invalid", error: c.errors![0], ...(c.errors!.length > 1 && { error: { ...c.errors![0], details: { ...c.errors![0].details, allErrors: c.errors } } }) });
    });

    // 2. output collisions are invalid for every row involved (deterministic regardless of scheduling).
    const byName = Map.groupBy(this.results.rows.filter((r) => r.timeline && r.status !== "invalid"), (r) => r.timeline!.output);
    for (const [name, rs] of byName)
      if (rs.length > 1) for (const r of rs) await this.update(r, { status: "invalid", error: { code: "OUTPUT_NAME_COLLISION", path: "output", message: `Output '${name}' is produced by rows ${rs.map((x) => x.rowId).join(", ")}`, details: { name, rows: rs.map((x) => x.rowId) } } });

    // 3. render + QA
    await this.drain(pending().filter((r) => r.timeline), async (row) => {
      const tl = row.timeline!;
      const output = join(dir, "outputs", tl.output);
      while (row.status === "pending" && this.state !== "cancelled") {
        const ac = new AbortController();
        this.controllers.add(ac);
        await this.update(row, { status: "rendering", attempts: row.attempts + 1 });
        try {
          ac.signal.throwIfAborted(); // cancelled while the row was being marked rendering
          await (this.o.render ?? renderTimeline)(tl, { jobDir: join(dir, "jobs", row.rowId), cacheDir: this.o.cacheDir, output, signal: ac.signal, onProgress: (done, total) => this.emit("progress", { rowId: row.rowId, done, total }) });
          const qa = await runQA(tl, output);
          const thumbnail = join(dir, "thumbs", `${row.rowId}.png`);
          await mkdir(join(dir, "thumbs"), { recursive: true });
          await ffmpeg(["-i", output, "-vf", `select=eq(n\\,${Math.floor(tl.totalFrames / 2)}),scale=240:-2`, "-frames:v", "1", thumbnail]).catch(() => {});
          await this.update(row, { status: qa.passed ? "passed" : "failed", output, qa, thumbnail, error: undefined, ...(!qa.passed && { error: { code: "QA_FAILED", path: "", message: qa.checks.filter((c) => !c.passed).map((c) => c.name).join(", ") } }) });
        } catch (e) {
          const error = { code: "RENDER_FAILED", path: "", message: String((e as any)?.shortMessage ?? e).slice(0, 500) };
          if (ac.signal.aborted || (this.state as BatchState) === "cancelled") await this.update(row, { status: "cancelled", error: { ...error, code: "CANCELLED" } });
          else await this.update(row, row.attempts < MAX_ATTEMPTS ? { status: "pending", error } : { status: "failed", error });
        } finally {
          this.controllers.delete(ac);
        }
      }
    });

    if ((this.state as BatchState) === "cancelled") for (const r of pending()) await this.update(r, { status: "cancelled" });
    if (this.state === "running") this.setState("done");
    await this.save();
    return this.results;
  }

  pause() {
    if (this.state === "running") this.setState("paused");
  }

  resume() {
    if (this.state !== "paused") return;
    this.setState("running");
    this.pump();
  }

  cancel() {
    if (this.state !== "running" && this.state !== "paused") return;
    this.setState("cancelled");
    this.controllers.forEach((c) => c.abort());
    this.pump();
  }

  setConcurrency(n: number) {
    this.concurrency = Math.max(1, Math.floor(n));
    this.pump();
  }
}
