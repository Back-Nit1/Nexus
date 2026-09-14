// Generates deterministic fixture media/templates/batches with the pinned ffmpeg. Run: pnpm fixtures
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { ffmpeg } from "../packages/renderer/src/ffmpeg.ts";
import { bandClip, tone } from "../packages/renderer/test/synth.ts";

const root = new URL("../fixtures/", import.meta.url).pathname;
const media = join(root, "media");
const csvDir = join(root, "batches", "csv demo"); // path with spaces on purpose
const folders = join(root, "batches", "folders");
for (const d of [media, join(root, "templates"), join(csvDir, "media"), join(folders, "product-001"), join(folders, "product-002")]) await mkdir(d, { recursive: true });

const size = "540x960";
for (const [i, name] of ["clip-a", "clip-b", "clip-c", "clip-d"].entries()) await bandClip(media, `${name}.mp4`, i + 1, 150 + i * 30, { size });
await bandClip(media, "clip-vfr.mp4", 5, 150, { size, vfr: true });
await ffmpeg(["-f", "lavfi", "-i", "color=0x1E6FD9:s=540x960,drawbox=x=170:y=380:w=200:h=200:color=white:t=fill", "-frames:v", "1", join(media, "logo.png")]);
await tone(media, "music.m4a", 12);

const template = {
  schemaVersion: 1,
  id: "promo-short",
  name: "Promo short",
  version: "1.0.0",
  canvas: { width: 540, height: 960, fps: { numerator: 30, denominator: 1 } },
  totalFrames: 240,
  slots: [
    { id: "hookClip", kind: "video", required: true },
    { id: "logo", kind: "image", required: true },
    { id: "music", kind: "audio", required: false },
  ],
  fields: [
    { id: "headline", required: true },
    { id: "cta", required: true },
    { id: "slug", required: true },
  ],
  zones: [
    { id: "hook", frames: 60, fill: { type: "slot", slot: "hookClip" }, text: [{ text: "{row.headline}", font: "Inter", size: { min: 28, max: 48 }, color: "FFFFFF", position: { x: 0.5, y: 0.18 }, width: 0.85, maxLines: 2 }] },
    { id: "broll", frames: 90, fill: { type: "score", maximize: "motion * sharpness" }, text: [] },
    { id: "product", frames: 60, fill: { type: "slot", slot: "logo" }, text: [{ text: "{row.cta}", font: "Inter", size: { min: 24, max: 40 }, color: "FFFFFF", position: { x: 0.5, y: 0.8 }, width: 0.8, maxLines: 2 }] },
    { id: "end", frames: 30, fill: { type: "color", color: "111111" }, text: [] },
  ],
  audio: { slot: "music" },
  output: "{row.id}-{row.slug}.mp4",
};
await writeFile(join(root, "templates", "promo-short.nexus.json"), JSON.stringify(template, null, 2) + "\n");
const broken = { ...template, id: "broken", totalFrames: 999, zones: [{ ...template.zones[0], fill: { type: "score", maximize: "motion ^ 2" } }] };
await writeFile(join(root, "templates", "broken.nexus.json"), JSON.stringify(broken, null, 2) + "\n");

for (const f of ["clip-a.mp4", "clip-b.mp4", "clip-c.mp4", "clip-d.mp4", "clip-vfr.mp4", "logo.png", "music.m4a"]) await copyFile(join(media, f), join(csvDir, "media", f));
await writeFile(
  join(csvDir, "rows.csv"),
  `id,headline,cta,slug,hook,logo,music
p1,Summer sale starts now,Shop today,summer,clip-a.mp4,logo.png,music.m4a
p2,"New arrivals, fresh picks",Tap to browse,arrivals,clip-vfr.mp4,logo.png,
p3,,Missing headline row,bad,clip-a.mp4,logo.png,
`,
);

for (const [dir, clips, headline] of [["product-001", ["clip-a.mp4", "clip-b.mp4", "clip-c.mp4"], "Product one"], ["product-002", ["clip-b.mp4", "clip-d.mp4"], "Product two"]] as const) {
  for (const c of clips) await copyFile(join(media, c), join(folders, dir, c));
  await copyFile(join(media, "logo.png"), join(folders, dir, "logo.png"));
  await writeFile(join(folders, dir, "row.json"), JSON.stringify({ headline, cta: "Learn more", slug: dir }, null, 2));
}
console.log(`fixtures written to ${root}`);
