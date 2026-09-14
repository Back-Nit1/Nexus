import { z } from "zod";

// ---------- exact time ----------

export type Rational = { numerator: number; denominator: number };

/** floor((2a + b) / 2b) for a >= 0, b > 0: round-half-up of a/b in exact integer arithmetic. */
const roundHalfUp = (a: bigint, b: bigint) => (2n * a + b) / (2n * b);

/** Parse a non-negative decimal ("2.05", 2.05, "1e-3") into an exact fraction. Numbers use their shortest repr. */
function decimal(value: string | number): [bigint, bigint] {
  const m = /^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value).trim());
  if (!m || (!m[1] && !m[2])) throw new RangeError(`Not a non-negative decimal: ${value}`);
  const frac = m[2] ?? "";
  const exp = Number(m[3] ?? 0) - frac.length;
  const digits = BigInt((m[1] || "0") + frac);
  return exp >= 0 ? [digits * 10n ** BigInt(exp), 1n] : [digits, 10n ** BigInt(-exp)];
}

/** Seconds (human input) -> integer frames, exact, round-half-up. */
export function secondsToFrames(seconds: string | number, fps: Rational): number {
  const [n, d] = decimal(seconds);
  return Number(roundHalfUp(n * BigInt(fps.numerator), d * BigInt(fps.denominator)));
}

/** Frames -> sample count at `rate` Hz, exact, round-half-up. */
export function framesToSamples(frames: number, fps: Rational, rate: number): number {
  return Number(roundHalfUp(BigInt(frames) * BigInt(rate) * BigInt(fps.denominator), BigInt(fps.numerator)));
}

/** Frames -> "HH:MM:SS.mmm" for display. Milliseconds are round-half-up of the exact instant. */
export function framesToTimestamp(frames: number, fps: Rational): string {
  const ms = Number(roundHalfUp(BigInt(frames) * 1000n * BigInt(fps.denominator), BigInt(fps.numerator)));
  const p = (v: number, w = 2) => String(v).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
}

// ---------- errors ----------

export type StructuredError = { code: string; path: string; message: string; details?: Record<string, unknown> };

export const zodErrors = (e: z.ZodError, code = "SCHEMA_INVALID"): StructuredError[] =>
  e.issues.map((i) => ({
    code: i.code === "unrecognized_keys" ? "UNSUPPORTED_FIELD" : code,
    path: i.path.reduce<string>((s, k) => (typeof k === "number" ? `${s}[${k}]` : s ? `${s}.${k}` : String(k)), ""),
    message: i.message,
  }));

// ---------- schema ----------

export const FONT_FAMILIES = ["Inter"] as const;
export const Frame = z.number().int().nonnegative();
export const Hex6 = z.string().regex(/^[0-9A-Fa-f]{6}$/, "Color must be six hex digits, e.g. FFFFFF");
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const RationalSchema = z.strictObject({ numerator: z.number().int().positive(), denominator: z.number().int().positive() });
const Even = z.number().int().positive().refine((v) => v % 2 === 0, "Must be even (yuv420p)");
export const CanvasSchema = z.strictObject({ width: Even, height: Even, fps: RationalSchema });

const Source = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("video"), path: z.string().min(1), hash: Sha256, inFrame: Frame }),
  z.strictObject({ kind: z.literal("image"), path: z.string().min(1), hash: Sha256 }),
  z.strictObject({ kind: z.literal("color"), color: Hex6 }),
]);

const Span = { startFrame: Frame, endFrame: Frame };
const spanOk = (s: { startFrame: number; endFrame: number }) => s.endFrame > s.startFrame;

export const SegmentSchema = z.strictObject({ ...Span, zone: z.string(), source: Source }).refine(spanOk, "endFrame must be > startFrame");

export const TextOverlaySchema = z
  .strictObject({
    ...Span,
    id: z.string(),
    font: z.enum(FONT_FAMILIES),
    size: z.number().int().positive(),
    color: Hex6,
    /** Each line is centered on x (px); baseline is the text baseline (px). width is the measured ink width. */
    lines: z.array(z.strictObject({ text: z.string().min(1), x: z.number().int(), baseline: z.number().int(), width: Frame })).min(1),
  })
  .refine(spanOk, "endFrame must be > startFrame");

export const AudioSchema = z.strictObject({ path: z.string().min(1), hash: Sha256, inFrame: Frame });

export const TimelineSchema = z
  .strictObject({
    version: z.literal(1),
    canvas: CanvasSchema,
    totalFrames: z.number().int().positive(),
    segments: z.array(SegmentSchema).min(1),
    overlays: z.array(TextOverlaySchema),
    audio: AudioSchema.nullable(),
    output: z.string().min(1),
  })
  .superRefine((t, ctx) => {
    let at = 0;
    t.segments.forEach((s, i) => {
      if (s.startFrame !== at)
        ctx.addIssue({ code: "custom", path: ["segments", i, "startFrame"], message: `${s.startFrame < at ? "Overlap" : "Gap"}: expected startFrame ${at}, got ${s.startFrame}` });
      at = s.endFrame;
    });
    if (at !== t.totalFrames) ctx.addIssue({ code: "custom", path: ["segments"], message: `Picture track ends at ${at}, totalFrames is ${t.totalFrames}` });
    t.overlays.forEach((o, i) => {
      if (o.endFrame > t.totalFrames) ctx.addIssue({ code: "custom", path: ["overlays", i, "endFrame"], message: "Overlay ends after totalFrames" });
    });
  });

export type Canvas = z.infer<typeof CanvasSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type TextOverlay = z.infer<typeof TextOverlaySchema>;
export type Timeline = z.infer<typeof TimelineSchema>;

// ---------- serialization ----------

/** JSON with recursively sorted object keys: byte-stable for equal values. */
export function stableStringify(value: unknown, indent = 2): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as any)[k])])) : v;
  return JSON.stringify(sort(value), null, indent) + "\n";
}
