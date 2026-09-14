# Build: Nexus — Deterministic Template-to-Video Desktop Engine

You are building **Nexus**, a new desktop application from an empty repository.

Nexus takes:

- one reusable video template;
- a set of media inputs such as video clips, images, text fields, and optional audio;
- and many rows of structured input data;

and deterministically produces many finished videos.

Think of the product as a **video compiler**, not a traditional nonlinear editor.

A lightweight CapCut-style timeline allows a person to inspect, preview, and make constrained modifications to a template. Building a general-purpose video editor is explicitly outside the scope of v1.

---

# Core product model

The architecture follows one pipeline:

```text
validated template
        +
validated inputs
        |
        v
     compiler
        |
        v
deterministic timeline JSON
        |
        v
     renderer
        |
        v
       mp4
        |
        v
        QA
```

The compiled timeline is the canonical description of a finished video.

Rendering must never make creative decisions.

If the same:

- template,
- input files,
- input row,
- app engine version,
- bundled ffmpeg version,

are provided twice, the application must produce:

1. byte-identical compiled timeline JSON; and
2. video frames that match frame-for-frame.

---

# Non-negotiable AI boundary

There is one rule from which the rest of the architecture follows:

> **A model may help author a template once. Rendering is deterministic code with zero model calls.**

AI exists only as a template-authoring assistant.

It may turn a natural-language description into a proposed template.

Once the template exists, every downstream operation is normal deterministic software.

Examples:

Bad:

```text
"Ask the model which clip looks best for slot 3."
```

Good:

```text
maximize: "motion * sharpness"
```

Bad:

```text
"Ask an LLM where the title should go."
```

Good:

```text
position:
  x: 0.5
  y: 0.18
```

Bad:

```text
"Ask the model to shorten text if it doesn't fit."
```

Good:

```text
validation error:
TEXT_DOES_NOT_FIT
```

No AI SDK, AI HTTP client, model invocation, prompt code, agent framework, or indirect model dependency may be reachable from:

- renderer;
- compiler execution;
- batch execution;
- QA execution.

Create an automated test that begins at the render entry point, walks the reachable import graph, and fails if an AI SDK or AI integration package is reachable.

Rendering must remain deterministic even if every AI-related package is deleted from the repository.

---

# Development process

Work strictly in the phases listed later in this specification.

At the end of **every phase**:

1. stop development;
2. summarize what now exists;
3. list files/packages added;
4. show the relevant test command;
5. show actual test output;
6. mention any known limitation or bug discovered;
7. wait for my explicit approval.

Do not begin the following phase until I approve it.

Do not implement functionality scheduled for later phases.

If you notice a gap outside the current phase, report it in one sentence under:

```text
Deferred issue:
```

and continue with the current phase.

Do not silently expand scope.

---

# Technology stack

The stack is already decided.

Do not substitute alternatives.

Use:

- Electron
- React
- TypeScript
- pnpm workspaces
- Vitest
- Zod
- ffmpeg
- ffprobe
- execa

No database exists in v1.

Persistent state consists of files on disk:

- projects;
- templates;
- timelines;
- queue state;
- render results;
- batch metadata.

---

# ffmpeg policy

Bundle ffmpeg and ffprobe as pinned binaries.

Pick **one exact ffmpeg release** before implementing the renderer and record it in the repository.

Do not use:

```text
latest
```

Do not depend on a system-installed ffmpeg.

Frame behavior can differ across ffmpeg majors and releases, so the version is part of the rendering engine contract.

Expose the exact ffmpeg version in:

```json
{
  "engine": {
    "appVersion": "...",
    "ffmpegVersion": "..."
  }
}
```

for render results.

Invoke ffmpeg and ffprobe using `execa`.

Requirements:

```ts
shell: false;
```

Always construct argv arrays.

Never interpolate an ffmpeg command into a shell string.

---

# Workspace layout

Use the following pnpm workspace structure.

```text
nexus/
├─ apps/
│  └─ desktop/
│     ├─ src/
│     │  ├─ main/
│     │  ├─ preload/
│     │  └─ renderer/
│     ├─ package.json
│     └─ tsconfig.json
│
├─ packages/
│  ├─ timeline/
│  ├─ template/
│  ├─ perception/
│  ├─ renderer/
│  ├─ batch/
│  └─ qa/
│
├─ fixtures/
│  ├─ media/
│  ├─ templates/
│  └─ batches/
│
├─ scripts/
├─ package.json
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
└─ README.md
```

Package responsibilities are strict.

---

