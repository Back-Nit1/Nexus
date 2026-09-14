// Mutation check: breaks each critical invariant in the implementation, asserts its test FAILS, then restores the file.
// Run: node scripts/mutate.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const mutations = [
  ["one-frame cut offset", "packages/renderer/src/index.ts", "`trim=start_frame=${src.kind === \"video\" ? src.inFrame : 0}`", "`trim=start_frame=${src.kind === \"video\" ? src.inFrame + 1 : 0}`", "packages/renderer/test/renderer.test.ts"],
  ["float Math.round quantization", "packages/timeline/src/index.ts", "return Number(roundHalfUp(n * BigInt(fps.numerator), d * BigInt(fps.denominator)));", "return Math.round((Number(n) / Number(d)) * (fps.numerator / fps.denominator));", "packages/timeline/test/timeline.test.ts"],
  ["picture-track gaps allowed", "packages/timeline/src/index.ts", "if (s.startFrame !== at)", "if (s.startFrame < at)", "packages/timeline/test/timeline.test.ts"],
  ["metadata read from stderr", "packages/renderer/src/text.ts", "const { stdout } = await ffmpeg([\"-filter_complex_script\"", "const { stderr: stdout } = await ffmpeg([\"-filter_complex_script\"", "packages/renderer/test/renderer.test.ts"],
  ["cache key fields reordered", "packages/renderer/src/index.ts", "[sourceHash, inFrame, frames, recipe, canvas, engine, ff]", "[sourceHash, frames, inFrame, recipe, canvas, engine, ff]", "packages/renderer/test/renderer.test.ts"],
  ["tie-break order reversed", "packages/template/src/index.ts", "(a.m.id < b.m.id ? -1 : a.m.id > b.m.id ? 1 : 0)", "(a.m.id < b.m.id ? 1 : a.m.id > b.m.id ? -1 : 0)", "packages/template/test/template.test.ts"],
  ["segments encode source audio", "packages/renderer/src/index.ts", "String(frames), \"-an\",", "String(frames), \"-map\", \"0:a?\",", "packages/renderer/test/renderer.test.ts"],
];

let bad = 0;
for (const [name, file, from, to, test] of mutations) {
  const src = readFileSync(file, "utf8");
  if (!src.includes(from)) throw new Error(`${name}: pattern not found in ${file}`);
  writeFileSync(file, src.replace(from, to));
  let failed = false;
  try {
    execFileSync("pnpm", ["vitest", "run", test], { stdio: "pipe" });
  } catch {
    failed = true;
  } finally {
    writeFileSync(file, src);
  }
  console.log(`${failed ? "KILLED  " : "SURVIVED"}  ${name}  (${test})`);
  bad += +!failed;
}
process.exit(bad);
