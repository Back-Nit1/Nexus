# Nexus

Deterministic template-to-video engine. One template × N input rows → N mp4s.

```text
validated template + validated inputs → compiler → timeline JSON → renderer → mp4 → QA
```

A model may help author a template once (`packages/authoring`). Compile, render, batch and QA make zero model calls; `packages/batch/test/ai-boundary.test.ts` walks the import graph from those entry points and fails if any AI package is reachable.

## Commands

```sh
pnpm install          # also fetches pinned ffmpeg/ffprobe (sha256-verified) into vendor/ffmpeg
pnpm fixtures         # regenerates fixtures/ (synthetic band-encoded clips, templates, CSV + folder batches)
pnpm test             # all vitest suites (unit, golden-frame, batch, AI boundary)
pnpm typecheck
node scripts/mutate.mjs   # breaks each critical invariant, asserts its test fails, restores
pnpm dev              # desktop app
pnpm e2e              # Playwright + Electron smoke test
```

## Packages

| package | owns |
|---|---|
| `timeline` | rational fps, exact round-half-up quantization (`secondsToFrames`, `framesToTimestamp`, `framesToSamples`), timeline Zod schema + tiling invariant, stable serialization, `StructuredError` |
| `template` | template schema, the one validator, scoring expression parser (no eval), output-name checks, pure `compile()` |
| `perception` | file hashing; ffprobe metadata; normalized frame count; motion/sharpness/brightness scores |
| `renderer` | pinned ffmpeg runner (execa, `shell:false`, argv arrays), font preflight, rendered text measurement/fit, segment render + content-addressed cache, concat, single audio build + mux |
| `qa` | frame count, dimensions, fps, audio presence, decode, text-fit and timeline consistency checks (reports, never repairs) |
| `batch` | CSV / folder-of-subfolders loading, shared compile path (`Preparer.compileRow`, also used for preview), persisted queue in `results.json`, concurrency, pause/resume/cancel, one retry, crash recovery |
| `authoring` | "Describe the edit": Claude drafts a template and must pass the real validator via a tool |
| `apps/desktop` | Electron main (fs, dialogs, jobs) + React UI over typed IPC |

## Engine contract

- ffmpeg: `vendor/ffmpeg/VERSION.json` pins exact binaries (eugeneware/ffmpeg-static tag b6.1.1; the darwin build reports `6.0`, which is the recorded `ffmpegVersion`). The renderer refuses any other version. Only `darwin-arm64` is pinned so far.
- Time is integer frames everywhere; seconds only at input parsing / display.
- Segments: `fps` filter → `trim=start_frame` → cover scale/crop → overlays → `-frames:v N -an`. Concat with stream copy. Audio: one track, sample-exact `atrim/apad` to `totalFrames`, muxed once.
- Segment cache key (order is a compatibility surface, append only): `[sourceHash, sourceInFrame, frameCount, recipe, canvas, engineVersion, ffmpegVersion]`.
- Scored clip choice: highest expression value, ties by media id (code-unit order); scored clips are never reused.
- Text: drawtext with an explicit bundled `fontfile` (FreeType, no fontconfig lookup) after a name-table preflight; line widths are measured by rendering (bbox, `metadata=print:file=-` read from **stdout**); greedy wrap; largest size in the band that fits, else `TEXT_DOES_NOT_FIT`. Line height = round-half-up(1.25 × size).
- Template files are JSON with extension `.nexus.json`.

## Known limitations / deferred

- Deferred issue: duplicate JSON keys in templates are not detected (JSON.parse keeps the last one).
- Deferred issue: only darwin-arm64 ffmpeg is pinned; other platforms need entries in `VERSION.json`.
- Deferred issue: phone rotation metadata is not applied before cover-crop.
- Deferred issue: audio is a single music-bed slot; clip audio is not used.
- Deferred issue: packaging (electron-builder) is not set up; the app runs from the repo.
- Text fit measures O(words²) candidate lines per size in one ffmpeg call — fine for headlines, slow for paragraphs.
