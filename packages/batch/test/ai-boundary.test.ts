// Walks the import graph from every deterministic entry point (render, compile, batch, QA, perception) through
// workspace packages and installed dependencies, and fails if any AI SDK / AI integration package is reachable.
import { builtinModules } from "node:module";
import { existsSync, readFileSync, realpathSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ENTRIES = ["renderer", "template", "batch", "qa", "perception", "timeline"].map((p) => join(ROOT, "packages", p, "src/index.ts"));
const AI = /^(@anthropic-ai\/|anthropic$|openai$|@openai\/|@google\/(generative-ai|genai)|@google-cloud\/vertexai|@ai-sdk\/|ai$|langchain|@langchain\/|llamaindex|ollama$|cohere-ai$|@mistralai\/|replicate$|@huggingface\/|@nexus\/authoring$)/;
const IMPORT = /(?:^|[^\w.])(?:import|export)\s*(?:[\w*{}\s,$]*\sfrom\s*)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
const pkgName = (spec: string) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");

export function reachable(entries: string[]) {
  const files = new Set<string>(), packages = new Set<string>();
  const findPkg = (name: string, from: string) => {
    for (let d = from; ; d = dirname(d)) {
      const p = join(d, "node_modules", name, "package.json");
      if (existsSync(p)) return realpathSync(p);
      if (dirname(d) === d) return null;
    }
  };
  const visitPackage = (name: string, from: string) => {
    if (packages.has(name)) return;
    packages.add(name);
    const pj = findPkg(name, from);
    if (!pj) return;
    const json = JSON.parse(readFileSync(pj, "utf8"));
    for (const dep of Object.keys({ ...json.dependencies, ...json.optionalDependencies, ...json.peerDependencies })) visitPackage(dep, dirname(pj));
  };
  const visitFile = (file: string) => {
    if (files.has(file) || !existsSync(file)) return;
    files.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith(".")) {
        const base = resolve(dirname(file), spec);
        visitFile([base, `${base}.ts`, join(base, "index.ts")].find((f) => existsSync(f) && !f.endsWith("/")) ?? base);
      } else if (spec.startsWith("node:") || builtinModules.includes(spec)) continue;
      else if (spec.startsWith("@nexus/")) {
        packages.add(pkgName(spec));
        const dir = join(ROOT, "packages", spec.split("/")[1]);
        if (!existsSync(join(dir, "package.json"))) continue;
        const exp = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).exports ?? {};
        visitFile(join(dir, exp["." + spec.slice(pkgName(spec).length)] ?? "src/index.ts"));
      } else visitPackage(pkgName(spec), dirname(file));
    }
  };
  entries.forEach(visitFile);
  return { files, packages };
}

describe("AI boundary", () => {
  it("no AI SDK or AI integration is reachable from render/compile/batch/QA entry points", () => {
    const { files, packages } = reachable(ENTRIES);
    expect(packages).toContain("execa"); // walker really reaches third-party deps
    expect(packages).toContain("zod");
    expect(files.size).toBeGreaterThan(8);
    expect([...packages].filter((p) => AI.test(p))).toEqual([]);
  });

  it("detects an AI dependency when one is imported (negative control)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-ai-"));
    writeFileSync(join(dir, "a.ts"), `import { x } from "./b.ts";\n`);
    writeFileSync(join(dir, "b.ts"), `export { draft } from "@nexus/authoring";\nconst sdk = await import("@anthropic-ai/sdk");\n`);
    const { packages } = reachable([join(dir, "a.ts")]);
    expect([...packages].filter((p) => AI.test(p)).sort()).toEqual(["@anthropic-ai/sdk", "@nexus/authoring"]);
  });
});
