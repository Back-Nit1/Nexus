/** @vitest-environment jsdom */
// Out-of-order IPC responses must never overwrite a newer result, and a rejected IPC call must
// never leave a button stuck in its busy label ("Rendering…" / "Drafting…" forever).
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deferred, fake, stubBaseChannels, timeline } from "./helpers";
import { App } from "../src/renderer/App";
import { TemplatesScreen } from "../src/renderer/screens";

beforeEach(() => fake.reset());
afterEach(cleanup);

async function toMapInputs(user: ReturnType<typeof userEvent.setup>) {
  stubBaseChannels();
  render(h(App));
  await screen.findByText("promo-short.nexus.json");
  await user.click(screen.getByText("promo-short.nexus.json"));
  await user.click(screen.getByRole("button", { name: "Open" }));
  await user.click(screen.getByRole("button", { name: "Choose folder" }));
  await screen.findByText("1 rows");
  await user.selectOptions(screen.getByTestId("slot-hookClip"), "clip.mp4");
  await user.selectOptions(screen.getByTestId("slot-logo"), "logo.png");
}

describe("compile-preview race", () => {
  it("keeps the result of the most recently requested compile, even if an older request resolves later", async () => {
    const user = userEvent.setup();
    await toMapInputs(user);

    const first = deferred<{ rowId: string; timeline?: ReturnType<typeof timeline>; errors?: never }>();
    const second = deferred<{ rowId: string; timeline?: ReturnType<typeof timeline>; errors?: never }>();
    let call = 0;
    fake.when("timeline:compile-preview", async () => (++call === 1 ? first.promise : second.promise));

    await user.click(screen.getByRole("button", { name: "Preview row 1" })); // request 1 (slow)
    await user.click(screen.getByRole("button", { name: "Preview row 1" })); // request 2 (fast, supersedes)

    second.resolve({ rowId: "row-1", timeline: timeline({ output: "second.mp4" }) });
    await screen.findByText("second.mp4");

    first.resolve({ rowId: "row-1", timeline: timeline({ output: "first.mp4" }) }); // arrives late
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText("first.mp4")).not.toBeInTheDocument();
    expect(screen.getByText("second.mp4")).toBeInTheDocument();
  });
});

describe("stuck-busy recovery", () => {
  it("returns Render preview to its idle label after preview:render rejects", async () => {
    const user = userEvent.setup();
    await toMapInputs(user);
    fake.when("timeline:compile-preview", async () => ({ rowId: "row-1", timeline: timeline() }));
    await user.click(screen.getByRole("button", { name: "Preview row 1" }));
    await screen.findByTestId("total-frames");
    await user.click(screen.getByRole("button", { name: "Preview & tweak" }));

    const renderCall = deferred<{ url?: string; error?: string }>();
    fake.when("preview:render", async () => renderCall.promise);
    await user.click(screen.getByRole("button", { name: "Render preview" }));
    await screen.findByRole("button", { name: "Rendering…" });

    renderCall.reject(new Error("ffmpeg crashed"));
    await screen.findByRole("button", { name: "Render preview" });
    await screen.findByText("ffmpeg crashed");
  });

  it("returns Draft template to its idle label after author:draft rejects", async () => {
    const user = userEvent.setup();
    fake.when("template:list", async () => []);
    render(h(TemplatesScreen, { onOpen: () => {} }));

    const draftCall = deferred<unknown>();
    fake.when("author:draft", async () => draftCall.promise as never);
    await user.type(screen.getByPlaceholderText(/vertical reel/), "a 10s reel");
    await user.click(screen.getByRole("button", { name: "Draft template" }));
    await screen.findByRole("button", { name: "Drafting…" });

    draftCall.reject(new Error("model unavailable"));
    await screen.findByRole("button", { name: "Draft template" });
  });
});
