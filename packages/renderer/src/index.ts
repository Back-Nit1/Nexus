import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { framesToSamples, stableStringify, TimelineSchema, type Canvas, type Segment, type Timeline } from "@nexus/timeline";
import { assertFfmpegVersion, ENGINE_VERSION, ffmpeg, FFMPEG_VERSION } from "./ffmpeg.ts";
import { drawtext, prepareJobDir, preflightFont, sha256, textFile } from "./text.ts";

export { ENGINE_VERSION, FFMPEG_VERSION, NexusError, ffmpeg, ffprobe, parseMetadata } from "./ffmpeg.ts";
export { fitText, fontFamilies, measureTexts, preflightFont, FONTS_DIR } from "./text.ts";

export type RenderOptions = { jobDir: string; cacheDir: string; output: string; signal?: AbortSignal; onProgress?: (done: number, total: number) => void };
export type RenderResult = { output: string; engine: { appVersion: string; ffmpegVersion: string }; cacheHits: number };

/**
 * Segment cache key. Field order is a compatibility surface: NEVER reorder, only append.
 * [sourceHash, sourceInFrame, frameCount, recipe, canvas, engineVersion, ffmpegVersion]
 */
export const segmentCacheKey = (sourceHash: string, inFrame: number, frames: number, recipe: unknown, canvas: Canvas, engine = ENGINE_VERSION, ff = FFMPEG_VERSION) =>
  sha256(stableStringify([sourceHash, inFrame, frames, recipe, canvas, engine, ff], 0));

const bitexact = ["-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1"];
let partials = 0;

/** Render one silent picture segment (cover-fit, overlays burned in) into the cache. Returns true on cache hit. */
async function renderSegment(t: Timeline, seg: Segment, o: RenderOptions): Promise<[string, boolean]> {
  const { width: W, height: H, fps } = t.canvas;
  const rate = `${fps.numerator}/${fps.denominator}`;
  const frames = seg.endFrame - seg.startFrame;
  const src = seg.source;
  const overlays = t.overlays
    .filter((ov) => ov.startFrame < seg.endFrame && ov.endFrame > seg.startFrame)
    .map((ov) => ({ from: Math.max(ov.startFrame, seg.startFrame) - seg.startFrame, to: Math.min(ov.endFrame, seg.endFrame) - seg.startFrame, font: ov.font, size: ov.size, color: ov.color, lines: ov.lines }));
  const recipe = { fit: "cover", overlays };
  const key = segmentCacheKey(src.kind === "color" ? `color:${src.color}` : src.hash, src.kind === "video" ? src.inFrame : 0, frames, recipe, t.canvas);
  const out = join(o.cacheDir, `${key}.mp4`);
  if (existsSync(out)) return [out, true];

  const input = src.kind === "video" ? ["-i", src.path] : src.kind === "image" ? ["-loop", "1", "-i", src.path] : ["-f", "lavfi", "-i", `color=c=0x${src.color}:s=${W}x${H}:r=${rate}`];
  const draws: string[] = [];
  for (const ov of recipe.overlays)
    for (const line of ov.lines) draws.push(drawtext(ov.font, ov.size, ov.color, await textFile(o.jobDir, line.text), `${line.x}-text_w/2`, `${line.baseline}-ascent`, `between(n,${ov.from},${ov.to - 1})`));
  // fps normalization happens BEFORE trimming, so VFR sources map to exact normalized frames; length is -frames:v, never -t.
  const chain = [`fps=${rate}`, `trim=start_frame=${src.kind === "video" ? src.inFrame : 0}`, "setpts=N/FRAME_RATE/TB", `scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`, "setsar=1", ...draws, "format=yuv420p"];
  const script = `seg-${key}.txt`;
  await writeFile(join(o.jobDir, script), `[0:v]${chain.join(",\n")}[v]`);
  const partial = `${out}.${process.pid}-${partials++}.partial`; // unique: concurrent rows may render the same cached segment
  await ffmpeg([...input, "-filter_complex_script", script, "-map", "[v]", "-frames:v", String(frames), "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-video_track_timescale", String(fps.numerator), ...bitexact, "-f", "mp4", partial], { cwd: o.jobDir, signal: o.signal });
  await rename(partial, out);
  return [out, false];
}

/** Timeline -> mp4. Makes no creative decisions: every cut, text and position comes from the validated timeline. */
export async function render(input: Timeline, o: RenderOptions): Promise<RenderResult> {
  const t = TimelineSchema.parse(input);
  await assertFfmpegVersion();
  for (const font of new Set(t.overlays.map((x) => x.font))) await preflightFont(font);
  await prepareJobDir(o.jobDir);
  await mkdir(o.cacheDir, { recursive: true });
  await mkdir(dirname(o.output), { recursive: true });

  let hits = 0;
  const files: string[] = [];
  for (const seg of t.segments) {
    const [file, hit] = await renderSegment(t, seg, o);
    files.push(file);
    hits += +hit;
    o.onProgress?.(files.length, t.segments.length + 1);
  }

  // Silent segments are concatenated once; audio is built as one continuous track and muxed once (no per-cut AAC priming drift).
  await writeFile(join(o.jobDir, "concat.txt"), files.map((f) => `file '${f.replaceAll("'", "'\\''")}'`).join("\n") + "\n");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", "concat.txt", "-map", "0:v", "-c", "copy", "-video_track_timescale", String(t.canvas.fps.numerator), ...bitexact, "-f", "mp4", "picture.mp4"], { cwd: o.jobDir, signal: o.signal });

  const partial = `${o.output}.partial`;
  const tail = ["-movflags", "+faststart", "-f", "mp4", partial];
  if (t.audio) {
    const start = framesToSamples(t.audio.inFrame, t.canvas.fps, 48000), len = framesToSamples(t.totalFrames, t.canvas.fps, 48000);
    await writeFile(join(o.jobDir, "audio.txt"), `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=${start},asetpts=N/SR/TB,apad=whole_len=${len},atrim=end_sample=${len}[a]`);
    await ffmpeg(["-i", "picture.mp4", "-i", t.audio.path, "-filter_complex_script", "audio.txt", "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", ...bitexact, "-flags:a", "+bitexact", ...tail], { cwd: o.jobDir, signal: o.signal });
  } else {
    await ffmpeg(["-i", "picture.mp4", "-map", "0:v", "-c", "copy", ...bitexact, ...tail], { cwd: o.jobDir, signal: o.signal });
  }
  await rename(partial, o.output);
  o.onProgress?.(t.segments.length + 1, t.segments.length + 1);
  return { output: o.output, engine: { appVersion: ENGINE_VERSION, ffmpegVersion: FFMPEG_VERSION }, cacheHits: hits };
}
