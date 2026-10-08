import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BatchRowResult, BatchState, Mapping } from "@nexus/batch";
import type { Template } from "@nexus/template";
import { framesToTimestamp, type StructuredError } from "@nexus/timeline";
import { mediaUrl, type Api, type Channels, type Compiled, type TemplateEntry } from "../shared/ipc";

declare global {
  interface Window {
    nexus: Api;
  }
}
export const api = window.nexus;

export const emptyMapping = (mode: Mapping["mode"]): Mapping =>
  mode === "csv" ? { mode, csv: "", mediaDir: "", idColumn: "id", fields: {}, slots: {} } : { mode, root: "", fields: {}, slots: {} };

const base = (p: string) => p.split(/[\\/]+/).pop();
const zoneFrames = (t: Template) => t.zones.reduce((s, z) => s + z.frames, 0);
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const Errors = ({ errors }: { errors?: StructuredError[] }) =>
  errors?.length ? (
    <ul className="errors" role="alert">
      {errors.map((e, i) => (
        <li key={i}>
          <b>{e.code}</b> <code>{e.path || "-"}</code> {e.message}
        </li>
      ))}
    </ul>
  ) : null;

const Select = ({ value, options, onChange, testid, label }: { value: string; options: string[]; onChange: (v: string) => void; testid?: string; label?: string }) => (
  <select data-testid={testid} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
    <option value="">-</option>
    {options.map((o) => (
      <option key={o}>{o}</option>
    ))}
  </select>
);

const Num = ({ label, value, step = 1, onChange }: { label: string; value: number; step?: number; onChange: (v: number) => void }) => (
  <label>
    {label} <input type="number" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
  </label>
);

