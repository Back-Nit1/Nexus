import { ffprobe } from "@nexus/renderer/ffmpeg";
import type { Timeline } from "@nexus/timeline";

export type QACheck = { name: string; passed: boolean; expected?: unknown; actual?: unknown };
export type QAResult = { passed: boolean; checks: QACheck[] };

/** Post-render validation. Reports failures; never repairs output. */
export async function runQA(t: Timeline, file: string): Promise<QAResult> {
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
  check("audioStream", !!t.audio, streams.some((s) => s.codec_type === "audio"));

  const overflow = t.overlays.flatMap((o) =>
    o.lines.filter((l) => l.x - l.width / 2 < 0 || l.x + l.width / 2 > W || l.baseline - o.size < 0 || l.baseline > H).map((l) => `${o.id}: ${l.text}`),
  );
  check("textFit", [], overflow);

  let at = 0;
  const tiled = t.segments.every((s) => s.startFrame === at && (at = s.endFrame) > s.startFrame) && at === t.totalFrames;
  check("timelineConsistency", true, tiled && t.overlays.every((o) => o.endFrame <= t.totalFrames));

  return { passed: checks.every((c) => c.passed), checks };
}