# Package responsibilities

## `packages/timeline`

Owns the canonical timeline contract.

Responsibilities:

- rational FPS representation;
- integer frame units;
- frame/seconds conversion;
- picture segments;
- text overlays;
- audio specification;
- timeline invariants;
- Zod validation;
- stable serialization.

Every package that produces or consumes a video timeline depends on this package.

No renderer-specific ffmpeg syntax belongs here.

---

## `packages/template`

Owns template semantics.

Responsibilities:

- template schema;
- validator;
- slot declarations;
- zones;
- input fields;
- clip selection expressions;
- fixed timing;
- text declarations;
- output naming pattern;
- compilation.

Compilation performs:

```text
template + normalized inputs + perception scores
→ timeline JSON
```

Compilation may not spawn ffmpeg except through perception preprocessing performed before compilation.

Compilation may not read the clock or use unseeded randomness.

---

## `packages/perception`

Computes deterministic properties of source media.

Initial metrics:

- duration/frame metadata;
- resolution;
- motion score;
- sharpness score;
- brightness score.

Its results become input values to scoring expressions.

Example:

```text
maximize: "motion * sharpness"
```

The compiler chooses the clip with the greatest deterministic numeric score.

Tie-breaking must also be deterministic.

Use a stable secondary key such as input ID.

---

## `packages/renderer`

Consumes only a validated timeline plus referenced local media.

Responsibilities:

- segment rendering;
- frame-accurate trimming;
- resizing/cropping;
- text overlays;
- image overlays if required by the timeline contract;
- segment cache;
- concat;
- continuous audio construction;
- final mux.

The renderer never decides:

- which clip belongs in a slot;
- what text should say;
- where elements should be placed;
- how long a zone should be.

Those decisions already exist in the timeline.

---

## `packages/batch`

Runs:

```text
one template × N input rows
```

Responsibilities:

- queue creation;
- row validation;
- compilation;
- rendering;
- configurable concurrency;
- progress events;
- retry;
- pause;
- cancellation;
- restart/resume state;
- results aggregation.

Default concurrency:

```text
floor(logicalCPUCount / 2)
```

with a minimum of `1`.

---

## `packages/qa`

Performs post-render validation.

v1 checks:

- expected frame count;
- expected dimensions;
- audio stream presence when required;
- successful decode/probe;
- text-fit assertions;
- timeline/render consistency.

QA does not repair output.

It reports failures.

---

## `apps/desktop`

Electron application.

Electron main process owns:

- filesystem access;
- native dialogs;
- batch jobs;
- ffmpeg execution indirectly through packages;
- queue persistence.

React renderer owns:

- presentation;
- forms;
- timeline visualization;
- mapping UI;
- progress views.

The React renderer must never:

- access Node filesystem APIs directly;
- invoke ffmpeg;
- invoke ffprobe;
- execute shell commands.

All communication occurs over typed IPC.

---

# Timeline fundamentals

## Integer frames only

All internal timing uses integer frame numbers.

Never use floating-point seconds to represent:

- cuts;
- zone boundaries;
- overlay timing;
- audio boundaries;
- total duration.

Seconds may exist only:

1. while parsing human input;
2. while displaying values to the user.

Immediately quantize external time values into frames.

---

# Rational frame rate

Represent FPS exactly.

Example:

```ts
type Rational = {
  numerator: number;
  denominator: number;
};
```

29.97 fps must be represented as:

```ts
{
  numerator: 30000,
  denominator: 1001
}
```

Never store:

```ts
29.97;
```

internally.

---

# Quantization

Conversions from seconds to frames must use exact decimal/rational arithmetic and **round-half-up** semantics.

Do not rely on floating-point `Math.round`.

This is deliberately included because:

```ts
Math.round(2.05 * 30);
```

can produce incorrect behavior from binary floating-point representation.

Provide helpers such as:

```ts
secondsToFrames(...)
framesToTimestamp(...)
```

with explicit semantics.

Test boundary cases around `.5`.

---

# Picture-track invariant

The primary visual track must exactly tile:

```text
[0, totalFrames)
```

There may be:

- no gaps;
- no overlaps.

For adjacent segments:

```text
segment[i].endFrame === segment[i + 1].startFrame
```

The first segment starts at:

```text
0
```

The final segment ends at:

```text
timeline.totalFrames
```

Reject invalid timelines through Zod refinement.

This invariant is necessary for segment-render-then-concat.

---

# Rendering frame rules

Phone video may use variable frame rate.

Therefore trimming based on source seconds is unsafe.