const Panel = ({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) => (
  <section className="panel">
    <header>
      <h2>{title}</h2>
      {actions}
    </header>
    {children}
  </section>
);

/** Badge that explains why an action is blocked, for screen readers and sighted users alike. */
const Blocked = ({ reason }: { reason?: string }) => (reason ? <span className="hint">{reason}</span> : null);

// ---------------- Templates ----------------

export function TemplatesScreen({ onOpen }: { onOpen: (t: Template, draft: boolean) => void }) {
  const [entries, setEntries] = useState<TemplateEntry[]>([]);
  const [sel, setSel] = useState<string>();
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [draft, setDraft] = useState<Channels["author:draft"][1]>();
  const [listError, setListError] = useState<string>();
  const refresh = async () => {
    try {
      setEntries(await api.invoke("template:list"));
      setListError(undefined);
    } catch (e) {
      setListError(errorMessage(e));
    }
  };
  useEffect(() => void refresh(), []);
  const cur = entries.find((e) => e.file === sel);
  const t = cur?.template;

  const doImport = async () => {
    setImporting(true);
    try {
      const e = await api.invoke("template:import");
      if (e) {
        await refresh();
        setSel(e.file);
      }
    } catch (e) {
      setListError(errorMessage(e));
    } finally {
      setImporting(false);
    }
  };
  const draftTemplate = async () => {
    setBusy(true);
    try {
      setDraft(await api.invoke("author:draft", desc));
    } catch (e) {
      setDraft({ error: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cols">
      <Panel
        title="Templates"
        actions={
          <>
            <button disabled={importing} onClick={doImport}>{importing ? "Importing…" : "Import"}</button>
            <button onClick={refresh}>Revalidate</button>
          </>
        }
      >
        {listError && <p className="error">{listError}</p>}
        {entries.length === 0 && !listError && <p className="empty-note">No templates yet. Import a .nexus.json file to get started.</p>}
        <ul className="list">
          {entries.map((e) => (
            <li key={e.file} className={e.file === sel ? "on" : ""} onClick={() => setSel(e.file)}>
              <span>{e.file}</span>
              <span className={`badge ${e.ok ? "passed" : "failed"}`}>{e.ok ? "valid" : `${e.errors.length} errors`}</span>
            </li>
          ))}
        </ul>
        {cur && !cur.ok && <Errors errors={cur.errors} />}
        {t && (
          <div className="detail">
            <dl>
              <dt>id</dt><dd>{t.id}</dd>
              <dt>canvas</dt><dd>{t.canvas.width}×{t.canvas.height} @ {t.canvas.fps.numerator}/{t.canvas.fps.denominator}</dd>
              <dt>duration</dt><dd>{zoneFrames(t)} frames · {framesToTimestamp(zoneFrames(t), t.canvas.fps)}</dd>
              <dt>zones</dt><dd>{t.zones.map((z) => z.id).join(", ")}</dd>
              <dt>slots</dt><dd>{t.slots.map((s) => `${s.id}:${s.kind}`).join(", ")}</dd>
              <dt>fields</dt><dd>{t.fields.map((f) => f.id).join(", ")}</dd>
            </dl>
            <button className="primary" onClick={() => onOpen(t, false)}>Open</button>
          </div>
        )}
      </Panel>
      <Panel title="Describe the edit">
        <textarea rows={6} value={desc} placeholder="15s vertical reel. Hook clip 2s, then 3 sharp clips…" onChange={(e) => setDesc(e.target.value)} />
        <div className="row">
          <button disabled={!desc || busy} onClick={draftTemplate}>
            {busy ? "Drafting…" : "Draft template"}
          </button>
        </div>
        {draft?.error && <p className="error">{draft.error}</p>}
        {draft?.message && <p className="note">{draft.message}</p>}
        {draft?.template && (
          <>
            <div className="row">
              <span className="badge passed">validated</span>
              <button className="primary" onClick={() => onOpen(draft.template!, true)}>Preview draft</button>
            </div>
            <pre>{JSON.stringify(draft.template, null, 2)}</pre>
          </>
        )}
      </Panel>
    </div>
  );
}

// ---------------- Map inputs ----------------

function useInputInfo(mapping: Mapping) {
  const [info, setInfo] = useState<{ columns: string[]; files: string[]; rowIds: string[]; error?: string }>();
  const key = mapping.mode === "csv" ? `${mapping.csv}|${mapping.mediaDir}` : mapping.root;
  const seq = useRef(0);
  useEffect(() => {
    const mySeq = ++seq.current;
    if (key === "|" || !key) return setInfo(undefined);
    api.invoke("input:load", mapping).then(
      (r) => mySeq === seq.current && setInfo("error" in r ? { columns: [], files: [], rowIds: [], error: r.error } : r),
      (e) => mySeq === seq.current && setInfo({ columns: [], files: [], rowIds: [], error: errorMessage(e) }),
    );
  }, [mapping.mode, key]);
  return info;
}

const Summary = ({ compiled, stale }: { compiled?: Compiled; stale?: boolean }) => {
  const t = compiled?.timeline;
  return (
    <>
      {t && (
        <div className={`row${stale ? " stale" : ""}`}>
          <span className={`badge ${stale ? "warn" : "passed"}`}>{stale ? "stale" : "compiled"}</span>
          <span>row {compiled!.rowId}</span>
          <span data-testid="total-frames">{t.totalFrames} frames</span>
          <span>{framesToTimestamp(t.totalFrames, t.canvas.fps)}</span>
          <span>{t.segments.length} segments</span>
          <span>{t.overlays.length} text</span>
          <code>{t.output}</code>
        </div>
      )}
      <Errors errors={compiled?.errors} />
    </>
  );
};

export function MapScreen({ template, mapping, setMapping, compiled, stale, recompile, next }: { template: Template; mapping: Mapping; setMapping: (m: Mapping) => void; compiled?: Compiled; stale?: boolean; recompile: () => void; next: () => void }) {
  const info = useInputInfo(mapping);
  const set = (patch: object) => setMapping({ ...mapping, ...patch } as Mapping);
  // Convenience: columns named exactly like a field are mapped automatically.
  useEffect(() => {
    if (!info) return;
    const auto = Object.fromEntries(template.fields.filter((f) => info.columns.includes(f.id)).map((f) => [f.id, f.id]));
    if (Object.keys(auto).some((k) => !mapping.fields[k])) set({ fields: { ...auto, ...mapping.fields } });
  }, [info]);
  const csv = mapping.mode === "csv";
  const ready = csv ? !!(mapping.csv && mapping.mediaDir) : !!mapping.root;
  const unresolved = [...template.fields.filter((f) => f.required && !mapping.fields[f.id]).map((f) => f.id), ...template.slots.filter((s) => s.required && !mapping.slots[s.id]).map((s) => s.id)];
  const pickTo = (key: string, csvFile = false) => async () => {
    try {
      const p = await api.invoke(csvFile ? "input:pick-csv" : "input:pick-folder");
      if (p) set({ [key]: p });
    } catch {
      // dialog cancelled or unavailable; nothing to apply
    }
  };

  return (
    <Panel
      title="Map inputs"
      actions={
        <div className="seg" role="group" aria-label="Input source">
          <button className={csv ? "on" : ""} onClick={() => setMapping(emptyMapping("csv"))}>CSV + media</button>
          <button className={!csv ? "on" : ""} onClick={() => setMapping(emptyMapping("folders"))}>Folder of subfolders</button>
        </div>
      }
    >
      {mapping.mode === "csv" ? (
        <>
          <div className="row"><button onClick={pickTo("csv", true)}>Choose CSV</button><code>{mapping.csv || "-"}</code></div>
          <div className="row"><button onClick={pickTo("mediaDir")}>Choose media folder</button><code>{mapping.mediaDir || "-"}</code></div>
        </>
      ) : (
        <div className="row"><button onClick={pickTo("root")}>Choose folder</button><code>{mapping.root || "-"}</code></div>
      )}
      {info && (
        <div className="row">
          <span className="badge">{info.rowIds.length} rows</span>
          <span className="badge">{info.files.length} files</span>
          <span className="badge">{info.columns.length} columns</span>
        </div>
      )}
      {info?.error && <p className="error">{info.error}</p>}
      {info && (
        <table className="map">
          <tbody>
            {mapping.mode === "csv" && (
              <>
                <tr><th>id</th><td>column</td><td><Select label="id column" value={mapping.idColumn} options={info.columns} onChange={(v) => set({ idColumn: v })} /></td></tr>
                <tr><th>pool</th><td>column (optional)</td><td><Select label="pool column" value={mapping.poolColumn ?? ""} options={info.columns} onChange={(v) => set({ poolColumn: v || undefined })} /></td></tr>
              </>
            )}
            {template.fields.map((f) => (
              <tr key={f.id}>
                <th>{f.id}{f.required && " *"}</th>
                <td>field</td>
                <td><Select testid={`field-${f.id}`} label={`${f.id} field`} value={mapping.fields[f.id] ?? ""} options={info.columns} onChange={(v) => set({ fields: { ...mapping.fields, [f.id]: v } })} /></td>
              </tr>
            ))}
            {template.slots.map((s) => (
              <tr key={s.id}>
                <th>{s.id}{s.required && " *"}</th>
                <td>{s.kind}</td>
                <td><Select testid={`slot-${s.id}`} label={`${s.id} slot`} value={mapping.slots[s.id] ?? ""} options={csv ? info.columns : info.files} onChange={(v) => set({ slots: { ...mapping.slots, [s.id]: v } })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {unresolved.length > 0 && (
        <div className="row">
          <span>Unresolved</span>
          {unresolved.map((u) => <span key={u} className="badge failed">{u}</span>)}
        </div>
      )}
      <div className="row">
        <button className="primary" disabled={!ready || unresolved.length > 0} onClick={recompile}>Preview row 1</button>
        {compiled?.timeline && !stale && <button onClick={next}>Preview & tweak →</button>}
      </div>
      <Summary compiled={compiled} stale={stale} />
    </Panel>
  );
}

// ---------------- Preview & tweak ----------------

export function PreviewScreen({ template, setTemplate, mapping, setMapping, compiled, stale, recompile }: { template: Template; setTemplate: (t: Template) => void; mapping: Mapping; setMapping: (m: Mapping) => void; compiled?: Compiled; stale?: boolean; recompile: (t?: Template, m?: Mapping) => void }) {
  const info = useInputInfo(mapping);
  const [url, setUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [renderError, setRenderError] = useState<string>();
  const [frame, setFrame] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const first = useRef(true);
  const renderSeq = useRef(0);
  const tl = compiled?.timeline;
  const fps = template.canvas.fps;
  const total = tl?.totalFrames ?? zoneFrames(template);
  const pct = (f: number) => `${(f / total) * 100}%`;

  useEffect(() => setUrl(undefined), [tl]);
  // Every allowed edit rewrites the template, then revalidates + recompiles through the real compiler.
  useEffect(() => {
    if (first.current) return void (first.current = false);
    const id = setTimeout(() => recompile(template, mapping), 400);
    return () => clearTimeout(id);
  }, [template, mapping]);

  const edit = (fn: (d: Template) => void) => {
    const next = structuredClone(template);
    fn(next);
    if (next.totalFrames !== undefined) next.totalFrames = zoneFrames(next);
    setTemplate(next);
  };
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.max(0, Math.min(total - 1, Math.floor(((e.clientX - r.left) / r.width) * total)));
    setFrame(f);
    if (video.current) video.current.currentTime = (f * fps.denominator) / fps.numerator;
  };
  const renderPreview = async () => {
    if (!tl) return;
    const mySeq = ++renderSeq.current;
    setBusy(true);
    setRenderError(undefined);
    try {
      const r = await api.invoke("preview:render", tl);
      if (mySeq !== renderSeq.current) return; // timeline changed/another render started meanwhile
      setUrl(r.url);
      setRenderError(r.error);
    } catch (e) {
      if (mySeq !== renderSeq.current) return;
      setRenderError(errorMessage(e));
    } finally {
      if (mySeq === renderSeq.current) setBusy(false);
    }
  };
  const step = Math.max(1, Math.round(total / 10));
  let at = 0;

  return (
    <div className="preview">
      <div className="cols">
        <Panel title="Player">
          {url ? (
            <video ref={video} src={url} controls onTimeUpdate={(e) => setFrame(Math.min(total - 1, Math.floor((e.currentTarget.currentTime * fps.numerator) / fps.denominator)))} />
          ) : (
            <div className="empty" style={{ aspectRatio: `${template.canvas.width}/${template.canvas.height}` }}>no preview</div>
          )}
          <div className="row">
            <button className="primary" disabled={!tl || stale || busy} onClick={renderPreview}>
              {busy ? "Rendering…" : "Render preview"}
            </button>
            <Blocked reason={stale ? "Template or inputs changed — recompiling…" : !tl ? "Compile a row before rendering" : undefined} />
            <span className="badge">frame {frame}</span>
            <span className="badge">{framesToTimestamp(frame, fps)}</span>
          </div>
          {renderError && <p className="error">{renderError}</p>}
        </Panel>
        <Panel title="Tweak">
          <div className="edits">
            {template.zones.map((z, i) => (
              <fieldset key={i}>
                <legend>{z.id} <span className="badge">{z.fill.type}</span></legend>
                <Num label="frames" value={z.frames} onChange={(v) => edit((d) => void (d.zones[i].frames = Math.max(1, Math.round(v) || 1)))} />
                {z.text.map((x, j) => {
                  const lo = typeof x.size === "number" ? x.size : x.size.min, hi = typeof x.size === "number" ? x.size : x.size.max;
                  const tx = (fn: (d: Template["zones"][0]["text"][0]) => void) => edit((d) => fn(d.zones[i].text[j]));
                  return (
                    <div key={j} className="textedit">
                      <label>text <input data-testid={`text-${i}-${j}`} value={x.text} onChange={(e) => tx((d) => void (d.text = e.target.value))} /></label>
                      <Num label="x" step={0.01} value={x.position.x} onChange={(v) => tx((d) => void (d.position.x = v))} />
                      <Num label="y" step={0.01} value={x.position.y} onChange={(v) => tx((d) => void (d.position.y = v))} />
                      <Num label="size min" value={lo} onChange={(v) => tx((d) => void (d.size = { min: v, max: hi }))} />
                      <Num label="max" value={hi} onChange={(v) => tx((d) => void (d.size = { min: lo, max: v }))} />
                    </div>
                  );
                })}
              </fieldset>
            ))}
            <fieldset>
              <legend>slots</legend>
              {template.slots.map((s) => (
                <label key={s.id}>
                  {s.id} <Select value={mapping.slots[s.id] ?? ""} options={(mapping.mode === "csv" ? info?.columns : info?.files) ?? []} onChange={(v) => setMapping({ ...mapping, slots: { ...mapping.slots, [s.id]: v } })} />
                </label>
              ))}
            </fieldset>
          </div>
          <Summary compiled={compiled} stale={stale} />
        </Panel>
      </div>

      <div className={`timeline${stale ? " stale" : ""}`}>
        <div className="labels"><div>time</div><div>zones</div><div>picture</div><div>text</div></div>
        <div className="tracks" onClick={seek}>
          <div className="track ruler">
            {Array.from({ length: Math.ceil(total / step) }, (_, k) => k * step).map((f) => (
              <span key={f} style={{ left: pct(f) }}>{framesToTimestamp(f, fps).slice(3, 8)} <small>{f}</small></span>
            ))}
          </div>
          <div className="track">
            {template.zones.map((z, i) => {
              const s = at;
              at += z.frames;
              return <div key={i} className="block zone" style={{ left: pct(s), width: pct(z.frames) }}>{z.id} · {z.frames}f</div>;
            })}
          </div>
          <div className="track">
            {tl?.segments.map((s, i) => (
              <div key={i} className="block clip" title={`${s.startFrame}-${s.endFrame}`} style={{ left: pct(s.startFrame), width: pct(s.endFrame - s.startFrame) }}>
                {s.source.kind === "color" ? `#${s.source.color}` : base(s.source.path)}
              </div>
            ))}
          </div>
          <div className="track">
            {tl?.overlays.map((o, i) => (
              <div key={i} className="block text" title={`${o.size}px`} style={{ left: pct(o.startFrame), width: pct(o.endFrame - o.startFrame) }}>
                {o.lines.map((l) => l.text).join(" / ")}
              </div>
            ))}
          </div>
          <div className="playhead" style={{ left: pct(frame) }} />
        </div>
      </div>
    </div>
  );
}

// ---------------- Batch ----------------

export function BatchScreen({ rows, progress, state, start, canStart }: { rows: BatchRowResult[]; progress: Record<string, { done: number; total: number }>; state: BatchState; start: (concurrency: number) => Promise<void>; canStart: boolean }) {
  const [concurrency, setConcurrency] = useState(1);
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  useEffect(() => void api.invoke("batch:default-concurrency").then(setConcurrency), []);
  const running = state === "running" || state === "paused";

  const doStart = async () => {
    setStarting(true);
    try {
      await start(concurrency);
      setError(undefined);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };
  const act = (fn: () => Promise<void>) => () => fn().catch((e) => setError(errorMessage(e)));

  return (
    <Panel title="Batch" actions={<span data-testid="batch-state" className={`badge ${state}`}>{state}</span>}>
      <div className="row">
        <label>
          concurrency{" "}
          <input data-testid="concurrency" type="number" min={1} value={concurrency} onChange={(e) => { const n = Math.max(1, Math.floor(Number(e.target.value)) || 1); setConcurrency(n); if (running) act(() => api.invoke("batch:concurrency", n))(); }} />
        </label>
        <button className="primary" disabled={running || !canStart || starting} onClick={doStart}>{starting ? "Starting…" : "Start"}</button>
        <Blocked reason={!running && !canStart ? "Compile a row in Preview & tweak before starting a batch" : undefined} />
        <button disabled={state !== "running"} onClick={act(() => api.invoke("batch:pause"))}>Pause</button>
        <button disabled={state !== "paused"} onClick={act(() => api.invoke("batch:resume"))}>Resume</button>
        <button disabled={!running} onClick={act(() => api.invoke("batch:cancel"))}>Cancel</button>
      </div>
      {error && <p className="error">{error}</p>}
      {rows.length === 0 ? (
        <p className="empty-note">No rows queued yet. Starting the batch will queue every valid input row.</p>
      ) : (
        <table className="grid">
          <thead><tr><th /><th>row</th><th>status</th><th>progress</th><th>QA</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => {
              const p = progress[r.rowId];
              const done = r.status === "passed" || r.status === "failed";
              return (
                <tr key={r.rowId} data-testid={`row-${r.rowId}`}>
                  <td>{r.thumbnail ? <img className="thumb" src={mediaUrl(r.thumbnail)} alt="" /> : <div className="thumb" />}</td>
                  <td>{r.rowId}</td>
                  <td>
                    <span className={`badge ${r.status}`}>{r.status}</span>
                    {r.error && <div className="error small">{r.error.code}: {r.error.message}</div>}
                  </td>
                  <td><progress max={1} value={done ? 1 : p ? p.done / p.total : 0} /></td>
                  <td>{r.qa && <span className={`badge ${r.qa.passed ? "passed" : "failed"}`} title={r.qa.checks.filter((c) => !c.passed).map((c) => c.name).join(", ")}>{r.qa.passed ? "QA pass" : "QA fail"}</span>}</td>
                  <td>{r.output && <button onClick={act(() => api.invoke("file:open", r.output!))}>Open</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
