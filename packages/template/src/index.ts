import { z } from "zod";
import {
  CanvasSchema, FONT_FAMILIES, Frame, Hex6, TimelineSchema, stableStringify, zodErrors,
  type Segment, type StructuredError, type TextOverlay, type Timeline,
} from "@nexus/timeline";
import { evaluate, ExpressionError, parseExpression, type Scores } from "./expression.ts";

export * from "./expression.ts";

// ---------- schema ----------

const Id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "Ids start with a letter and use letters, digits, _ or -");
const Unit = z.number().min(0).max(1);

export const TextDeclSchema = z.strictObject({
  text: z.string().min(1),
  font: z.enum(FONT_FAMILIES),
  size: z.union([z.number().int().positive(), z.strictObject({ min: z.number().int().positive(), max: z.number().int().positive() })]),
  color: Hex6,
  position: z.strictObject({ x: Unit, y: Unit }),
  /** Allowed block width as a fraction of canvas width, centered on position.x. */
  width: z.number().gt(0).max(1),
  maxLines: z.number().int().positive(),
  /** Active range relative to the zone start; defaults to the whole zone. */
  frames: z.strictObject({ start: Frame, end: Frame }).optional(),
});

const Fill = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("slot"), slot: Id }),
  z.strictObject({ type: z.literal("score"), maximize: z.string() }),
  z.strictObject({ type: z.literal("color"), color: Hex6 }),
]);

export const TemplateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: Id,
  name: z.string().min(1),
  version: z.string().min(1),
  canvas: CanvasSchema,
  totalFrames: z.number().int().positive().optional(),
  slots: z.array(z.strictObject({ id: Id, kind: z.enum(["video", "image", "audio"]), required: z.boolean() })),
  fields: z.array(z.strictObject({ id: Id, required: z.boolean() })),
  zones: z.array(z.strictObject({ id: Id, frames: z.number().int().positive(), fill: Fill, text: z.array(TextDeclSchema) })).min(1),
  audio: z.strictObject({ slot: Id }).nullable(),
  output: z.string().min(1),
});

export type Template = z.infer<typeof TemplateSchema>;
export type TextDecl = z.infer<typeof TextDeclSchema>;
export type Result<T> = { ok: true; value: T } | { ok: false; errors: StructuredError[] };

const err = (code: string, path: string, message: string, details?: Record<string, unknown>): StructuredError => ({ code, path, message, ...(details && { details }) });
const BINDING = /\{row\.([A-Za-z][A-Za-z0-9_-]*)\}/g;

// ---------- validation (the one validator) ----------

export function parseTemplate(text: string): Result<Template> {
  try {
    return validateTemplate(JSON.parse(text));
  } catch (e) {
    return { ok: false, errors: [err("JSON_INVALID", "", (e as Error).message)] };
  }
}

