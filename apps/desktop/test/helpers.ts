// Shared test fixtures and a controllable fake of window.nexus (the preload-exposed IPC API).
import "@testing-library/jest-dom/vitest";
import type { Template } from "@nexus/template";
import type { Timeline } from "@nexus/timeline";
import type { Api, Channels, Events } from "../src/shared/ipc";

export const TEMPLATE: Template = {
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
} as Template;

export const timeline = (overrides: Partial<Timeline> = {}): Timeline =>
  ({
    version: 1,
    canvas: TEMPLATE.canvas,
    totalFrames: 240,
    segments: [{ startFrame: 0, endFrame: 240, zone: "hook", source: { kind: "color", color: "111111" } }],
    overlays: [],
    audio: null,
    output: "row-1-slug.mp4",
    ...overrides,
  }) as Timeline;

/** A deferred promise so a test can control exactly when an IPC call resolves, to exercise races. */
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/** A fake of the preload-exposed `window.nexus` whose per-channel behavior tests install on demand. */
function fakeApi() {
  const handlers = new Map<keyof Channels, (req: unknown) => Promise<unknown>>();
  const listeners = new Map<keyof Events, Set<(data: unknown) => void>>();
  const api: Api = {
    invoke: ((channel: keyof Channels, ...req: unknown[]) => {
      const h = handlers.get(channel);
      if (!h) return Promise.reject(new Error(`no handler installed for ${channel}`));
      return Promise.resolve(h(req[0]));
    }) as Api["invoke"],
    on: ((event: keyof Events, cb: (data: unknown) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(cb);
      listeners.set(event, set);
      return () => set.delete(cb);
    }) as Api["on"],
  };
  return {
    api,
    when<K extends keyof Channels>(channel: K, fn: (req: Channels[K][0]) => Promise<Channels[K][1]> | Channels[K][1]) {
      handlers.set(channel, fn as never);
    },
    emit<K extends keyof Events>(event: K, data: Events[K]) {
      listeners.get(event)?.forEach((cb) => cb(data));
    },
    reset() {
      handlers.clear();
      listeners.clear();
    },
  };
}

// Installed once, at module load — before any test file's own import of App/screens runs its
// top-level `export const api = window.nexus`, as long as this module is imported first.
export const fake = fakeApi();
(globalThis as unknown as { window: { nexus: Api } }).window.nexus = fake.api;

/** Stubs the IPC channels needed to get from the Templates list into a fully-mapped "Map inputs"
 * screen (folder-of-subfolders mode, every slot/field resolved), so individual tests can focus on
 * the behavior they're exercising instead of re-deriving this setup every time. */
export function stubBaseChannels() {
  fake.when("template:list", async () => [{ file: "promo-short.nexus.json", ok: true, errors: [], template: TEMPLATE }]);
  fake.when("input:pick-folder", async () => "/inputs/product-001");
  fake.when("input:load", async () => ({ columns: ["headline", "cta", "slug"], files: ["clip.mp4", "logo.png"], rowIds: ["row-1"] }));
  fake.when("batch:default-concurrency", async () => 1);
}