For every source video segment:

1. normalize using the target `fps` filter;
2. identify the normalized source frame;
3. render exactly `N` frames.

The fps filter must occur before trimming.

Use:

```text
-frames:v N
```

Do not use:

```text
-t seconds
```

for segment length.

---

# Audio invariant

Every visual segment is rendered with:

```text
-an
```

Do not encode audio inside individual visual segments.

Instead:

1. render silent picture segments;
2. concatenate picture segments;
3. independently construct one continuous audio timeline;
4. encode/mix audio;
5. mux picture + audio once.

This prevents accumulated AAC priming/padding drift across many cuts.

---

# Paths

User project paths may contain spaces.

Therefore:

- never rely on shell escaping;
- use `execa` argv arrays;
- use `shell: false`;
- use `-filter_complex_script` rather than placing large filter graphs directly in command arguments;
- set ffmpeg `cwd` to the job directory;
- pass relative filenames whenever possible.

A fixture must include a path containing spaces.

---

# Text rendering

Templates may declare text overlays.

Each text definition includes:

- binding;
- bundled font family;
- size or size band;
- six-digit hexadecimal color;
- position;
- maximum lines;
- active frame range if necessary.

Example:

```json
{
  "text": "{row.headline}",
  "font": "Inter",
  "size": {
    "min": 42,
    "max": 64
  },
  "color": "FFFFFF",
  "position": {
    "x": 0.5,
    "y": 0.2
  },
  "maxLines": 2
}
```

Unsupported color forms should fail validation.

Accepted:

```text
FFFFFF
EAEAEA
111111
```

Rejected:

```text
#fff
white
rgb(255,255,255)
```

unless explicitly added in a future schema version.

---

# Font safety

Fonts used by templates must be bundled with the application.

Never depend on whatever fonts happen to be installed on the machine.

libass can silently substitute a font while exiting successfully.

Therefore the renderer must perform a font preflight and verify that the requested face was actually selected.

Missing or substituted fonts are render errors.

---

# Text fitting

Never trust font metric tables alone.

Measure rendered text.

For validation:

1. render or rasterize the actual glyphs with the target font;
2. measure visual bounds/cap height;
3. account for wrapping;
4. check the resulting block against its allowed frame region;
5. reject text that cannot fit.

Do not:

- silently shrink below the template's minimum size;
- clip overflow;
- truncate;
- add ellipses;
- rewrite text.

Return a precise validation error.

Example:

```json
{
  "code": "TEXT_DOES_NOT_FIT",
  "path": "zones[2].text[0]",
  "message": "Headline requires 3 lines at minimum font size 42px but maxLines is 2.",
  "details": {
    "requiredLines": 3,
    "maxLines": 2,
    "minimumFontSize": 42
  }
}
```

Errors should contain enough information for either a human or a model authoring a template to repair it.

---

# ffmpeg metadata stream rule

When using:

```text
metadata=print
```

ffmpeg writes relevant output to **stdout**.

Do not parse stderr for this information.

Add a regression test so switching streams causes a failure.

---

# Segment cache

Rendered picture segments must be cached.

The cache key is content-addressed.

Its ordered fields are:

1. source content hash;
2. source in-frame;
3. output frame count;
4. segment recipe;
5. output canvas;
6. application render-engine version;
7. ffmpeg version.

Example conceptual structure:

```ts
[
  sourceHash,
  sourceInFrame,
  frameCount,
  recipe,
  canvas,
  engineVersion,
  ffmpegVersion,
];
```

The serialized order of cache-key components is a compatibility surface.

**Never reorder existing fields.**

Future versions may only append additional fields.

---

# Determinism

The compiler must never call:

```ts
Math.random();
Date.now();
new Date();
crypto.randomUUID();
performance.now();
```

or any equivalent clock/randomness API while making compilation decisions.

If a template requires pseudo-random ordering, use an explicit deterministic seed derived from values such as:

```text
template.id
template.version
inputRow.id
```

and a pinned deterministic PRNG implementation.

The exact seed algorithm becomes part of the engine contract.

---

# Template file format

Use **pure JSON** for v1 templates.

Do not use YAML.

Reasons:

1. the template ultimately maps directly into a typed/Zod object;
2. JSON has fewer implicit type conversions;
3. duplicate-key and scalar interpretation problems are easier to avoid;
4. model-generated templates are easier to validate exactly;
5. deterministic serialization is straightforward;
6. schema errors can reference exact property paths;
7. project files already use JSON.