export function validateTemplate(input: unknown): Result<Template> {
  const parsed = TemplateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
  const t = parsed.data;
  const errors: StructuredError[] = [];
  const { width: W, height: H } = t.canvas;

  for (const key of ["slots", "fields", "zones"] as const)
    t[key].forEach((x, i) => t[key].findIndex((y) => y.id === x.id) < i && errors.push(err("DUPLICATE_ID", `${key}[${i}].id`, `Duplicate id '${x.id}'`)));

  const sum = t.zones.reduce((s, z) => s + z.frames, 0);
  if (t.totalFrames !== undefined && t.totalFrames !== sum)
    errors.push(err("CONFLICTING_DURATION", "totalFrames", `totalFrames ${t.totalFrames} != sum of zone frames ${sum}`, { totalFrames: t.totalFrames, zoneFrames: sum }));

  const slot = (id: string) => t.slots.find((s) => s.id === id);
  const checkBindings = (text: string, path: string) => {
    if (text.replace(BINDING, "").match(/[{}]/)) errors.push(err("BINDING_INVALID", path, "Bindings must look like {row.fieldId}", { text }));
    for (const [, name] of text.matchAll(BINDING))
      if (name !== "id" && !t.fields.some((f) => f.id === name)) errors.push(err("UNKNOWN_FIELD", path, `'{row.${name}}' is not a declared field`, { field: name }));
  };

  t.zones.forEach((zone, i) => {
    const p = `zones[${i}]`;
    if (zone.fill.type === "slot") {
      const s = slot(zone.fill.slot);
      if (!s) errors.push(err("UNKNOWN_SLOT", `${p}.fill.slot`, `Slot '${zone.fill.slot}' is not declared`));
      else if (s.kind === "audio") errors.push(err("SLOT_KIND_MISMATCH", `${p}.fill.slot`, `Zone fill needs a video or image slot, '${s.id}' is audio`));
    }
    if (zone.fill.type === "score")
      try {
        parseExpression(zone.fill.maximize);
      } catch (e) {
        if (!(e instanceof ExpressionError)) throw e;
        errors.push(err("EXPRESSION_INVALID", `${p}.fill.maximize`, e.message, { expression: zone.fill.maximize, position: e.position }));
      }
    zone.text.forEach((d, j) => {
      const tp = `${p}.text[${j}]`;
      checkBindings(d.text, `${tp}.text`);
      if (typeof d.size === "object" && d.size.min > d.size.max) errors.push(err("SIZE_RANGE_INVALID", `${tp}.size`, "size.min must be <= size.max", d.size));
      if (d.frames && !(d.frames.start < d.frames.end && d.frames.end <= zone.frames))
        errors.push(err("TEXT_TIMING_INVALID", `${tp}.frames`, `Text frames must satisfy start < end <= zone frames (${zone.frames})`, { ...d.frames, zoneFrames: zone.frames }));
      const half = (d.width * W) / 2, cx = d.position.x * W;
      if (cx - half < 0 || cx + half > W)
        errors.push(err("TEXT_REGION_OUTSIDE_CANVAS", tp, "Text region (position.x ± width/2) leaves the canvas", { left: cx - half, right: cx + half, canvasWidth: W }));
      if (d.maxLines * lineHeight(minSize(d)) > H) errors.push(err("TEXT_REGION_OUTSIDE_CANVAS", tp, "maxLines at minimum size is taller than the canvas"));
    });
  });

  if (t.audio) {
    const s = slot(t.audio.slot);
    if (!s || s.kind !== "audio") errors.push(err(s ? "SLOT_KIND_MISMATCH" : "UNKNOWN_SLOT", "audio.slot", `audio.slot must reference a declared audio slot`));
  }
  checkBindings(t.output, "output");
  if (!t.output.endsWith(".mp4")) errors.push(err("OUTPUT_NAME_INVALID", "output", "Output pattern must end with .mp4"));

  return errors.length ? { ok: false, errors } : { ok: true, value: t };
}

// ---------- compile inputs ----------

export type Media = { id: string; path: string; hash: string; kind: "video" | "image" | "audio"; /** normalized frame count at template fps */ frames?: number };
export type RowInput = { id: string; fields: Record<string, string>; slots: Record<string, Media>; pool: Media[] };
export type TextFit = { size: number; lines: { text: string; width: number }[] };
export type TextRequest = { path: string; text: string; font: TextDecl["font"]; minSize: number; maxSize: number; maxWidth: number; maxLines: number };
/** Deterministic preprocessing results computed before compile: perception scores (by media hash) and measured text fits (by text path). */
export type Prepared = { scores: Record<string, Scores>; text: Record<string, TextFit | StructuredError> };

// Engine layout constants. Part of the engine contract.
export const lineHeight = (size: number) => Math.floor((size * 5 + 2) / 4); // round-half-up(size * 1.25)
const minSize = (d: TextDecl) => (typeof d.size === "number" ? d.size : d.size.min);
const maxSize = (d: TextDecl) => (typeof d.size === "number" ? d.size : d.size.max);

