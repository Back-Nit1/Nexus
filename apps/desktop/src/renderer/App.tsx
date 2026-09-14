import { useEffect, useState } from "react";
import type { BatchRowResult, BatchState, Mapping } from "@nexus/batch";
import type { Template } from "@nexus/template";
import type { Compiled } from "../shared/ipc";
import { api, BatchScreen, emptyMapping, MapScreen, PreviewScreen, TemplatesScreen, Errors } from "./screens";

const TABS = ["Templates", "Map inputs", "Preview & tweak", "Batch"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [tab, setTab] = useState<Tab>("Templates");
  const [template, setTemplate] = useState<Template>();
  const [draft, setDraft] = useState(false);
  const [saveErrors, setSaveErrors] = useState<Compiled["errors"]>();
  const [mapping, setMapping] = useState<Mapping>(emptyMapping("folders"));
  const [compiled, setCompiled] = useState<Compiled>();
  const [rows, setRows] = useState<BatchRowResult[]>([]);
  const [progress, setProgress] = useState<Record<string, { done: number; total: number }>>({});
  const [state, setState] = useState<BatchState>("idle");

  useEffect(() => {
    const offs = [
      api.on("batch:row", (r) => setRows((rs) => rs.map((x) => (x.rowId === r.rowId ? r : x)))),
      api.on("batch:progress", (p) => setProgress((ps) => ({ ...ps, [p.rowId]: p }))),
      api.on("batch:state", setState),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const recompile = async (t = template, m = mapping) => {
    if (!t) return;
    setCompiled(await api.invoke("timeline:compile-preview", { template: t, mapping: m }));
  };
  const open = (t: Template, isDraft: boolean) => {
    setTemplate(t);
    setDraft(isDraft);
    setCompiled(undefined);
    setTab("Map inputs");
  };
  const approve = async () => {
    const e = await api.invoke("template:save", template!);
    setSaveErrors(e.errors);
    if (e.ok) setDraft(false);
  };
  const start = async (concurrency: number) => {
    setProgress({});
    const r = await api.invoke("batch:start", { template: template!, mapping, concurrency });
    setRows(r.rows);
  };

  return (
    <div className="app">
      <nav>
        {TABS.map((t) => (
          <button key={t} className={t === tab ? "tab on" : "tab"} disabled={t !== "Templates" && !template} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
        <span className="grow" />
        {template && <span className="badge">{template.name} · v{template.version}</span>}
        {draft && <span className="badge warn">unsaved AI draft</span>}
        {draft && <button className="primary" onClick={approve}>Approve & save</button>}
      </nav>
      <Errors errors={saveErrors} />
      <main>
        {tab === "Templates" && <TemplatesScreen onOpen={open} />}
        {tab === "Map inputs" && template && <MapScreen template={template} mapping={mapping} setMapping={setMapping} compiled={compiled} recompile={() => recompile()} next={() => setTab("Preview & tweak")} />}
        {tab === "Preview & tweak" && template && <PreviewScreen template={template} setTemplate={setTemplate} mapping={mapping} setMapping={setMapping} compiled={compiled} recompile={recompile} />}
        {tab === "Batch" && template && <BatchScreen rows={rows} progress={progress} state={state} start={start} />}
      </main>
    </div>
  );
}
