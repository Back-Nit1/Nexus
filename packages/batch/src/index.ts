import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { runQA, type QAResult } from "@nexus/qa";
import { ENGINE_VERSION, ffmpeg, FFMPEG_VERSION, render as renderTimeline } from "@nexus/renderer";
import type { Template } from "@nexus/template";
import type { StructuredError, Timeline } from "@nexus/timeline";
import { loadRows, Preparer, SAFE_ROW_ID, type Mapping, type RawRow } from "./inputs.ts";

export * from "./inputs.ts";

export type RowStatus = "invalid" | "pending" | "rendering" | "passed" | "failed" | "cancelled";
export type BatchRowResult = { rowId: string; status: RowStatus; output?: string; inputHashes: Record<string, string>; timeline?: Timeline; qa?: QAResult; error?: StructuredError; attempts: number; thumbnail?: string };
export type BatchResults = { batchId: string; templateId: string; templateVersion: string; engineVersion: string; ffmpegVersion: string; mappingHash: string; rows: BatchRowResult[] };
export type BatchState = "idle" | "running" | "paused" | "cancelled" | "done";

export const defaultConcurrency = () => Math.max(1, Math.floor(availableParallelism() / 2));
const MAX_ATTEMPTS = 2; // one automatic retry after a render failure

/** Clamp to a finite, positive integer; any NaN/Infinity/non-positive input falls back to 1 rather than hanging (NaN) or running unbounded (Infinity). */
const safeConcurrency = (n: number) => (Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1);

const mappingHashOf = (mapping: Mapping) => createHash("sha256").update(JSON.stringify(mapping)).digest("hex");

