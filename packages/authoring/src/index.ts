// AI template authoring. The ONLY package allowed to reach a model. Nothing in render/compile/batch/QA imports it
// (enforced by packages/batch/test/ai-boundary.test.ts). The model drafts; the one real validator decides.
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { validateTemplate, type Template } from "@nexus/template";
import { FONT_FAMILIES, secondsToFrames } from "@nexus/timeline";

export type DraftResult =
  | { status: "valid"; template: Template; validations: number }
  | { status: "no_template"; message: string; validations: number };

const EXAMPLE: Template = {
  schemaVersion: 1, id: "promo-short", name: "Promo short", version: "1.0.0",
  canvas: { width: 1080, height: 1920, fps: { numerator: 30, denominator: 1 } },
  totalFrames: 150,
  slots: [{ id: "hookClip", kind: "video", required: true }, { id: "music", kind: "audio", required: false }],
  fields: [{ id: "headline", required: true }, { id: "slug", required: true }],
  zones: [
    { id: "hook", frames: 60, fill: { type: "slot", slot: "hookClip" }, text: [{ text: "{row.headline}", font: "Inter", size: { min: 42, max: 64 }, color: "FFFFFF", position: { x: 0.5, y: 0.18 }, width: 0.85, maxLines: 2 }] },
    { id: "broll", frames: 90, fill: { type: "score", maximize: "motion * sharpness" }, text: [] },
  ],
  audio: { slot: "music" },
  output: "{row.id}-{row.slug}.mp4",
};

const SYSTEM = `You author Nexus video templates (pure JSON). A template is compiled deterministically; no model runs at render time.

Rules:
- All timing is integer frames. Convert seconds with the seconds_to_frames tool; never guess.
- canvas: even width/height, fps as {numerator, denominator} (29.97 = 30000/1001). Vertical reel default 1080x1920 @ 30/1.
- zones are ordered, each with integer "frames" and a fill: {"type":"slot","slot":<video|image slot id>} | {"type":"score","maximize":<expr>} | {"type":"color","color":"RRGGBB"}.
- Score expressions use only variables motion, sharpness, brightness and operators + - * / ( ). Scored clips are never reused.
- text[]: text may bind fields with {row.fieldId} (and {row.id}); font one of ${JSON.stringify(FONT_FAMILIES)}; size int or {min,max}; color six hex digits; position {x,y} in 0..1 (block center); width 0..1 of canvas; maxLines; optional frames {start,end} relative to the zone.
- slots: {id, kind: video|image|audio, required}; fields: {id, required}; audio: {"slot": <audio slot>} or null; output: filename pattern ending .mp4.
- totalFrames is optional; if present it must equal the zone sum.
- Every object is strict: no extra keys.

Example valid template:
${JSON.stringify(EXAMPLE)}

Process: draft, call validate_template, fix every returned error by its path/code, repeat until it returns ok:true. Then reply with one short sentence.
If the request lacks information you cannot sensibly default (e.g. no durations at all), do not call the validator; reply explaining exactly what is missing.`;

export async function draftTemplate(description: string, opts: { client?: Anthropic; maxIterations?: number } = {}): Promise<DraftResult> {
  const client = opts.client ?? new Anthropic();
  let last: Template | undefined;
  let validations = 0;

  const validate = betaTool({
    name: "validate_template",
    description: "Validate a complete Nexus template with the engine's validator. Returns {ok:true} or {ok:false, errors:[{code,path,message,details}]}.",
    inputSchema: { type: "object", properties: { template: { type: "object" } }, required: ["template"], additionalProperties: false },
    run: async (input: { template: unknown }) => {
      validations++;
      const r = validateTemplate(input.template);
      last = r.ok ? r.value : undefined;
      return JSON.stringify(r.ok ? { ok: true } : { ok: false, errors: r.errors });
    },
  });
  const toFrames = betaTool({
    name: "seconds_to_frames",
    description: "Exact seconds -> integer frames at a rational fps (round half up).",
    inputSchema: { type: "object", properties: { seconds: { type: "string" }, numerator: { type: "integer" }, denominator: { type: "integer" } }, required: ["seconds", "numerator", "denominator"], additionalProperties: false },
    run: async (i: { seconds: string; numerator: number; denominator: number }) => String(secondsToFrames(i.seconds, i)),
  });

  const final = await client.beta.messages.toolRunner({
    model: "claude-opus-5",
    max_tokens: 16000,
    max_iterations: opts.maxIterations ?? 12,
    system: SYSTEM,
    tools: [validate, toFrames],
    messages: [{ role: "user", content: description }],
    // Server-side refusal fallback (routes a declined request to a fallback model inside the same call).
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // ponytail: installed SDK types only know the array form of `fallbacks`; the "default" form is newer than the typings.
  } as unknown as Parameters<typeof client.beta.messages.toolRunner>[0]);

  const text = final.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
  if (last && final.stop_reason !== "refusal") return { status: "valid", template: last, validations };
  return { status: "no_template", message: text || `Stopped: ${final.stop_reason}`, validations };
}
