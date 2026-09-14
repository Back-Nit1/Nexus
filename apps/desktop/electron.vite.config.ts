import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const workspace = ["@nexus/authoring", "@nexus/batch", "@nexus/perception", "@nexus/qa", "@nexus/renderer", "@nexus/template", "@nexus/timeline"];

export default defineConfig({
  // Workspace packages ship TS source, so bundle them; real npm deps stay external.
  main: { plugins: [externalizeDepsPlugin({ exclude: workspace })] },
  // Sandboxed preloads must be CommonJS.
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } } },
  renderer: { plugins: [react()] },
});
