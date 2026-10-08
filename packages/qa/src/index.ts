import { assertFfmpegVersion, ffmpeg, ffprobe } from "@nexus/renderer/ffmpeg";
import { framesToSamples, type Timeline } from "@nexus/timeline";

export type QACheck = { name: string; passed: boolean; expected?: unknown; actual?: unknown };
export type QAResult = { passed: boolean; checks: QACheck[] };

const AUDIO_SAMPLE_RATE = 48000;

/** Luma contrast (max-min, 0-255) of the frame region [x0,y0)-[x1,y1) at `atFrame`. Any painted glyph against
 *  its background shows up as contrast regardless of text/background color polarity; a region with none was
 *  never actually drawn on, whatever the declared coordinates say. */
async function regionInk(file: string, fps: Timeline["canvas"]["fps"], atFrame: number, x0: number, y0: number, x1: number, y1: number): Promise<number> {
  const rate = `${fps.numerator}/${fps.denominator}`;
  const w = Math.max(1, Math.round(x1 - x0)), h = Math.max(1, Math.round(y1 - y0));
  const graph = `fps=${rate},select='eq(n\\,${atFrame})',crop=${w}:${h}:${Math.round(x0)}:${Math.round(y0)},format=gray,signalstats,metadata=print:file=-`;
  const { stdout } = await ffmpeg(["-i", file, "-vf", graph, "-frames:v", "1", "-f", "null", "-"]);
  const min = /lavfi\.signalstats\.YMIN=([\d.]+)/.exec(String(stdout));
  const max = /lavfi\.signalstats\.YMAX=([\d.]+)/.exec(String(stdout));
  return min && max ? Number(max[1]) - Number(min[1]) : 0;
}

/** Post-render validation. Reports failures; never repairs output. */
export async function runQA(t: Timeline, file: string): Promise<QAResult> {
  await assertFfmpegVersion();
  const checks: QACheck[] = [];
  const check = (name: string, expected: unknown, actual: unknown) => checks.push({ name, passed: JSON.stringify(expected) === JSON.stringify(actual), expected, actual });
  const { width: W, height: H, fps } = t.canvas;

  let streams: any[] = [];
  try {
    // -count_frames decodes every frame; any decode error lands on stderr at -v error.
    const r = await ffprobe(["-count_frames", "-show_streams", "-of", "json", file]);
    streams = JSON.parse(String(r.stdout)).streams;
    check("decode", "", String(r.stderr).trim());
  } catch (e) {
    check("decode", "ok", (e as Error).message.split("\n")[0]);
  }
  const v = streams.find((s) => s.codec_type === "video");
  check("frameCount", t.totalFrames, v ? Number(v.nb_read_frames) : null);
  check("dimensions", [W, H], v ? [v.width, v.height] : null);
  check("frameRate", `${fps.numerator}/${fps.denominator}`, v?.r_frame_rate ?? null);
  const a = streams.find((s) => s.codec_type === "audio");
  check("audioStream", !!t.audio, !!a);

  if (t.audio) {
    // Exact sample count, not just "has an audio stream": catches off-by-one apad/atrim boundaries that a
    // presence-only check would miss.
    const expectedSamples = framesToSamples(t.totalFrames, fps, AUDIO_SAMPLE_RATE);
    const actualSamples = a ? Math.round(Number(a.duration) * AUDIO_SAMPLE_RATE) : null;
    check("audioDuration", expectedSamples, actualSamples);
  }

  const overflow = t.overlays.flatMap((o) =>
    o.lines.filter((l) => l.x - l.width / 2 < 0 || l.x + l.width / 2 > W || l.baseline - o.size < 0 || l.baseline > H).map((l) => `${o.id}: ${l.text}`),
  );
  check("textFit", [], overflow);

  // Metadata-only checks above only prove the declared box is in-bounds; they can't catch a font that failed to
  // paint, a wrong color burned transparent, or a position computed off by a full line. Decode the frame at the
  // middle of each overlay's active range and confirm ink actually landed inside its declared box.
  const missingOverlays: string[] = [];
  if (v)
    for (const o of t.overlays)
      for (const l of o.lines) {
        if (!l.width) continue; // nothing to paint
        const atFrame = Math.min(t.totalFrames - 1, Math.floor((o.startFrame + o.endFrame) / 2));
        const [x0, x1] = [Math.max(0, l.x - l.width / 2), Math.min(W, l.x + l.width / 2)];
        const [y0, y1] = [Math.max(0, l.baseline - o.size), Math.min(H, l.baseline)];
        if (x1 <= x0 || y1 <= y0) continue;
        const ink = await regionInk(file, fps, atFrame, x0, y0, x1, y1);
        if (ink < 10) missingOverlays.push(`${o.id}: ${l.text}`);
      }
  check("overlayPixels", [], missingOverlays);

  let at = 0;
  const tiled = t.segments.every((s) => s.startFrame === at && (at = s.endFrame) > s.startFrame) && at === t.totalFrames;
  check("timelineConsistency", true, tiled && t.overlays.every((o) => o.endFrame <= t.totalFrames));

  return { passed: checks.every((c) => c.passed), checks };
}
