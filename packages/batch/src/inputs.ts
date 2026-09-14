import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { analyze, hashFile, type Analysis } from "@nexus/perception";
import { fitText } from "@nexus/renderer";
import { compile, textRequests, type Media, type Prepared, type Result, type RowInput, type Template } from "@nexus/template";
import type { StructuredError, Timeline } from "@nexus/timeline";

/** Serializable mapping of input columns/files onto template fields and slots. */
export type Mapping =
  | { mode: "csv"; csv: string; mediaDir: string; idColumn: string; fields: Record<string, string>; slots: Record<string, string>; poolColumn?: string }
  | { mode: "folders"; root: string; fields: Record<string, string>; slots: Record<string, string> };

/** A row before perception: bound values and absolute media paths. */
export type RawRow = { id: string; fields: Record<string, string>; slots: Record<string, string>; pool: string[] };

/** RFC 4180 CSV (quoted fields, "" escapes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [[]];
  let cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') (cell += '"'), i++;
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") rows.at(-1)!.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      rows.at(-1)!.push(cell), (cell = ""), rows.push([]);
    } else cell += c;
  }
  rows.at(-1)!.push(cell);
  return rows.filter((r) => r.some((c) => c !== ""));
}

const files = async (dir: string) => (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => e.name).sort();

/** Column names (csv header, or keys of row.json files) so the UI can offer mappings. */
export async function loadRows(m: Mapping): Promise<{ columns: string[]; files: string[]; rows: RawRow[] }> {
  const pick = (src: Record<string, string>, map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([k, col]) => [k, src[col] ?? ""]));
  if (m.mode === "csv") {
    const [header = [], ...body] = parseCsv(await readFile(m.csv, "utf8"));
    const media = await files(m.mediaDir);
    const rows = body.map((cells, i) => {
      const rec = Object.fromEntries(header.map((h, k) => [h, cells[k] ?? ""]));
      const slots = Object.fromEntries(Object.entries(pick(rec, m.slots)).filter(([, f]) => f).map(([k, f]) => [k, join(m.mediaDir, f)]));
      const used = new Set(Object.values(slots));
      const pool = m.poolColumn ? rec[m.poolColumn].split(";").map((f) => f.trim()).filter(Boolean).map((f) => join(m.mediaDir, f)) : media.map((f) => join(m.mediaDir, f)).filter((f) => !used.has(f));
      return { id: rec[m.idColumn] || `row-${i + 1}`, fields: pick(rec, m.fields), slots, pool };
    });
    return { columns: header, files: media, rows };
  }
  const dirs = (await readdir(m.root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const columns = new Set<string>(), all = new Set<string>();
  const rows = await Promise.all(
    dirs.map(async (name) => {
      const dir = join(m.root, name);
      const json = join(dir, "row.json");
      const rec: Record<string, string> = existsSync(json) ? JSON.parse(await readFile(json, "utf8")) : {};
      Object.keys(rec).forEach((k) => columns.add(k));
      const own = (await files(dir)).filter((f) => f !== "row.json");
      own.forEach((f) => all.add(f));
      const slots = Object.fromEntries(Object.entries(m.slots).filter(([, f]) => own.includes(f)).map(([k, f]) => [k, join(dir, f)]));
      return { id: name, fields: pick(rec, m.fields), slots, pool: own.filter((f) => !Object.values(m.slots).includes(f)).map((f) => join(dir, f)) };
    }),
  );
  return { columns: [...columns].sort(), files: [...all].sort(), rows };
}

export type CompiledRow = { inputHashes: Record<string, string>; timeline?: Timeline; errors?: StructuredError[] };

/** Per-process caches: path -> hash (keyed with mtime/size by caller-free simplicity: path only), hash+fps -> analysis. */
export class Preparer {
  private hashes = new Map<string, Promise<string>>();
  private analyses = new Map<string, Promise<Analysis>>();

  async media(path: string, t: Template): Promise<Media & { analysis: Analysis }> {
    const hash = await (this.hashes.get(path) ?? this.hashes.set(path, hashFile(path)).get(path)!);
    const key = `${hash}@${t.canvas.fps.numerator}/${t.canvas.fps.denominator}`;
    const analysis = await (this.analyses.get(key) ?? this.analyses.set(key, analyze(path, t.canvas.fps)).get(key)!);
    return { id: basename(path), path, hash, kind: analysis.kind, frames: analysis.frames, analysis };
  }

  /** The one compile path, shared by preview and batch: validate inputs -> perception -> text fit -> compile. */
  async compileRow(t: Template, raw: RawRow): Promise<CompiledRow> {
    const errors: StructuredError[] = [];
    const inputHashes: Record<string, string> = {};
    const load = async (path: string, at: string) => {
      if (!existsSync(path)) return void errors.push({ code: "INPUT_MISSING", path: at, message: `File not found: ${path}`, details: { file: path } });
      try {
        const m = await this.media(path, t);
        inputHashes[m.id] = m.hash;
        return m;
      } catch (e) {
        errors.push({ code: "INPUT_UNREADABLE", path: at, message: `Could not analyze ${basename(path)}`, details: { file: path, reason: String(e).slice(0, 300) } });
      }
    };
    const slotEntries = await Promise.all(Object.entries(raw.slots).map(async ([k, p]) => [k, await load(p, `slots.${k}`)] as const));
    const pool = (await Promise.all(raw.pool.map((p) => load(p, "pool")))).filter((m): m is NonNullable<typeof m> => !!m);
    if (errors.length) return { inputHashes, errors };

    const slots = Object.fromEntries(slotEntries.filter(([, m]) => m)) as Record<string, Media & { analysis: Analysis }>;
    const row: RowInput = { id: raw.id, fields: raw.fields, slots, pool };
    const scores: Prepared["scores"] = {};
    for (const m of [...Object.values(slots), ...pool]) if (m.analysis.scores) scores[m.hash] = m.analysis.scores;
    for (const m of [...Object.values(slots), ...pool]) delete (m as Partial<typeof m>).analysis;

    const reqs = textRequests(t, row);
    if (!reqs.ok) return { inputHashes, errors: reqs.errors };
    const text: Prepared["text"] = {};
    for (const r of reqs.value) text[r.path] = await fitText(r);
    const res: Result<Timeline> = compile(t, row, { scores, text });
    return res.ok ? { inputHashes, timeline: res.value } : { inputHashes, errors: res.errors };
  }
}
