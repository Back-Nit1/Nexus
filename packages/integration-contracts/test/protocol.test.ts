import { describe, expect, it } from "vitest";
import { createReplayGuard, MAX_PAYLOAD_BYTES, negotiateCapabilities, parseEnvelope } from "../src/index.ts";

const ORIGIN = `chrome-extension://${"abcdefghijklmnop".repeat(2)}`;
const OTHER_ORIGIN = `chrome-extension://${"p".repeat(32)}`;

function baseEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    requestId: "11111111-1111-1111-1111-111111111111",
    idempotencyKey: "key-1",
    origin: ORIGIN,
    ts: 1_700_000_000_000,
    command: { type: "job.cancel.request", jobId: "job-1" },
    ...overrides,
  };
}

describe("parseEnvelope", () => {
  it("accepts a well-formed envelope from an allowed origin", () => {
    const result = parseEnvelope(baseEnvelope(), { allowedOrigins: [ORIGIN] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.command.type).toBe("job.cancel.request");
  });

  it("rejects an unsupported protocol version", () => {
    const result = parseEnvelope(baseEnvelope({ v: 99 }), { allowedOrigins: [ORIGIN] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PROTOCOL_VERSION_UNSUPPORTED");
  });

  it("rejects an origin not paired with this desktop install", () => {
    const result = parseEnvelope(baseEnvelope({ origin: OTHER_ORIGIN }), { allowedOrigins: [ORIGIN] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_ORIGIN");
  });

  it("rejects a replayed requestId+idempotencyKey pair", () => {
    const guard = createReplayGuard();
    const envelope = baseEnvelope();
    const first = parseEnvelope(envelope, { allowedOrigins: [ORIGIN], replayGuard: guard });
    const second = parseEnvelope(envelope, { allowedOrigins: [ORIGIN], replayGuard: guard });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("REPLAYED_REQUEST");
  });

  it("allows the same requestId with a different idempotencyKey through the replay guard", () => {
    const guard = createReplayGuard();
    parseEnvelope(baseEnvelope(), { allowedOrigins: [ORIGIN], replayGuard: guard });
    const result = parseEnvelope(baseEnvelope({ idempotencyKey: "key-2" }), { allowedOrigins: [ORIGIN], replayGuard: guard });
    expect(result.ok).toBe(true);
  });

  it("rejects a payload larger than MAX_PAYLOAD_BYTES", () => {
    const oversized = baseEnvelope({ command: { type: "draft.create", provider: "gmail", to: ["a@example.com"], subject: "s", bodyText: "x".repeat(MAX_PAYLOAD_BYTES) } });
    const result = parseEnvelope(oversized, { allowedOrigins: [ORIGIN] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects a malformed command (unknown type)", () => {
    const result = parseEnvelope(baseEnvelope({ command: { type: "not.a.real.command" } }), { allowedOrigins: [ORIGIN] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MALFORMED_COMMAND");
  });

  it("rejects a malformed command (missing required field)", () => {
    const result = parseEnvelope(baseEnvelope({ command: { type: "draft.send" } }), { allowedOrigins: [ORIGIN] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MALFORMED_COMMAND");
  });

  it("rejects an envelope with an extra unrecognized top-level field (strict envelope)", () => {
    const result = parseEnvelope(baseEnvelope({ unexpected: "field" }), { allowedOrigins: [ORIGIN] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MALFORMED_COMMAND");
  });

  it("backward compatibility: tolerates an additive, unrecognized field inside a command payload", () => {
    const envelope = baseEnvelope({ command: { type: "job.cancel.request", jobId: "job-1", futureFieldFromNewerClient: true } });
    const result = parseEnvelope(envelope, { allowedOrigins: [ORIGIN] });
    expect(result.ok).toBe(true);
  });

  it("backward compatibility: an older client omitting a newer optional command field still parses", () => {
    const result = parseEnvelope(baseEnvelope({ command: { type: "provider.connectionState", provider: "gmail", state: "connected" } }), { allowedOrigins: [ORIGIN] });
    expect(result.ok).toBe(true);
  });

  it("accepts a pre-serialized JSON string identically to the equivalent object", () => {
    const envelope = baseEnvelope();
    const result = parseEnvelope(JSON.stringify(envelope), { allowedOrigins: [ORIGIN] });
    expect(result.ok).toBe(true);
  });
});

describe("negotiateCapabilities", () => {
  it("returns the intersection, ordered by the local list", () => {
    expect(negotiateCapabilities(["a", "b", "c"], ["c", "a"])).toEqual(["a", "c"]);
  });

  it("returns an empty array when there is no overlap", () => {
    expect(negotiateCapabilities(["a"], ["b"])).toEqual([]);
  });
});
