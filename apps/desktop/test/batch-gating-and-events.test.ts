/** @vitest-environment jsdom */
// Start Batch must stay disabled without a current successful compile, batch:row updates must
// upsert (not silently drop events for rows missing from the initial list), and events from a
// superseded batchId must never be applied to the currently displayed batch.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fake, stubBaseChannels, timeline } from "./helpers";
import { App } from "../src/renderer/App";

beforeEach(() => fake.reset());
afterEach(cleanup);

async function toBatchScreen(user: ReturnType<typeof userEvent.setup>, { compiled = true } = {}) {
  stubBaseChannels();
  render(h(App));
  await screen.findByText("promo-short.nexus.json");
  await user.click(screen.getByText("promo-short.nexus.json"));
  await user.click(screen.getByRole("button", { name: "Open" }));
  await user.click(screen.getByRole("button", { name: "Choose folder" }));
  await screen.findByText("1 rows");
  await user.selectOptions(screen.getByTestId("slot-hookClip"), "clip.mp4");
  await user.selectOptions(screen.getByTestId("slot-logo"), "logo.png");
  if (compiled) {
    fake.when("timeline:compile-preview", async () => ({ rowId: "row-1", timeline: timeline() }));
    await user.click(screen.getByRole("button", { name: "Preview row 1" }));
    await screen.findByTestId("total-frames");
  }
  await user.click(screen.getByRole("button", { name: "Batch" }));
}

describe("Start Batch gating", () => {
  it("is disabled until a row has compiled successfully", async () => {
    const user = userEvent.setup();
    await toBatchScreen(user, { compiled: false });
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(screen.getByText(/Compile a row/)).toBeInTheDocument();
  });

  it("is enabled once row 1 has a fresh compiled timeline", async () => {
    const user = userEvent.setup();
    await toBatchScreen(user, { compiled: true });
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("goes back to disabled if the template changes after a successful compile (stale)", async () => {
    const user = userEvent.setup();
    await toBatchScreen(user, { compiled: true });
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Preview & tweak" }));
    await user.type(screen.getByTestId("text-0-0"), "!");
    await user.click(screen.getByRole("button", { name: "Batch" }));
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  });
});

describe("batch events", () => {
  it("upserts a row update even when the row was not in the initial batch:start response", async () => {
    const user = userEvent.setup();
    await toBatchScreen(user, { compiled: true });
    fake.when("batch:start", async () => ({ batchId: "b1", rows: [] })); // row-1 missing from the initial snapshot
    await user.click(screen.getByRole("button", { name: "Start" }));

    fake.emit("batch:row", { batchId: "b1", row: { rowId: "row-1", status: "rendering", inputHashes: {}, attempts: 1 } });
    await screen.findByTestId("row-row-1");
    expect(within(screen.getByTestId("row-row-1")).getByText("rendering")).toBeInTheDocument();
  });

  it("ignores row/progress/state events from a batch that was superseded by a newer one", async () => {
    const user = userEvent.setup();
    await toBatchScreen(user, { compiled: true });
    fake.when("batch:start", async () => ({ batchId: "old-batch", rows: [{ rowId: "row-1", status: "pending", inputHashes: {}, attempts: 0 }] }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByTestId("row-row-1");

    // A second start (e.g. after cancel+restart) gets a new batchId; late events tagged with the
    // old batchId must not be allowed to overwrite the new batch's state.
    fake.when("batch:start", async () => ({ batchId: "new-batch", rows: [{ rowId: "row-1", status: "pending", inputHashes: {}, attempts: 0 }] }));
    await user.click(screen.getByRole("button", { name: "Start" }));

    fake.emit("batch:row", { batchId: "old-batch", row: { rowId: "row-1", status: "failed", inputHashes: {}, attempts: 1, error: { code: "RENDER_FAILED", path: "", message: "stale" } } });
    await new Promise((r) => setTimeout(r, 0));
    expect(within(screen.getByTestId("row-row-1")).queryByText("failed")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("row-row-1")).getByText("pending")).toBeInTheDocument();

    fake.emit("batch:row", { batchId: "new-batch", row: { rowId: "row-1", status: "passed", inputHashes: {}, attempts: 1 } });
    await screen.findByText("passed");
  });
});
