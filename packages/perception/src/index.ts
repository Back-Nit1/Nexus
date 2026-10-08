import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { assertFfmpegVersion, ffmpeg, ffprobe, NexusError, parseMetadata } from "@nexus/renderer/ffmpeg";
import type { Media, Scores } from "@nexus/template";
import type { Rational } from "@nexus/timeline";

export type Analysis = {
  kind: Media["kind"];
  width: number;
  height: number;
  /** normalized frames at fps (video only, including animated stills reclassified as video) */
  frames?: number;
  scores?: Scores;
  /** true for a multi-frame image codec (animated gif/webp/apng), reclassified as kind "video" so it animates on render instead of being frozen on frame 0 */
  animated?: boolean;
};

export async function hashFile(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}

const IMAGE_CODECS = new Set(["png", "mjpeg", "jpeg2000", "webp", "bmp", "tiff", "gif"]);
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Deterministic media properties. Scores are means over fps-normalized frames downscaled to 128x72 gray, in [0, 1]:
 * brightness = mean luma, motion = mean abs frame difference, sharpness = mean edge magnitude.
 */
export async function analyze(path: string, fps: Rational): Promise<Analysis> {
  await assertFfmpegVersion();
  let probe: any;
  try {
    probe = JSON.parse(String((await ffprobe(["-show_streams", "-of", "json", path])).stdout));
  } catch (e) {
    throw new NexusError({ code: "MEDIA_CORRUPT", path, message: `Could not probe ${path}: ${(e as Error).message.split("\n")[0]}`, details: { file: path } });
  }
  const streams: any[] = probe.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  if (!v) {
    if (streams.some((s) => s.codec_type === "audio")) return { kind: "audio", width: 0, height: 0 };
    throw new NexusError({ code: "MEDIA_UNSUPPORTED", path, message: `${path} has no video or audio stream`, details: { file: path } });
  }
  // Phone footage can carry a rotation tag (display matrix side data, or legacy `tags.rotate`); applying it
  // before cover-crop is not yet implemented, so refuse clearly rather than silently cropping sideways footage.
  const rotateTag = Number(v.tags?.rotate ?? 0);
  const rotateMatrix = (v.side_data_list ?? []).find((d: any) => d.side_data_type === "Display Matrix")?.rotation;
  const rotation = rotateMatrix !== undefined ? Number(rotateMatrix) : rotateTag;
  if (Number.isFinite(rotation) && ((rotation % 360) + 360) % 360 !== 0)
    throw new NexusError({ code: "ROTATION_UNSUPPORTED", path, message: `${path} declares a ${rotation}° rotation; rotation metadata is not yet applied before cover-crop`, details: { file: path, rotation } });
  const isImageCodec = IMAGE_CODECS.has(v.codec_name);
  const nbFrames = Number(v.nb_frames);
  const animated = isImageCodec && Number.isFinite(nbFrames) && nbFrames > 1;
  const kind = isImageCodec && !animated ? "image" : "video";
  const graph = [
    `[0:v]fps=${fps.numerator}/${fps.denominator},scale=128:72:flags=area,format=gray,split=3[a][b][c]`,
    "[a]signalstats,metadata=add:key=nexus.m:value=brightness[a1]",
    "[b]tblend=all_mode=difference,signalstats,metadata=add:key=nexus.m:value=motion[b1]",
    "[c]edgedetect=mode=wires,format=gray,signalstats,metadata=add:key=nexus.m:value=sharpness[c1]",
    "[a1][b1][c1]concat=n=3:v=1:a=0,metadata=print:file=-[out]",
  ].join(";");
  const { stdout } = await ffmpeg(["-i", path, "-filter_complex", graph, "-map", "[out]", "-f", "null", "-"]);
  const sums = { brightness: [0, 0], motion: [0, 0], sharpness: [0, 0] } as Record<keyof Scores, [number, number]>;
  for (const m of parseMetadata(String(stdout))) {
    const s = sums[m["nexus.m"] as keyof Scores];
    if (s && m["lavfi.signalstats.YAVG"] !== undefined) (s[0] += Number(m["lavfi.signalstats.YAVG"])), s[1]++;
  }
  const mean = (k: keyof Scores) => round6(sums[k][1] ? sums[k][0] / sums[k][1] / 255 : 0);
  return {
    kind,
    width: v.width,
    height: v.height,
    ...(kind === "video" && { frames: sums.brightness[1] }),
    ...(animated && { animated: true }),
    scores: { motion: mean("motion"), sharpness: mean("sharpness"), brightness: mean("brightness") },
  };
}
