// Downloads the pinned ffmpeg/ffprobe binaries listed in vendor/ffmpeg/VERSION.json and verifies sha256.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const root = new URL("../vendor/ffmpeg/", import.meta.url);
const pin = JSON.parse(readFileSync(new URL("VERSION.json", root)));
const platform = `${process.platform}-${process.arch}`;
const bins = pin.binaries[platform];
if (!bins) throw new Error(`No pinned ffmpeg for ${platform}; add it to vendor/ffmpeg/VERSION.json`);
const dir = new URL(`${platform}/`, root);
mkdirSync(dir, { recursive: true });
const sha = (b) => createHash("sha256").update(b).digest("hex");

for (const [name, { url, sha256 }] of Object.entries(bins)) {
  const file = new URL(name, dir);
  if (existsSync(file) && sha(readFileSync(file)) === sha256) continue;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = gunzipSync(Buffer.from(await res.arrayBuffer()));
  if (sha(body) !== sha256) throw new Error(`${name}: sha256 mismatch`);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  console.log(`fetched ${name} for ${platform}`);
}
