import { execa } from "execa";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StructuredError } from "@nexus/timeline";

// Pinned binaries only (vendor/ffmpeg). NEXUS_VENDOR_DIR lets a packaged app point at its bundled copy.
const vendor = process.env.NEXUS_VENDOR_DIR ?? fileURLToPath(new URL("../../../vendor/ffmpeg/", import.meta.url));
const bin = (name: string) => join(vendor, `${process.platform}-${process.arch}`, name);

export const FFMPEG_VERSION: string = JSON.parse(readFileSync(join(vendor, "VERSION.json"), "utf8")).ffmpegVersion;
export const ENGINE_VERSION = "0.1.0";

export class NexusError extends Error {
  error: StructuredError;
  constructor(error: StructuredError) {
    super(`${error.code}: ${error.message}`);
    this.error = error;
  }
}

type Opts = { cwd?: string; signal?: AbortSignal; buffer?: boolean };
const run = (name: string, base: string[]) => (args: string[], o: Opts = {}) =>
  execa(bin(name), [...base, ...args], { cwd: o.cwd, cancelSignal: o.signal, shell: false, maxBuffer: 1 << 30, encoding: o.buffer ? "buffer" : "utf8" });

export const ffmpeg = run("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-v", "error"]);
export const ffprobe = run("ffprobe", ["-v", "error"]);

let checked: Promise<void> | undefined;
/** Refuse to run against anything but the pinned ffmpeg release. */
export const assertFfmpegVersion = () =>
  (checked ??= Promise.all([ffmpeg(["-version"]), ffprobe(["-version"])]).then((rs) => {
    for (const r of rs)
      if (!String(r.stdout).includes(` version ${FFMPEG_VERSION} `))
        throw new NexusError({ code: "FFMPEG_VERSION_MISMATCH", path: "", message: `Expected ffmpeg ${FFMPEG_VERSION}, got: ${String(r.stdout).split("\n")[0]}` });
  }));

/** Parse `metadata=print:file=-` output (stdout) into one key/value record per frame. */
export function parseMetadata(stdout: string): Record<string, string>[] {
  return stdout
    .split(/^frame:\d+\s.*$/m)
    .slice(1)
    .map((block) => Object.fromEntries(block.trim().split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])));
}