/** A filename collides with another when it matches byte-for-byte, or after Unicode normalization + case folding (common filesystem semantics). */
const foldName = (name: string) => name.normalize("NFC").toLowerCase();

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
    this.concurrency = safeConcurrency(o.concurrency ?? defaultConcurrency());
  }

  static async open(o: BatchOptions): Promise<Batch> {
    const file = join(o.dir, "results.json");
    const { rows } = await loadRows(o.mapping);
    const mappingHash = mappingHashOf(o.mapping);

    const fresh = (): BatchResults => ({ batchId: o.batchId, templateId: o.template.id, templateVersion: o.template.version, engineVersion: ENGINE_VERSION, ffmpegVersion: FFMPEG_VERSION, mappingHash, rows: [] });

    let results: BatchResults | undefined;
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(await readFile(file, "utf8"));
        if (!parsed || !Array.isArray(parsed.rows)) throw new Error("malformed results.json");
        results = parsed;
      } catch {
        // Corrupt/unreadable results.json: preserve it for inspection and start clean rather than crashing the batch.
        await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
      }
    }

    // Resume compatibility: a different template, engine, ffmpeg build or mapping invalidates every previously compiled
    // timeline (segment choices, bindings and paths may no longer mean the same thing), so start the queue over.
    const compatible = results && results.templateId === o.template.id && results.templateVersion === o.template.version && results.engineVersion === ENGINE_VERSION && results.ffmpegVersion === FFMPEG_VERSION && results.mappingHash === mappingHash;
    if (!results || !compatible) results = fresh();

    for (const r of results.rows) if (r.status === "rendering") r.status = "pending"; // a crash is never a success

    // Resume compatibility: reconcile the row set against the current input (added/removed rows), and reject unsafe
    // or duplicate row ids up front so they never reach a filesystem path (jobs/<id>, outputs, thumbnails).
    const byId = new Map(results.rows.map((r) => [r.rowId, r] as const));
    const seen = new Set<string>();
    results.rows = rows.map((r): BatchRowResult => {
      if (seen.has(r.id)) return { rowId: r.id, status: "invalid", inputHashes: {}, attempts: 0, error: { code: "DUPLICATE_ROW_ID", path: "", message: `Row id '${r.id}' appears more than once in the input` } };
      seen.add(r.id);
      if (!SAFE_ROW_ID.test(r.id)) return { rowId: r.id, status: "invalid", inputHashes: {}, attempts: 0, error: { code: "UNSAFE_ROW_ID", path: "", message: `Row id '${r.id}' is not safe to use as a file name` } };
      return byId.get(r.id) ?? { rowId: r.id, status: "pending", inputHashes: {}, attempts: 0 };
    });

    const b = new Batch(o, results);
    rows.forEach((r) => b.raw.set(r.id, r));

    // Resume compatibility: a cached timeline is only trustworthy if the media it was compiled from is unchanged on disk.
    await Promise.all(
      results.rows.map(async (r) => {
        if (!r.timeline) return;
        const raw = b.raw.get(r.rowId);
        if (!raw || raw.error) return;
        const paths = [...Object.values(raw.slots), ...raw.pool];
        let changed = false;
        for (const p of paths) {
          const id = basename(p);
          if (!(id in r.inputHashes)) continue;
          try {
            if ((await b.preparer.hash(p)) !== r.inputHashes[id]) { changed = true; break; }
          } catch {
            changed = true; // now unreadable; let the normal compile step report INPUT_MISSING/UNREADABLE
            break;
          }
        }
        if (changed) Object.assign(r, { status: "pending", timeline: undefined, qa: undefined, output: undefined, thumbnail: undefined, error: undefined, attempts: 0 });
      }),
    );

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

  /**
   * Runs `work` over `rows` with live-adjustable concurrency, honoring pause/cancel.
   * `work` is expected to convert its own failures into a row update, but a rejection is caught here too
   * (belt-and-suspenders): an uncaught rejection must never silently strand a row in "pending"/"rendering"
   * or crash the drain loop via an unhandled rejection.
   */
  private drain(rows: BatchRowResult[], work: (r: BatchRowResult) => Promise<void>) {
    const queue = [...rows];
    let active = 0;
    return new Promise<void>((resolve) => {
      this.pump = () => {
        while (this.state === "running" && active < this.concurrency && queue.length) {
          active++;
          const row = queue.shift()!;
          work(row)
            .catch((e) => this.update(row, { status: "failed", error: { code: "WORKER_CRASHED", path: "", message: String((e as Error)?.message ?? e).slice(0, 500) } }))
            .finally(() => (active--, this.pump()));
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
    //    Any unexpected exception (not a validation Result) also becomes a structured per-row error, never a crash.
    await this.drain(pending().filter((r) => !r.timeline), async (row) => {
      const raw = this.raw.get(row.rowId);
      if (!raw) return void (await this.update(row, { status: "invalid", error: { code: "ROW_MISSING", path: "", message: `Row '${row.rowId}' no longer exists in inputs` } }));
      try {
        const c = await this.preparer.compileRow(t, raw);
        await this.update(row, c.timeline ? { inputHashes: c.inputHashes, timeline: c.timeline } : { inputHashes: c.inputHashes, status: "invalid", error: c.errors![0], ...(c.errors!.length > 1 && { error: { ...c.errors![0], details: { ...c.errors![0].details, allErrors: c.errors } } }) });
      } catch (e) {
        await this.update(row, { status: "invalid", error: { code: "COMPILE_CRASHED", path: "", message: String((e as Error)?.message ?? e).slice(0, 500) } });
      }
    });

    // 2. output collisions are invalid for every row involved (deterministic regardless of scheduling). Names that
    //    only differ by case or Unicode normalization still collide on common filesystems.
    const byName = Map.groupBy(this.results.rows.filter((r) => r.timeline && r.status !== "invalid"), (r) => foldName(r.timeline!.output));
    for (const [, rs] of byName)
      if (rs.length > 1) {
        const names = [...new Set(rs.map((r) => r.timeline!.output))];
        for (const r of rs) await this.update(r, { status: "invalid", error: { code: "OUTPUT_NAME_COLLISION", path: "output", message: `Output ${names.map((n) => `'${n}'`).join(" / ")} is produced by rows ${rs.map((x) => x.rowId).join(", ")}`, details: { names, rows: rs.map((x) => x.rowId) } } });
      }

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
    if (this.state === "running") {
      // Invariant: a completed batch contains no pending/rendering rows. Anything still stuck here is a bug
      // elsewhere in the pipeline (e.g. a worker that returned without updating its row) — fail it rather than
      // reporting the batch as done with unfinished work.
      for (const r of this.results.rows) if (r.status === "pending" || r.status === "rendering") await this.update(r, { status: "failed", error: { code: "ROW_NEVER_COMPLETED", path: "", message: `Row '${r.rowId}' did not reach a terminal state` } });
      this.setState("done");
    }
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
    this.concurrency = safeConcurrency(n);
    this.pump();
  }
}
