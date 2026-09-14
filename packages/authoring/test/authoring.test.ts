import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateTemplate } from "@nexus/template";
import { draftTemplate } from "../src/index.ts";

const good = JSON.parse(readFileSync(new URL("../../../fixtures/templates/promo-short.nexus.json", import.meta.url), "utf8"));

// Fake client: drives the real tools the way the model would (no network). Verifies the loop is wired to the one validator.
const fakeClient = (script: (tools: any[]) => Promise<string>) =>
  ({ beta: { messages: { toolRunner: async (p: any) => ({ stop_reason: "end_turn", content: [{ type: "text", text: await script(p.tools) }] }) } } }) as any;

describe("authoring", () => {
  it("returns only a template accepted by the real validator, after correcting structured errors", async () => {
    const r = await draftTemplate("15s reel", {
      client: fakeClient(async (tools) => {
        const validate = tools.find((t) => t.name === "validate_template");
        const bad = JSON.parse(await validate.run({ template: { ...good, totalFrames: 1 } }));
        expect(bad).toEqual({ ok: false, errors: (validateTemplate({ ...good, totalFrames: 1 }) as any).errors });
        expect(JSON.parse(await validate.run({ template: good }))).toEqual({ ok: true });
        expect(await tools.find((t) => t.name === "seconds_to_frames").run({ seconds: "2.05", numerator: 30, denominator: 1 })).toBe("62");
        return "Template validated.";
      }),
    });
    expect(r).toEqual({ status: "valid", template: good, validations: 2 });
  });

  it("reports missing information instead of inventing a template", async () => {
    const r = await draftTemplate("make a video", { client: fakeClient(async () => "The requested edit does not define a total duration or zone durations.") });
    expect(r).toEqual({ status: "no_template", message: "The requested edit does not define a total duration or zone durations.", validations: 0 });
  });
});
