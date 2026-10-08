# ADR 0001: Desktop companion, browser extension, and provider-neutral email engine

Status: proposed. Owns: this document, `packages/integration-contracts/**`, and the parity matrix below.
This ADR designs contracts and process boundaries only — no provider SDK calls or UI are implemented here.

## Context

Nexus today is a deterministic video compiler with one Electron desktop app (`apps/desktop`). We are
adding three new surfaces that must not compromise the existing AI boundary (`README.md`: a model may
help author a template once; render/compile/batch/QA make zero model calls):

1. A **Tauri 2** desktop companion app that eventually replaces the Electron shell.
2. A separate **Chrome MV3 extension** that runs on arbitrary, untrusted web pages (e.g. a webmail
   compose screen) and talks to the desktop app.
3. A **provider-neutral email automation engine**, with Gmail and Microsoft Graph adapters, that drafts,
   approves, sends, and schedules email on the user's behalf.

The extension and the email engine are new trust boundaries: the extension executes in the context of
pages Nexus does not control, and the email engine holds real user credentials and can send mail
irreversibly. The desktop↔extension link is therefore a hardened, versioned IPC protocol, not an
open-ended RPC surface — see `packages/integration-contracts/src/index.ts` and the companion
[threat model](./0001-threat-model.md).

## Decision

### Process topology

```text
Chrome MV3 extension (content script + background service worker)
        | chrome.runtime / native messaging, envelope-wrapped, origin-pinned
        v
Tauri 2 desktop app (Rust core + webview UI)
        |-- email engine (provider-neutral core)
        |     |-- Gmail adapter
        |     '-- Microsoft Graph adapter
        |-- OS keychain (credential storage)
        '-- existing deterministic video pipeline (unchanged: timeline/template/renderer/batch/qa)
```

The extension never talks to a provider directly and never holds provider credentials. It only ever
sends `packages/integration-contracts` envelopes to the paired desktop app; the desktop app is the sole
holder of tokens and the sole caller of provider APIs. This mirrors the existing AI boundary: one
narrow, auditable choke point between an untrusted surface (a web page / a model) and privileged,
deterministic execution.

### Email automation engine: provider-neutral core

The engine is split the same way `renderer` is split from `vendor/ffmpeg`: a provider-neutral core
(compose, draft lifecycle state machine, scheduling, audit log) behind a small adapter interface, with
Gmail and Microsoft Graph as swappable adapters implementing it. The core never imports an adapter by
name; adapters are selected at the IPC boundary by `ProviderId` (`packages/integration-contracts`).

