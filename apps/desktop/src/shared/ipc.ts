// Typed IPC contract between Electron main and the React renderer. The preload exposes only these channels.
import type { BatchRowResult, BatchState, Mapping } from "@nexus/batch";
import type { Template } from "@nexus/template";
import type { StructuredError, Timeline } from "@nexus/timeline";

export type TemplateEntry = { file: string; ok: boolean; errors: StructuredError[]; template?: Template };
export type Compiled = { rowId?: string; timeline?: Timeline; errors?: StructuredError[] };
export type InputInfo = { columns: string[]; files: string[]; rowIds: string[] } | { error: string };

/** channel: [request, response] */
export type Channels = {
  "template:list": [void, TemplateEntry[]];
  "template:import": [void, TemplateEntry | null];
  "template:validate": [unknown, { ok: boolean; errors: StructuredError[] }];
  "template:save": [Template, TemplateEntry];
  "input:pick-csv": [void, string | null];
  "input:pick-folder": [void, string | null];
  "input:load": [Mapping, InputInfo];
  "timeline:compile-preview": [{ template: Template; mapping: Mapping }, Compiled];
  "preview:render": [Timeline, { url?: string; error?: string }];
  "batch:start": [{ template: Template; mapping: Mapping; concurrency: number }, { batchId: string; rows: BatchRowResult[] }];
  "batch:pause": [void, void];
  "batch:resume": [void, void];
  "batch:cancel": [void, void];
  "batch:concurrency": [number, void];
  "batch:default-concurrency": [void, number];
  "file:open": [string, void];
  "author:draft": [string, { template?: Template; message?: string; error?: string }];
};

export type Events = {
  "batch:row": BatchRowResult;
  "batch:progress": { rowId: string; done: number; total: number };
  "batch:state": BatchState;
};

// Record<keyof ...> makes these allowlists exhaustive at compile time.
const channels: Record<keyof Channels, 1> = {
  "template:list": 1, "template:import": 1, "template:validate": 1, "template:save": 1, "input:pick-csv": 1, "input:pick-folder": 1,
  "input:load": 1, "timeline:compile-preview": 1, "preview:render": 1, "batch:start": 1, "batch:pause": 1, "batch:resume": 1,
  "batch:cancel": 1, "batch:concurrency": 1, "batch:default-concurrency": 1, "file:open": 1, "author:draft": 1,
};
const events: Record<keyof Events, 1> = { "batch:row": 1, "batch:progress": 1, "batch:state": 1 };
export const CHANNELS = Object.keys(channels) as (keyof Channels)[];
export const EVENTS = Object.keys(events) as (keyof Events)[];

type Req<K extends keyof Channels> = Channels[K][0] extends void ? [] : [req: Channels[K][0]];
export type Api = {
  invoke<K extends keyof Channels>(channel: K, ...req: Req<K>): Promise<Channels[K][1]>;
  on<K extends keyof Events>(event: K, cb: (data: Events[K]) => void): () => void;
};

/** URL for a file under userData, served by main's nexus-media protocol. */
export const mediaUrl = (file: string) => `nexus-media://local${file.split("/").map(encodeURIComponent).join("/")}`;