function bind(text: string, row: RowInput, path: string, errors: StructuredError[]): string {
  return text.replace(BINDING, (_, name: string) => {
    const v = name === "id" ? row.id : row.fields[name];
    if (v === undefined || v === "") errors.push(err("MISSING_BINDING", path, `Row '${row.id}' has no value for '${name}'`, { field: name, rowId: row.id }));
    return v ?? "";
  });
}

/** Text measurements the compiler needs for this row. Uses the same binding resolution as compile. */
export function textRequests(t: Template, row: RowInput): Result<TextRequest[]> {
  const errors: StructuredError[] = [];
  const value = t.zones.flatMap((z, i) =>
    z.text.map((d, j) => {
      const path = `zones[${i}].text[${j}]`;
      return { path, text: bind(d.text, row, `${path}.text`, errors), font: d.font, minSize: minSize(d), maxSize: maxSize(d), maxWidth: Math.round(d.width * t.canvas.width), maxLines: d.maxLines };
    }),
  );
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function checkOutputName(name: string, path = "output"): StructuredError | null {
  const bad = (reason: string) => err("OUTPUT_NAME_INVALID", path, `Output name '${name}' ${reason}`, { name, reason });
  if (/[/\\]/.test(name)) return bad("contains a path separator");
  if (name.startsWith(".") || name.includes("..")) return bad("starts with '.' or contains '..'");
  if (/[<>:"|?*\x00-\x1f]/.test(name)) return bad("contains an illegal character");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) return bad("is a reserved device name");
  if (!/^.+\.mp4$/.test(name) || name.length > 200) return bad("must be 1-200 characters ending in .mp4");
  return null;
}

// ---------- compiler ----------

/** template + normalized inputs + prepared scores/text fits -> timeline. Pure: no clock, no randomness, no I/O. */
export function compile(t: Template, row: RowInput, prep: Prepared): Result<Timeline> {
  const errors: StructuredError[] = [];
  const { width: W, height: H, fps } = t.canvas;

  t.fields.forEach((f, i) => f.required && !row.fields[f.id] && errors.push(err("MISSING_BINDING", `fields[${i}]`, `Required field '${f.id}' is empty`, { field: f.id, rowId: row.id })));
  t.slots.forEach((s, i) => {
    const m = row.slots[s.id];
    if (!m) s.required && errors.push(err("MISSING_BINDING", `slots[${i}]`, `Required slot '${s.id}' has no media`, { slot: s.id, rowId: row.id }));
    else if (m.kind !== s.kind) errors.push(err("SLOT_KIND_MISMATCH", `slots[${i}]`, `Slot '${s.id}' expects ${s.kind}, got ${m.kind} '${m.id}'`));
  });

  const slotIds = new Set(Object.values(row.slots).map((m) => m.id));
  const used = new Set<string>();
  const segments: Segment[] = [];
  const overlays: TextOverlay[] = [];
  let at = 0;

  t.zones.forEach((zone, i) => {
    const p = `zones[${i}]`;
    const span = { startFrame: at, endFrame: at + zone.frames, zone: zone.id };
    const fill = zone.fill;
    const media = (m: Media, path: string): Segment["source"] | null => {
      if (m.kind === "image") return { kind: "image", path: m.path, hash: m.hash };
      if (m.kind !== "video") return errors.push(err("SLOT_KIND_MISMATCH", path, `'${m.id}' is ${m.kind}`)), null;
      if ((m.frames ?? 0) < zone.frames) return errors.push(err("CLIP_TOO_SHORT", path, `'${m.id}' has ${m.frames ?? 0} frames, zone needs ${zone.frames}`, { clip: m.id, clipFrames: m.frames ?? 0, zoneFrames: zone.frames })), null;
      return { kind: "video", path: m.path, hash: m.hash, inFrame: 0 };
    };

    let source: Segment["source"] | null = null;
    if (fill.type === "color") source = { kind: "color", color: fill.color.toUpperCase() };
    else if (fill.type === "slot") source = row.slots[fill.slot] ? media(row.slots[fill.slot], `${p}.fill.slot`) : (errors.push(err("MISSING_BINDING", `${p}.fill.slot`, `Slot '${fill.slot}' has no media`, { slot: fill.slot, rowId: row.id })), null);
    else {
      const expr = parseExpression(fill.maximize);
      const ranked: { m: Media; score: number }[] = [];
      for (const m of row.pool) {
        if (m.kind !== "video" || used.has(m.id) || slotIds.has(m.id) || (m.frames ?? 0) < zone.frames) continue;
        const s = prep.scores[m.hash];
        if (!s) { errors.push(err("SCORES_MISSING", `${p}.fill.maximize`, `No perception scores for '${m.id}'`, { clip: m.id })); continue; }
        const score = evaluate(expr, s);
        if (!Number.isFinite(score)) { errors.push(err("SCORE_NOT_FINITE", `${p}.fill.maximize`, `'${fill.maximize}' is ${score} for '${m.id}'`, { clip: m.id, scores: s })); continue; }
        ranked.push({ m, score });
      }
      // Highest score wins; ties broken by media id (code-unit order, locale independent).
      ranked.sort((a, b) => b.score - a.score || (a.m.id < b.m.id ? -1 : a.m.id > b.m.id ? 1 : 0));
      if (!ranked.length) errors.push(err("NO_CANDIDATE_CLIP", `${p}.fill.maximize`, `No unused clip with >= ${zone.frames} frames for zone '${zone.id}'`, { zoneFrames: zone.frames, poolSize: row.pool.length }));
      else used.add(ranked[0].m.id), (source = media(ranked[0].m, `${p}.fill.maximize`));
    }
    if (source) segments.push({ ...span, source });

    zone.text.forEach((d, j) => {
      const path = `${p}.text[${j}]`;
      const fit = prep.text[path];
      if (!fit) return errors.push(err("TEXT_NOT_MEASURED", path, "Text was not measured before compile"));
      if ("code" in fit) return errors.push(fit);
      const lh = lineHeight(fit.size);
      const top = Math.round(d.position.y * H) - Math.floor((fit.lines.length * lh) / 2);
      if (top < 0 || top + fit.lines.length * lh > H)
        return errors.push(err("TEXT_DOES_NOT_FIT", path, `Text block of ${fit.lines.length} lines at ${fit.size}px leaves the canvas vertically`, { top, height: fit.lines.length * lh, canvasHeight: H }));
      overlays.push({
        id: path,
        startFrame: at + (d.frames?.start ?? 0),
        endFrame: at + (d.frames?.end ?? zone.frames),
        font: d.font,
        size: fit.size,
        color: d.color.toUpperCase(),
        lines: fit.lines.map((l, k) => ({ text: l.text, width: l.width, x: Math.round(d.position.x * W), baseline: top + k * lh + Math.floor((lh * 4) / 5) })),
      });
    });
    at += zone.frames;
  });

  let audio: Timeline["audio"] = null;
  if (t.audio && row.slots[t.audio.slot]) {
    const m = row.slots[t.audio.slot];
    audio = { path: m.path, hash: m.hash, inFrame: 0 };
  }

  const output = bind(t.output, row, "output", errors);
  const nameErr = checkOutputName(output);
  if (nameErr) errors.push(nameErr);
  if (errors.length) return { ok: false, errors };

  const timeline = TimelineSchema.safeParse({ version: 1, canvas: { width: W, height: H, fps }, totalFrames: at, segments, overlays, audio, output });
  return timeline.success ? { ok: true, value: timeline.data } : { ok: false, errors: zodErrors(timeline.error, "TIMELINE_INVALID") };
}

export const serializeTimeline = (t: Timeline) => stableStringify(t);