Adapter interface (sketch, not implemented in this ADR's scope):

```ts
interface MailAdapter {
  connect(): Promise<ConnectionState>;
  createDraft(input: DraftInput): Promise<DraftId>;
  send(draftId: DraftId): Promise<SendReceipt>;
  schedule(draftId: DraftId, atEpochMs: number): Promise<ScheduleReceipt>;
  cancelScheduled(draftId: DraftId): Promise<void>;
}
```

Both adapters must satisfy identical pre/postconditions (one draft → at most one send; a cancelled
schedule never sends); provider-specific retry/rate-limit behavior stays inside the adapter.

### Credential storage

Provider OAuth tokens (access + refresh) are stored only in the OS keychain (macOS Keychain /
Windows Credential Manager / libsecret on Linux via Tauri's `keyring` crate or equivalent), keyed by
`(provider, accountEmail)`. Never written to `data/` as plaintext, never logged, never included in audit
event `metadata` or `details`. The desktop process reads a token from the keychain immediately before a
provider call and does not cache it in memory longer than that call. The extension and the webview UI
never see raw tokens — only the `ConnectionState` enum from the protocol.

### Data-directory layout

```text
<app-data>/nexus/
  config.json                 # app settings, paired extension id(s), schema version
  mail/
    accounts.json             # provider + accountEmail + connection metadata (no secrets)
    drafts/<draftId>.json      # draft state machine snapshot
    audit.log                  # append-only, newline-delimited AuditEvent JSON
  video/                       # existing batch/results.json, fixtures, caches (unchanged)
  migrations/
    applied.json               # list of applied migration ids, per data subsystem
```

Each JSON file embeds a `schemaVersion` field. `mail/` and `video/` are migrated independently so a
video-engine schema bump never forces a mail-engine migration and vice versa.

### Schema migrations

Migrations are a linear, numbered list per subsystem (`mail`, `video`, `config`), applied forward-only
at startup, each one a pure function `(prev) => next` plus an idempotency check (`migrations/applied.json`
records which ids ran). No down-migrations in v1 — a failed migration halts startup with a structured
error rather than partially mutating data; the fix is to restore from the pre-migration backup the
migration runner writes before touching a file.

### Logging

Structured, newline-delimited JSON to `<app-data>/nexus/logs/`, one `StructuredError`-shaped line per
event (reusing the `{code, path/component, message, details}` shape already established in
`packages/timeline`). Mail-engine logs never include token values, full email bodies, or attachment
bytes — only ids, provider, and outcome. The audit log (`mail/audit.log`) is a separate, append-only
stream of `AuditEvent` commands and is never pruned automatically.

### Cancellation

Every long-running operation (a draft send, a scheduled send, an extension-triggered compose) carries a
`jobId`. `job.cancel.request` is best-effort: a provider call already past the point of no return (the
provider accepted the send) completes and is recorded, not rolled back; everything before that point
stops and emits `job.cancelled`. This matches the existing batch package's pause/resume/cancel model
conceptually, but email sends are irreversible in a way frame rendering is not, so cancellation only
ever races to a soft deadline. Idempotency keys (per `packages/integration-contracts`) are what make a
cancel-then-retry sequence from the extension safe: a replayed send request cannot double-send.

### Crash recovery

On startup, the desktop app scans `mail/drafts/*.json` for any draft left in an in-flight state
(`sending`, `scheduling`) with no matching `audit.log` completion entry, and resumes or marks it
`error` — same pattern as `packages/batch`'s crash recovery (rendering rows become pending). Because
`draft.send` is keyed by `idempotencyKey`, a resumed send that actually completed on the provider side
before the crash is detected via the provider's own idempotency/dedupe behavior where available (Gmail:
message-id based; Graph: client request id), falling back to "check sent folder for a matching
idempotency key stamped in a custom header" before resubmitting.

### Update strategy

The desktop app and the extension version independently but negotiate a shared protocol version at
`handshake.request`/`handshake.response` (`packages/integration-contracts`). The desktop app refuses to
process commands from an extension whose declared `clientVersion` is outside the `SUPPORTED_PROTOCOL_VERSIONS`
window and returns `PROTOCOL_VERSION_UNSUPPORTED`; the extension surfaces this as "update required" and
links to the Chrome Web Store listing. Desktop app updates ship via Tauri's built-in updater
(signed update manifests); extension updates ship via the Chrome Web Store's normal auto-update. Because
the protocol is additive-by-default (command schemas are non-strict `z.object`, not `z.strictObject`),
a desktop update can ship new optional command fields without forcing a simultaneous extension update,
and vice versa, as long as the major protocol version (`v`) is unchanged.

## Electron → Tauri migration parity matrix

| Electron responsibility (`apps/desktop/src/main`) | Tauri 2 equivalent | Status |
|---|---|---|
| Main-process fs access (templates, fixtures, results.json) | Rust command + `tauri-plugin-fs`, scoped to the data directory | Not started |
| Native dialogs (open/save) | `tauri-plugin-dialog` | Not started |
| Job orchestration (spawn ffmpeg via `renderer`, track progress) | Rust command invoking the same Node/TS pipeline via sidecar, or a Rust-side process runner | Not started — needs a decision on sidecar vs. rewrite, out of scope for this ADR |
| Typed IPC (`apps/desktop/src/shared/ipc.ts`, preload bridge) | Tauri `invoke`/`emit` with the same message shapes, validated the same way `packages/integration-contracts` validates extension traffic | Not started |
| Renderer process (React UI) | Same React UI inside Tauri's webview (React is not Electron-specific) | Portable as-is |
| Electron auto-update | Tauri updater | Not started |
| Packaging (`electron-builder`, currently deferred per README) | `tauri bundle` | Not started |

**Electron removal criteria** (all must hold before `apps/desktop`'s Electron main/preload are deleted):

1. Every IPC call in `apps/desktop/src/shared/ipc.ts` has a Tauri command with an equivalent, tested
   contract.
2. The video pipeline (`timeline`/`template`/`renderer`/`batch`/`qa`) runs unmodified under the Tauri
   shell — the AI-boundary test and golden-frame tests pass against the Tauri build, not just Electron.
3. The mail engine and extension pairing flow work end-to-end against the Tauri build.
4. `pnpm e2e` (or its Tauri-targeted successor) is green on the Tauri build on every platform Nexus
   ships.
5. A rollback path exists for one release cycle (both shells buildable from the same commit) in case the
   Tauri build regresses something Electron didn't.

## Consequences

- The extension is permanently untrusted input, same category as a video source file or a page a model
  might read from — see the threat model for how `packages/integration-contracts` enforces that.
- Provider adapters can be added (e.g. IMAP/SMTP generic) without touching the core engine or the
  protocol, only a new `ProviderId` variant and adapter implementation.
- Two desktop shells (Electron, Tauri) exist simultaneously during migration; the parity matrix is the
  tracked exit condition, not a target date.

## Not covered here

Provider SDK integration code, the extension's content-script/UI implementation, and the Tauri Rust
command implementations are deliberately out of scope for this ADR and for `packages/integration-contracts`.
This ADR defines the contracts and invariants those implementations must satisfy.
