import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FONT_FAMILIES, StructuredError } from "@nexus/timeline";
import type { TextFit, TextRequest } from "@nexus/template";
import { ffmpeg, NexusError, parseMetadata } from "./ffmpeg.ts";

type Font = (typeof FONT_FAMILIES)[number];
export const FONTS_DIR = process.env.NEXUS_FONTS_DIR ?? fileURLToPath(new URL("../fonts/", import.meta.url));
export const FONT_FILES: Record<Font, string> = { Inter: "Inter.ttf" };

// ---------- font preflight ----------
// drawtext loads `fontfile` directly through FreeType (no fontconfig lookup), so the face used is the file we pass.
// The preflight proves that file exists and really is the requested family, so a wrong/missing file is a render error.

/** Family names (nameID 1 and 16) from an OpenType/TrueType `name` table. */
export function fontFamilies(buf: Buffer): string[] {
  if (buf.length < 12) return [];
  const names: string[] = [];
  for (let i = 0, n = buf.readUInt16BE(4); i < n; i++) {
    const rec = 12 + 16 * i;
    if (buf.toString("latin1", rec, rec + 4) !== "name") continue;
    const off = buf.readUInt32BE(rec + 8), strings = off + buf.readUInt16BE(off + 4);
    for (let j = 0, count = buf.readUInt16BE(off + 2); j < count; j++) {
      const r = off + 6 + 12 * j, platform = buf.readUInt16BE(r), id = buf.readUInt16BE(r + 6);
      if (id !== 1 && id !== 16) continue;
      const raw = Buffer.from(buf.subarray(strings + buf.readUInt16BE(r + 10), strings + buf.readUInt16BE(r + 10) + buf.readUInt16BE(r + 8)));
      names.push(platform === 1 ? raw.toString("latin1") : raw.swap16().toString("utf16le"));
    }
  }
  return [...new Set(names)];
}

export async function preflightFont(family: Font, dir = FONTS_DIR): Promise<string> {
  const file = join(dir, FONT_FILES[family] ?? "");
  const fail = (code: string, message: string, details?: object) => new NexusError({ code, path: "font", message, details: { family, file, ...details } });
  if (!FONT_FILES[family] || !existsSync(file)) throw fail("FONT_MISSING", `Bundled font '${family}' not found`);
  const found = fontFamilies(await readFile(file));
  if (!found.includes(family)) throw fail("FONT_SUBSTITUTED", `Font file for '${family}' contains ${JSON.stringify(found)}`, { found });
  return file;
}

// ---------- job dirs & drawtext ----------

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** Same algorithm as @nexus/perception's hashFile: sha256 of the file's current bytes. */
export async function hashFileContent(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}

/** Job directory with a `fonts` link so filter graphs only ever reference short relative paths. */
export async function prepareJobDir(dir: string) {
  await mkdir(dir, { recursive: true });
  const link = join(dir, "fonts");
  // A job dir can be reused across engine versions/runs; a link left pointing at a stale FONTS_DIR
  // (moved install, different NEXUS_FONTS_DIR) would silently serve the wrong fonts. Verify the target.
  const stale = existsSync(link) && (await lstat(link)).isSymbolicLink() ? (await readlink(link)) !== FONTS_DIR : existsSync(link);
  if (stale) await rm(link, { recursive: true, force: true });
  if (!existsSync(link)) await symlink(FONTS_DIR, link, "dir");
}

/** Writes text to a content-addressed file in the job dir (avoids filtergraph text escaping). */
export async function textFile(dir: string, text: string) {
  const name = `t-${sha256(text).slice(0, 24)}.txt`;
  if (!existsSync(join(dir, name))) await writeFile(join(dir, name), text);
  return name;
}

export const drawtext = (font: Font, size: number, color: string, file: string, x: string, y: string, enable = "") =>
  `drawtext=fontfile=fonts/${FONT_FILES[font]}:textfile=${file}:expansion=none:fontsize=${size}:fontcolor=0x${color}:x=${x}:y=${y}${enable && `:enable='${enable}'`}`;

// ---------- measurement ----------