Human friendliness comes from the GUI and AI authoring experience rather than hand-editing YAML.

Template extension:

```text
.nexus.json
```

Example:

```text
promo-short.nexus.json
```

---

# Template declarations

A template declares:

## Metadata

```ts
id;
name;
version;
```

## Canvas

```ts
width;
height;
fps;
```

## Duration

Either:

```ts
totalFrames;
```

or a deterministic total derived from the sum of fixed zones.

Do not allow conflicting duration declarations.

---

# Zones

Zones are ordered.

Every zone has a fixed integer frame count.

Example:

```json
{
  "id": "hook",
  "frames": 90,
  "fill": {
    "type": "slot",
    "slot": "hookClip"
  }
}
```

or:

```json
{
  "id": "broll",
  "frames": 120,
  "fill": {
    "type": "score",
    "maximize": "motion * sharpness"
  }
}
```

Clips selected by scoring cannot be reused unless the template explicitly supports reuse in a future version.

In v1:

```text
clip reuse = forbidden
```

for scored clip selection.

---

# Scoring expressions

Support a small deterministic expression language.

v1 variables:

```text
motion
sharpness
brightness
```

v1 operators:

```text
+
-
*
/
(...)
```

Do not use arbitrary JavaScript evaluation.

Do not use:

```ts
eval();
new Function();
```

Parse expressions safely.

Example:

```text
motion * sharpness
```

Tie-break by deterministic clip/input ID ordering.

Non-finite results are validation/compilation errors.

---

# Template input bindings

Text can bind to input row values.

Example:

```text
{row.headline}
```

Input slots can bind to mapped media.

Example conceptual mappings:

```text
hookClip
productClip
testimonialClip
logo
headline
cta
```

Compilation must fail clearly if required bindings are absent.

---

# Output naming

Templates declare an output filename pattern.

Example:

```text
"{row.id}-{row.slug}.mp4"
```

Validate the result before rendering.

Prevent:

- path traversal;
- absolute paths;
- illegal filename segments;
- collisions within a batch.

---

# Batch input modes

v1 supports two input styles.

## CSV + media folder

Example:

```text
batch/
├─ rows.csv
└─ media/
   ├─ clip-a.mp4
   ├─ clip-b.mp4
   └─ logo.png
```

One CSV row represents one output video.

---

## Folder of subfolders

Example:

```text
inputs/
├─ product-001/
│  ├─ clip1.mp4
│  ├─ clip2.mp4
│  └─ image.png
├─ product-002/
│  ├─ clip1.mp4
│  └─ image.png
```

Each subfolder represents one row/job.

---

# Mapping

The user maps:

- CSV columns → text fields;
- media files/media rules → template slots.

Mapping configuration must itself be serializable.

The Map Inputs screen previews row 1 by compiling an actual timeline.

Do not create a second "preview compiler."

The same compiler used in batch rendering must power preview compilation.

---

# Invalid rows

A bad row must not terminate the whole batch.

For each row:

```text
validate inputs
→ compile
→ render
→ QA
```

If row validation or compilation fails:

- mark that row invalid;
- preserve the reason;
- skip rendering it;
- continue with other rows.

---

# Queue behavior

The batch queue supports:

- start;
- pause;
- resume;
- cancel;
- configurable concurrency;
- one automatic retry after render failure;
- progress events;
- restart recovery.

Persist queue state to disk.

A process/app restart must not forget:

- finished rows;
- failed rows;
- pending rows;
- retry count.

Do not treat a process crash as a successful render.

---

# Batch results

Each batch creates:

```text
results.json
```

It includes:

```ts
{
  batchId: string;
  templateId: string;
  templateVersion: string;
  engineVersion: string;
  ffmpegVersion: string;
  rows: BatchRowResult[];
}
```

Each row includes:

```ts
{
  rowId: string;
  status:
    | "invalid"
    | "pending"
    | "rendering"
    | "passed"
    | "failed"
    | "cancelled";

  output?: string;

  inputHashes: Record<string, string>;

  timeline?: Timeline;

  qa?: QAResult;

  error?: StructuredError;
}
```

---

# Desktop UI

The desktop application has exactly four primary workflow screens in v1.

Avoid long paragraphs inside the UI.

Use short labels, values, badges, controls, and inline errors.

---

## Screen 1 — Templates

Capabilities:

- list templates;
- import template;
- validate template;
- display validation errors inline;
- open selected template.

Do not build a full visual template editor in this screen.

---

## Screen 2 — Map inputs

Capabilities:

