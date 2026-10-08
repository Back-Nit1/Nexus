import { z } from "zod";

// Versioned, runtime-validated wire protocol between the Tauri desktop app and the MV3 extension.
// Nothing here calls a provider SDK or renders UI; it only describes and validates messages.

// ---------- versioning ----------

export const PROTOCOL_VERSION = 1 as const;
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;
export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

// ponytail: single in-process size cap, not a distributed limit; revisit if the desktop app ever fans out to multiple extension instances.
export const MAX_PAYLOAD_BYTES = 1_000_000;
// ponytail: FIFO eviction over a Map, not an LRU; fine at this cardinality (one paired extension per desktop install).
export const MAX_REPLAY_ENTRIES = 10_000;

// ---------- primitives ----------

/** MV3 extension IDs are 32 lowercase letters a-p (base16 over that alphabet). */
export const ExtensionOrigin = z.string().regex(/^chrome-extension:\/\/[a-p]{32}$/, "Must be a chrome-extension:// origin with a 32-char MV3 extension id");
export const RequestId = z.string().uuid();
export const IdempotencyKey = z.string().min(1).max(200);
export const ProviderId = z.enum(["gmail", "microsoft-graph"]);
export type ProviderId = z.infer<typeof ProviderId>;

export const ErrorCode = z.enum([
  "PROTOCOL_VERSION_UNSUPPORTED",
  "INVALID_ORIGIN",
  "PAYLOAD_TOO_LARGE",
  "MALFORMED_COMMAND",
  "REPLAYED_REQUEST",
  "CAPABILITY_UNSUPPORTED",
  "AUTH_REJECTED",
  "PROVIDER_ERROR",
  "NOT_FOUND",
  "CANCELLED",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ProtocolErrorSchema = z.strictObject({
  code: ErrorCode,
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

const err = (code: ErrorCode, message: string, details?: Record<string, unknown>): ProtocolError => ({ code, message, details });

// ---------- commands ----------
// Each member is a plain (non-strict) object so a future minor version can add optional fields
// without breaking older parsers on either side of the extension/desktop boundary (forward compatibility).

const HandshakeRequest = z.object({
  type: z.literal("handshake.request"),
  clientVersion: z.number().int().positive(),
  capabilities: z.array(z.string()),
});

const HandshakeResponse = z.object({
  type: z.literal("handshake.response"),
  serverVersion: z.number().int().positive(),
  capabilities: z.array(z.string()),
  sessionId: z.string().uuid(),
});

const AuthRequest = z.object({
  type: z.literal("auth.request"),
  pairingToken: z.string().min(1),
});

const AuthResult = z.object({
  type: z.literal("auth.result"),
  ok: z.boolean(),
  reason: z.string().optional(),
});

const ProviderConnectionState = z.object({
  type: z.literal("provider.connectionState"),
  provider: ProviderId,
  state: z.enum(["disconnected", "connecting", "connected", "error", "token-expired"]),
  accountEmail: z.string().email().optional(),
  error: ProtocolErrorSchema.optional(),
});

const ComposeFromPageRequest = z.object({
  type: z.literal("compose.fromPage.request"),
  provider: ProviderId,
  pageUrl: z.string().url(),
  pageOrigin: z.string().min(1),
  selectionText: z.string().optional(),
});

const DraftCreate = z.object({
  type: z.literal("draft.create"),
  provider: ProviderId,
  to: z.array(z.string().email()).min(1),
  subject: z.string(),
  bodyText: z.string(),
  bodyHtml: z.string().optional(),
  attachmentRefs: z.array(z.string()).optional(),
});

const DraftApprove = z.object({ type: z.literal("draft.approve"), draftId: z.string().min(1) });

const DraftSend = z.object({ type: z.literal("draft.send"), draftId: z.string().min(1) });

const DraftSchedule = z.object({
  type: z.literal("draft.schedule"),
  draftId: z.string().min(1),
  sendAtEpochMs: z.number().int().positive(),
});

const JobProgress = z.object({
  type: z.literal("job.progress"),
  jobId: z.string().min(1),
  percent: z.number().min(0).max(100),
  stage: z.string(),
});

const JobCancelRequest = z.object({ type: z.literal("job.cancel.request"), jobId: z.string().min(1) });

const JobCancelled = z.object({ type: z.literal("job.cancelled"), jobId: z.string().min(1) });

const ErrorCommand = z.object({ type: z.literal("error"), error: ProtocolErrorSchema });

export const AuditEventKind = z.enum([
  "auth.granted",
  "auth.revoked",
  "draft.created",
  "draft.approved",
  "draft.sent",
  "draft.scheduled",
  "draft.cancelled",
  "connection.changed",
]);

const AuditEvent = z.object({
  type: z.literal("audit.event"),
  event: AuditEventKind,
  actor: z.enum(["user", "extension", "desktop"]),
  subjectId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const CommandSchema = z.discriminatedUnion("type", [
  HandshakeRequest,
  HandshakeResponse,
  AuthRequest,
  AuthResult,
  ProviderConnectionState,
  ComposeFromPageRequest,
  DraftCreate,
  DraftApprove,
  DraftSend,
  DraftSchedule,
  JobProgress,
  JobCancelRequest,
  JobCancelled,
  ErrorCommand,
  AuditEvent,
]);
export type Command = z.infer<typeof CommandSchema>;

// ---------- envelope ----------

export const EnvelopeSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  requestId: RequestId,
  idempotencyKey: IdempotencyKey,
  origin: ExtensionOrigin,
  ts: z.number().int().nonnegative(),
  command: CommandSchema,
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** Same shape but with `v` loosened, so parseEnvelope can report an unsupported version instead of a generic schema failure. */
const EnvelopeAnyVersion = EnvelopeSchema.extend({ v: z.number().int().positive() });

export type ParseResult = { ok: true; envelope: Envelope } | { ok: false; error: ProtocolError };

export type ParseEnvelopeOptions = {
  /** Extension ids this desktop install is paired with. */
  allowedOrigins: readonly string[];
  /** Tracks requestId+idempotencyKey pairs already accepted; omit to skip replay detection. */
  replayGuard?: ReplayGuard;
};

/**
 * Validate a raw envelope (already-parsed JSON value, or its serialized string) against size,
 * version, origin, replay, and schema in that order — each is cheaper than the next and a client
 * sending oversized or stale traffic shouldn't pay for a full zod pass.
 */
export function parseEnvelope(raw: unknown, options: ParseEnvelopeOptions): ParseResult {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (Buffer.byteLength(text, "utf8") > MAX_PAYLOAD_BYTES) {
    return { ok: false, error: err("PAYLOAD_TOO_LARGE", `Envelope exceeds ${MAX_PAYLOAD_BYTES} bytes`) };
  }
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;

  const versioned = EnvelopeAnyVersion.safeParse(value);
  if (versioned.success && !SUPPORTED_PROTOCOL_VERSIONS.includes(versioned.data.v as ProtocolVersion)) {
    return { ok: false, error: err("PROTOCOL_VERSION_UNSUPPORTED", `Unsupported protocol version ${versioned.data.v}`, { supported: SUPPORTED_PROTOCOL_VERSIONS }) };
  }

  const parsed = EnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: err("MALFORMED_COMMAND", parsed.error.issues[0]?.message ?? "Envelope failed validation", { issues: parsed.error.issues }) };
  }
  const envelope = parsed.data;

  if (!options.allowedOrigins.includes(envelope.origin)) {
    return { ok: false, error: err("INVALID_ORIGIN", `Origin ${envelope.origin} is not paired with this desktop install`) };
  }

  if (options.replayGuard?.seen(envelope.requestId, envelope.idempotencyKey)) {
    return { ok: false, error: err("REPLAYED_REQUEST", `requestId ${envelope.requestId} with idempotencyKey ${envelope.idempotencyKey} was already processed`) };
  }
  options.replayGuard?.record(envelope.requestId, envelope.idempotencyKey);

  return { ok: true, envelope };
}

// ---------- replay guard ----------

export type ReplayGuard = { seen(requestId: string, idempotencyKey: string): boolean; record(requestId: string, idempotencyKey: string): void };

/** Bounded in-memory replay cache, keyed on requestId+idempotencyKey. FIFO eviction past maxEntries. */
export function createReplayGuard(maxEntries = MAX_REPLAY_ENTRIES): ReplayGuard {
  const seen = new Set<string>();
  const key = (requestId: string, idempotencyKey: string) => `${requestId}:${idempotencyKey}`;
  return {
    seen: (requestId, idempotencyKey) => seen.has(key(requestId, idempotencyKey)),
    record(requestId, idempotencyKey) {
      if (seen.size >= maxEntries) seen.delete(seen.values().next().value as string);
      seen.add(key(requestId, idempotencyKey));
    },
  };
}

// ---------- capability negotiation ----------

/** Capabilities both sides declared; order follows `local`. */
export function negotiateCapabilities(local: readonly string[], remote: readonly string[]): string[] {
  const remoteSet = new Set(remote);
  return local.filter((c) => remoteSet.has(c));
}
