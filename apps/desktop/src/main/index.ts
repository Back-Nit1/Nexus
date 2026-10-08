import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mediaUrl, type Channels, type Events, type TemplateEntry } from "../shared/ipc";

if (process.env.NEXUS_USER_DATA) app.setPath("userData", process.env.NEXUS_USER_DATA);
// Bundling breaks the packages' import.meta.url lookups, so point them at the pinned binaries and bundled fonts first.
const repo = resolve(app.getAppPath(), "../..");
process.env.NEXUS_VENDOR_DIR ??= join(repo, "vendor", "ffmpeg");
process.env.NEXUS_FONTS_DIR ??= join(repo, "packages", "renderer", "fonts");
const data = (...p: string[]) => join(app.getPath("userData"), ...p);
const inside = (p: string) => resolve(p).startsWith(app.getPath("userData") + sep);

protocol.registerSchemesAsPrivileged([{ scheme: "nexus-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const handle = <K extends keyof Channels>(ch: K, fn: (req: Channels[K][0]) => Promise<Channels[K][1]> | Channels[K][1]) => ipcMain.handle(ch, (_e, req) => fn(req));
const send = <K extends keyof Events>(ev: K, d: Events[K]) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(ev, d));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

app.whenReady().then(async () => {
  const [{ parseTemplate, validateTemplate }, { Batch, loadRows, Preparer, defaultConcurrency }, { render }] = await Promise.all([import("@nexus/template"), import("@nexus/batch"), import("@nexus/renderer")]);
  const preparer = new Preparer();

  protocol.handle("nexus-media", (req) => {
    const file = decodeURIComponent(new URL(req.url).pathname);
    return inside(file) ? net.fetch(pathToFileURL(file).toString(), { headers: req.headers }) : new Response("forbidden", { status: 403 });
  });

  // ----- templates -----
  const tdir = data("templates");
  if (!existsSync(tdir)) {
    await mkdir(tdir, { recursive: true });
    const seed = join(repo, "fixtures", "templates");
    for (const f of existsSync(seed) ? await readdir(seed) : []) await copyFile(join(seed, f), join(tdir, f));
  }
  const entry = async (file: string): Promise<TemplateEntry> => {
    const r = parseTemplate(await readFile(join(tdir, file), "utf8"));
    return r.ok ? { file, ok: true, errors: [], template: r.value } : { file, ok: false, errors: r.errors };
  };
  const pick = async (file: boolean, envPath: string | undefined) =>
    envPath ?? (await dialog.showOpenDialog({ properties: [file ? "openFile" : "openDirectory"], filters: file ? [{ name: "CSV", extensions: ["csv"] }] : undefined })).filePaths[0] ?? null;

  handle("template:list", async () => Promise.all((await readdir(tdir)).filter((f) => f.endsWith(".nexus.json")).sort().map(entry)));
  handle("template:import", async () => {
    const src = (await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "Nexus template", extensions: ["json"] }] })).filePaths[0];
    if (!src) return null;
    const file = basename(src).endsWith(".nexus.json") ? basename(src) : `${basename(src, ".json")}.nexus.json`;
    await copyFile(src, join(tdir, file));
    return entry(file);
  });
  handle("template:validate", (t) => {
    const r = validateTemplate(t);
    return { ok: r.ok, errors: r.ok ? [] : r.errors };
  });
  handle("template:save", async (t) => {
    const r = validateTemplate(t);
    if (!r.ok) return { file: "", ok: false, errors: r.errors };
    const file = `${r.value.id}.nexus.json`;
    await writeFile(join(tdir, file), JSON.stringify(r.value, null, 2) + "\n");
    return entry(file);
  });

  // ----- inputs & preview (same Preparer/compiler as batch) -----
  handle("input:pick-csv", () => pick(true, process.env.NEXUS_E2E_PICK_CSV));
  handle("input:pick-folder", () => pick(false, process.env.NEXUS_E2E_PICK));
  handle("input:load", async (m) => {
    try {
      const r = await loadRows(m);
      return { columns: r.columns, files: r.files, rowIds: r.rows.map((x) => x.id) };
    } catch (e) {
      return { error: message(e) };
    }
  });
  handle("timeline:compile-preview", async ({ template, mapping }) => {
    const v = validateTemplate(template);
    if (!v.ok) return { errors: v.errors };
    try {
      const [row] = (await loadRows(mapping)).rows;
      if (!row) return { errors: [{ code: "NO_ROWS", path: "", message: "Input has no rows" }] };
      const c = await preparer.compileRow(v.value, row);
      return { rowId: row.id, timeline: c.timeline, errors: c.errors };
    } catch (e) {
      return { errors: [{ code: "INPUT_ERROR", path: "", message: message(e) }] };
    }
  });
  handle("preview:render", async (t) => {
    try {
      const out = data("previews", `${createHash("sha256").update(JSON.stringify(t)).digest("hex").slice(0, 16)}.mp4`);
      if (!existsSync(out)) await render(t, { jobDir: data("previews", "job"), cacheDir: data("cache"), output: out });
      return { url: mediaUrl(out) };
    } catch (e) {
      return { error: message(e) };
    }
  });

  // ----- batch -----
  let batch: Awaited<ReturnType<typeof Batch.open>> | undefined;
  handle("batch:start", async ({ template, mapping, concurrency }) => {
    if (batch && (batch.state === "running" || batch.state === "paused")) throw new Error("A batch is already running");
    const batchId = `${template.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const b = (batch = await Batch.open({ dir: data("batches", batchId), template, mapping, batchId, cacheDir: data("cache"), concurrency }));
    b.on("row", (row) => send("batch:row", { batchId, row }));
    b.on("progress", (p) => send("batch:progress", { batchId, ...p }));
    b.on("state", (state) => send("batch:state", { batchId, state }));
    b.start().catch((e) => (console.error(e), send("batch:state", { batchId, state: "done" })));
    return { batchId, rows: b.results.rows };
  });
  handle("batch:pause", () => batch?.pause());
  handle("batch:resume", () => batch?.resume());
  handle("batch:cancel", () => batch?.cancel());
  handle("batch:concurrency", (n) => batch?.setConcurrency(n));
  handle("batch:default-concurrency", () => defaultConcurrency());
  handle("file:open", async (p) => void (inside(p) && (await shell.openPath(p))));

  // ----- AI authoring (template drafts only; never used by compile/render) -----
  handle("author:draft", async (description) => {
    try {
      const { draftTemplate } = await import("@nexus/authoring");
      const r = await draftTemplate(description);
      return r.status === "valid" ? { template: r.template } : { message: r.message };
    } catch (e) {
      return { error: message(e) };
    }
  });

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: "#15171a",
    webPreferences: { preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
});

app.on("window-all-closed", () => app.quit());