- choose CSV;
- choose media folder;
- or choose folder-of-subfolders input;
- map fields;
- map media slots;
- preview row 1's compiled timeline.

Show unresolved required mappings before continuing.

---

## Screen 3 — Preview & tweak

Provide a lightweight CapCut-style timeline.

Show:

- visual tracks;
- fixed zones;
- clip blocks;
- text blocks;
- playhead;
- preview player.

Allowed modifications only:

- zone length;
- text content;
- text position;
- text size;
- swap the clip assigned to a slot.

Any modification writes back into the template representation and triggers full revalidation.

Do not add:

- arbitrary splitting;
- transitions UI;
- keyframes;
- filters;
- freeform layer creation;
- effects browser;
- animation editor;
- color grading.

Those are outside v1.

---

## Screen 4 — Batch

Capabilities:

- start;
- pause;
- cancel;
- concurrency setting;
- per-row progress;
- results grid;
- thumbnails;
- QA status badges;
- open rendered file.

No editing tools belong here.

---

# Typed IPC

Define explicit typed IPC request/response/event contracts.

Examples:

```ts
type IPCChannels = {
  "template:list": ...
  "template:import": ...
  "template:validate": ...
  "input:pick-csv": ...
  "input:pick-folder": ...
  "timeline:compile-preview": ...
  "batch:start": ...
  "batch:pause": ...
  "batch:cancel": ...
};
```

Expose only approved preload APIs through `contextBridge`.

Do not expose:

```ts
require;
fs;
child_process;
execa;
electron.ipcRenderer;
```

directly to React.

---

# AI template authoring

AI is implemented only in Phase 6.

Feature:

```text
Describe the edit
```

Example input:

```text
Create a 15-second vertical real-estate reel.
Start with the highest-motion exterior clip for 2 seconds.
Then show three interior clips, prioritizing sharpness.
Put the property name near the top.
End with the agent's CTA.
```

The model receives:

- the template schema;
- template-authoring instructions;
- available fonts;
- supported operations;
- a validator tool.

The model drafts a template and calls the actual validator.

If validation fails, return the structured errors to the model.

The model may resubmit until the template validates.

Do not implement a separate "AI validator."

There is exactly one validator implementation.

If required information is genuinely missing, the authoring model may refuse or request it.

Example:

```text
The requested edit does not define a total duration or zone durations.
```

After generation:

1. show the validated template to the user;
2. allow preview;
3. require explicit approval;
4. only then save it.

No AI call occurs during compilation or rendering.

---

# Tests

All important behavioral rules require tests.

Tests should prefer observable behavior over implementation details.

---

## Timeline unit tests

Test:

- rational FPS schema;
- valid canvas;
- invalid FPS;
- integer-only frame values;
- picture-track gap rejection;
- picture-track overlap rejection;
- correct final frame;
- malformed overlay timing;
- unsupported fields;
- deterministic serialization.

---

# Quantization tests

Test round-half-up behavior.

Include boundary values.

Examples:

```text
0 frames
1 frame
exact frame boundaries
just below half frame
exact half frame
just above half frame
29.97 rational FPS
23.976 rational FPS
```

Do not write tests that merely reproduce the implementation formula.

---

# Compiler determinism tests

Run compilation repeatedly.

Assert exact equality of serialized timeline JSON.

Test with input order permutations where semantics should not change.

Verify deterministic score tie-breaking.

---

# Scoring tests

Test:

```text
motion
sharpness
brightness
motion * sharpness
motion + sharpness
motion / sharpness
parentheses
ties
zero values
```

Reject unsupported syntax.

---

# Golden-frame renderer tests

Generate synthetic source footage using the bundled ffmpeg.

Every source clip must visibly encode:

```text
source identity
+
frame number
```

into image content, preferably using deterministic luma bands or another machine-readable image pattern.

Do not rely solely on timestamps or ffprobe metadata.

Construct timelines with cuts at known frames.

Render them.

Decode output frames and verify:

- output frame 0 comes from the expected source frame;
- every segment boundary uses the exact intended source frame;
- no source frame is duplicated or skipped at cuts;
- final output frame is correct;
- total frame count exactly matches `timeline.totalFrames`.

Include VFR source footage.

---

# Mutation test rule

For every critical invariant test:

1. intentionally modify the implementation/source so the invariant is violated;
2. verify the test fails;
3. restore the correct implementation.

Examples:

- introduce a one-frame cut offset;
- switch round-half-up to floating-point rounding;
- create a timeline gap;
- read ffmpeg metadata
