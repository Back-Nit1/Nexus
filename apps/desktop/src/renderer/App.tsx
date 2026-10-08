import { useEffect, useRef, useState } from "react";
import type { BatchRowResult, BatchState, Mapping } from "@nexus/batch";
import type { Template } from "@nexus/template";
import type { Compiled } from "../shared/ipc";
import { api, BatchScreen, emptyMapping, MapScreen, PreviewScreen, TemplatesScreen, Errors } from "./screens";

const TABS = ["Templates", "Map inputs", "Preview & tweak", "Batch"] as const;
type Tab = (typeof TABS)[number];

/** A compiled result tagged with the edit generation it was produced for, so a template/mapping
 * change can be detected as making the current `compiled` stale even before a new compile returns. */
type Compilation = Compiled & { forGen: number };

export function App() {
  const [tab, setTab] = useState<Tab>("Templates");
  const [template, setTemplateRaw] = useState<Template>();
  const [savedTemplate, setSavedTemplate] = useState<Template>();
  const [draft, setDraft] = useState(false);
  const [saveErrors, setSaveErrors] = useState<Compiled["errors"]>();
  const [saving, setSaving] = useState(false);
  const [mapping, setMappingRaw] = useState<Mapping>(emptyMapping("folders"));
  const [compiled, setCompiled] = useState<Compilation>();
  const [batchId, setBatchId] = useState<string>();
  const [rows, setRows] = useState<BatchRowResult[]>([]);
  const [progress, setProgress] = useState<Record<string, { done: number; total: number }>>({});
  const [state, setState] = useState<BatchState>("idle");

  // Bumped by every template/mapping edit; a response tagged with an older generation is stale
  // and must never overwrite newer state (fixes stale compile/preview races, and "old timeline
  // still shown as current after the template or mapping changed").
  const gen = useRef(0);
  const compileSeq = useRef(0);

  useEffect(() => {
    const offs = [
      api.on("batch:row", ({ batchId: id, row }) => {
        if (id !== batchId) return; // drop events from a superseded batch
        setRows((rs) => (rs.some((x) => x.rowId === row.rowId) ? rs.map((x) => (x.rowId === row.rowId ? row : x)) : [...rs, row]));
      }),
      api.on("batch:progress", (p) => p.batchId === batchId && setProgress((ps) => ({ ...ps, [p.rowId]: p }))),
      api.on("batch:state", (s) => s.batchId === batchId && setState(s.state)),
    ];
    return () => offs.forEach((off) => off());
  }, [batchId]);

  const setTemplate = (t: Template | undefined) => {
    gen.current++;
    setTemplateRaw(t);
  };
  const setMapping = (m: Mapping) => {
    gen.current++;
    setMappingRaw(m);
  };

  const recompile = async (t = template, m = mapping) => {
    if (!t) return;
    const myGen = gen.current;
    const seq = ++compileSeq.current;
    try {
      const c = await api.invoke("timeline:compile-preview", { template: t, mapping: m });
      if (seq !== compileSeq.current) return; // a newer compile request already superseded this one
      setCompiled({ ...c, forGen: myGen });
    } catch (e) {
      if (seq !== compileSeq.current) return;
      setCompiled({ errors: [{ code: "IPC_ERROR", path: "", message: String(e) }], forGen: myGen });
    }
  };
  const stale = compiled !== undefined && compiled.forGen !== gen.current;

  const open = (t: Template, isDraft: boolean) => {
    // Reset every downstream workflow's state so nothing from the previous template leaks in.
    gen.current++;
    setTemplateRaw(t);
    setSavedTemplate(isDraft ? undefined : t);
    setDraft(isDraft);
    setSaveErrors(undefined);
    setMappingRaw(emptyMapping("folders"));
    setCompiled(undefined);
    setBatchId(undefined);
    setRows([]);
    setProgress({});
    setState("idle");
    setTab("Map inputs");
  };
  const dirty = template !== undefined && JSON.stringify(template) !== JSON.stringify(savedTemplate);
  const save = async () => {
    if (!template || saving) return;
    setSaving(true);
    try {
      const e = await api.invoke("template:save", template);
      setSaveErrors(e.errors);
      if (e.ok && e.template) {
        setSavedTemplate(e.template);
        setDraft(false);
      }
    } catch (err) {
      setSaveErrors([{ code: "IPC_ERROR", path: "", message: String(err) }]);
    } finally {
      setSaving(false);
    }
  };
  const revert = () => {
    if (savedTemplate) setTemplate(savedTemplate);
    else {
      setTemplateRaw(undefined);
      setDraft(false);
      setTab("Templates");
    }
  };

  const start = async (concurrency: number) => {
    setProgress({});
    setRows([]);
    const r = await api.invoke("batch:start", { template: template!, mapping, concurrency });
    setBatchId(r.batchId);
    setRows(r.rows);
  };

  const canStartBatch = !!compiled?.timeline && !stale && !compiled.errors?.length;

  return (
    <div className="app">
      <nav aria-label="Workflow">
        {TABS.map((t, i) => (
          <button
            key={t}
            aria-current={t === tab ? "step" : undefined}
            className={t === tab ? "tab on" : "tab"}
            disabled={t !== "Templates" && !template}
            onClick={() => setTab(t)}
          >
            <span className="step" aria-hidden="true">{i + 1}</span>
            {t}
          </button>
        ))}
        <span className="grow" />
        {template && (
          <span className="identity">
            <span className="badge">{template.name} · v{template.version}</span>
            {draft && <span className="badge warn">unsaved draft</span>}
            {!draft && dirty && <span className="badge warn">unsaved edits</span>}
          </span>
        )}
        {template && (dirty || draft) && (
          <>
            <button onClick={revert}>Revert</button>
            <button className="primary" disabled={saving} onClick={save}>
              {saving ? "Saving…" : draft ? "Approve & save" : "Save"}
            </button>
          </>
        )}
      </nav>
      <Errors errors={saveErrors} />
      <main>
        {tab === "Templates" && <TemplatesScreen onOpen={open} />}
        {tab === "Map inputs" && template && (
          <MapScreen template={template} mapping={mapping} setMapping={setMapping} compiled={compiled} stale={stale} recompile={() => recompile()} next={() => setTab("Preview & tweak")} />
        )}
        {tab === "Preview & tweak" && template && (
          <PreviewScreen template={template} setTemplate={setTemplate} mapping={mapping} setMapping={setMapping} compiled={compiled} stale={stale} recompile={recompile} />
        )}
        {tab === "Batch" && template && (
          <BatchScreen rows={rows} progress={progress} state={state} start={start} canStart={canStartBatch} />
        )}
      </main>
    </div>
  );
}