/** Ink width in px of each string rendered with the real font. One ffmpeg run; bbox metadata is read from stdout. */
export async function measureTexts(texts: string[], font: Font, size: number): Promise<number[]> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-measure-"));
  try {
    await prepareJobDir(dir);
    const w = Math.min(16384, 2 * Math.ceil((size * (Math.max(...texts.map((t) => t.length)) + 4)) / 2));
    const h = 2 * Math.ceil((size * 3) / 2);
    const files = await Promise.all(texts.map((t) => textFile(dir, t)));
    const graph = files.map((f, i) => `color=black:s=${w}x${h}:r=1:d=1,format=gray,${drawtext(font, size, "FFFFFF", f, String(size), String(size))},bbox=min_val=64,metadata=add:key=nexus.i:value=${i}[m${i}]`);
    graph.push(`${files.map((_, i) => `[m${i}]`).join("")}concat=n=${files.length}:v=1:a=0,metadata=print:file=-[out]`);
    await writeFile(join(dir, "measure.txt"), graph.join(";\n"));
    const { stdout } = await ffmpeg(["-filter_complex_script", "measure.txt", "-map", "[out]", "-f", "null", "-"], { cwd: dir });
    const widths = texts.map(() => 0);
    for (const m of parseMetadata(String(stdout))) if (m["lavfi.bbox.w"]) widths[Number(m["nexus.i"])] = Number(m["lavfi.bbox.w"]);
    return widths;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type Attempt = { lines: TextFit["lines"]; tooWide?: { word: string; width: number } };

/** Greedy word wrap using rendered widths of every candidate line. */
async function layout(req: TextRequest, size: number): Promise<Attempt> {
  const paragraphs = req.text.split("\n").map((p) => p.trim().split(/\s+/).filter(Boolean));
  // ponytail: measures all O(words²) contiguous spans per size in one ffmpeg call; fine for headlines, cap spans if long copy appears.
  const spans = [...new Set(paragraphs.flatMap((ws) => ws.flatMap((_, i) => ws.slice(i).map((__, k) => ws.slice(i, i + k + 1).join(" ")))))];
  // Whitespace-only (or empty) text has no words to measure. An n=0 concat filter is an invalid ffmpeg
  // invocation, so short-circuit to the empty-lines attempt instead of calling measureTexts.
  if (spans.length === 0) return { lines: [] };
  const widths = new Map((await measureTexts(spans, req.font, size)).map((w, i) => [spans[i], w]));
  const lines: TextFit["lines"] = [];
  for (const ws of paragraphs) {
    for (let i = 0; i < ws.length; ) {
      let j = i + 1;
      while (j < ws.length && widths.get(ws.slice(i, j + 1).join(" "))! <= req.maxWidth) j++;
      const text = ws.slice(i, j).join(" ");
      if (widths.get(text)! > req.maxWidth) return { lines, tooWide: { word: text, width: widths.get(text)! } };
      lines.push({ text, width: widths.get(text)! });
      i = j;
    }
  }
  return { lines };
}

/** Largest size in [minSize, maxSize] whose wrapped block fits maxWidth and maxLines. Never shrinks below min, truncates or rewrites. */
export async function fitText(req: TextRequest): Promise<TextFit | StructuredError> {
  await preflightFont(req.font);
  const tried = new Map<number, Attempt>();
  const attempt = async (size: number) => tried.get(size) ?? tried.set(size, await layout(req, size)).get(size)!;
  const fits = (a: Attempt) => !a.tooWide && a.lines.length > 0 && a.lines.length <= req.maxLines;

  const atMin = await attempt(req.minSize);
  if (!fits(atMin)) {
    const base = { code: "TEXT_DOES_NOT_FIT", path: req.path };
    if (atMin.tooWide)
      return { ...base, message: `'${atMin.tooWide.word}' is ${atMin.tooWide.width}px wide at minimum font size ${req.minSize}px but the text region is ${req.maxWidth}px.`, details: { word: atMin.tooWide.word, wordWidth: atMin.tooWide.width, maxWidth: req.maxWidth, minimumFontSize: req.minSize } };
    if (!atMin.lines.length) return { ...base, code: "TEXT_EMPTY", message: "Text is empty after binding." };
    return { ...base, message: `Text requires ${atMin.lines.length} lines at minimum font size ${req.minSize}px but maxLines is ${req.maxLines}.`, details: { requiredLines: atMin.lines.length, maxLines: req.maxLines, minimumFontSize: req.minSize, maxWidth: req.maxWidth } };
  }
  // ponytail: binary search assumes fit is monotone in size (true for greedy wrap barring hinting quirks at a 1px boundary).
  let [lo, hi] = [req.minSize, req.maxSize];
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(await attempt(mid))) lo = mid;
    else hi = mid - 1;
  }
  return { size: lo, lines: (await attempt(lo)).lines };
}
