/** @vitest-environment jsdom */
// State must not leak between workflows (opening a template resets mapping/compiled/batch state),
// and edited templates must show a dirty indicator with working Save/Revert.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fake, stubBaseChannels, TEMPLATE } from "./helpers";
import { App } from "../src/renderer/App";

beforeEach(() => fake.reset());
afterEach(cleanup);

async function openTemplate(user: ReturnType<typeof userEvent.setup>) {
  stubBaseChannels();
  render(h(App));
  await screen.findByText("promo-short.nexus.json");
  await user.click(screen.getByText("promo-short.nexus.json"));
  await user.click(screen.getByRole("button", { name: "Open" }));
  await screen.findByRole("button", { name: "Choose folder" });
}

describe("workflow reset on open", () => {
  it("clears mapping, compiled preview, and batch rows left over from a previous template", async () => {
    const user = userEvent.setup();
    await openTemplate(user);

    // Map a folder and resolve every required slot so a compile is possible.
    await user.click(screen.getByRole("button", { name: "Choose folder" }));
    await screen.findByText("1 rows");
    await user.selectOptions(screen.getByTestId("slot-hookClip"), "clip.mp4");
    await user.selectOptions(screen.getByTestId("slot-logo"), "logo.png");
    expect(screen.queryByText("Unresolved")).not.toBeInTheDocument();

    fake.when("timeline:compile-preview", async () => ({ rowId: "row-1", timeline: undefined, errors: [{ code: "NO_ROWS", path: "", message: "n/a" }] }));
    await user.click(screen.getByRole("button", { name: "Preview row 1" }));
    await screen.findByText("NO_ROWS");

    // Re-opening the same template (simulating "open a different/same template again") must wipe
    // the mapping and compile state rather than carrying it forward.
    await user.click(screen.getByRole("button", { name: "Templates" }));
    await user.click(screen.getByText("promo-short.nexus.json"));
    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(screen.queryByText("NO_ROWS")).not.toBeInTheDocument();
    expect((screen.getByRole("button", { name: "Choose folder" }).nextSibling as HTMLElement).textContent).toBe("-");
  });
});

describe("dirty state, save, and revert", () => {
  it("shows an unsaved-edits badge after a template edit, and Save persists it", async () => {
    const user = userEvent.setup();
    await openTemplate(user);
    await user.click(screen.getByRole("button", { name: "Preview & tweak" }));

    expect(screen.queryByText("unsaved edits")).not.toBeInTheDocument();
    const textInput = screen.getByTestId("text-0-0");
    await user.clear(textInput);
    await user.type(textInput, "{{row.headline}} now");
    await screen.findByText("unsaved edits");

    let saved: unknown;
    fake.when("template:save", async (t) => {
      saved = t;
      return { file: "promo-short.nexus.json", ok: true, errors: [], template: t };
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved).toBeTruthy());
    await waitFor(() => expect(screen.queryByText("unsaved edits")).not.toBeInTheDocument());
  });

  it("Revert restores the last-saved template and discards the edit", async () => {
    const user = userEvent.setup();
    await openTemplate(user);
    await user.click(screen.getByRole("button", { name: "Preview & tweak" }));

    const textInput = screen.getByTestId("text-0-0");
    await user.clear(textInput);
    await user.type(textInput, "changed");
    await screen.findByText("unsaved edits");

    await user.click(screen.getByRole("button", { name: "Revert" }));
    expect(screen.queryByText("unsaved edits")).not.toBeInTheDocument();
    expect((screen.getByTestId("text-0-0") as HTMLInputElement).value).toBe(TEMPLATE.zones[0].text[0].text);
  });
});
