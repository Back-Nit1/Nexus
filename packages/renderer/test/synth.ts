// Synthetic golden footage: 16 vertical luma bands encode (sourceId << 10 | frameNumber) in every frame.
import { join } from "node:path";
import { ffmpeg } from "../src/ffmpeg.ts";

export const BANDS = 16;

/** CFR clip, or VFR: the first 30 frames last 2/30 s each, the rest 1/30 s. */
export async function bandClip(dir: string, file: string, id: number, frames: number, opts: { vfr?: boolean; size?: string } = {}) {
  const lum = `if(mod(floor((${id}*1024+N)/pow(2,floor(X*${BANDS}/W))),2),235,16)`;
  const vf = opts.vfr ? ["-vf", "settb=1/30,setpts='if(lt(N,30),N*2,N+30)'", "-fps_mode", "passthrough"] : [];
  const out = join(dir, file);
  await ffmpeg(["-f", "lavfi", "-i", `color=black:s=${opts.size ?? "160x90"}:r=30,format=gray,geq=lum='${lum}'`, "-frames:v", String(frames), ...vf, "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", out]);
  return out;
}

/** Decode every frame of a video back into {id, n}. */
export async function readBands(file: string) {
  const { stdout } = await ffmpeg(["-i", file, "-vf", `scale=${BANDS}:1:flags=area,format=gray`, "-f", "rawvideo", "-"], { buffer: true });
  const buf = stdout as unknown as Uint8Array;
  return Array.from({ length: buf.length / BANDS }, (_, f) => {
    let v = 0;
    for (let b = 0; b < BANDS; b++) if (buf[f * BANDS + b] > 128) v += 2 ** b;
    return { id: v >> 10, n: v & 1023 };
  });
}

/** Test tone for audio fixtures. */
export const tone = (dir: string, file: string, seconds: number) =>
  ffmpeg(["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`, "-c:a", "aac", join(dir, file)]).then(() => join(dir, file));
