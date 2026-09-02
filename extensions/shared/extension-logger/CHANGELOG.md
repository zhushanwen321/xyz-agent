# @zhushanwen/pi-extension-logger

## 0.4.0

### Minor Changes

- 7b33e6f00: **extension-logger: XYZ_AGENT_EXT_LOG info-level sink; ext-guards: first release of the oncePerProcess guard package**

  - `@zhushanwen/pi-extension-logger`: a new `XYZ_AGENT_EXT_LOG=1` environment variable makes extensions log at INFO level to `<agentDir>/logs/<ext>-<date>.log` with 7-day retention, for hosts (xyz-agent runtime) that inject the variable when spawning pi. Without any of the logging variables the logger stays a zero-disk no-op — standalone pi users see no behavior change. `XYZ_AGENT_DEBUG=1` keeps full DEBUG logging unchanged; when both are set the more verbose wins.
  - `@zhushanwen/pi-ext-guards` (new shared package): `oncePerProcess(key, fn)` — a process-level dedup wrapper for cross-session side effects in session_start handlers. Rationale: pi's extension cache is keyed by cwd, so a `switch_session` to a session with the same cwd re-invokes the extension factory and accumulates handler registrations — the same event is dispatched once per registration group. `oncePerProcess` caches the first result (value/Promise/error all replayed as the same instance, a rejected Promise does not release the key, and fn errors are re-thrown unwrapped), which makes "at most once per process" semantics explicit instead of relying on each extension's ad-hoc inline flags.

- 7b33e6f00: **shared libs: remove dead package-root barrels and llm-shared dead API surface**

  - The package-root `index.ts` in `@zhushanwen/pi-extension-logger`, `@zhushanwen/pi-file-lock`, and `@zhushanwen/pi-llm-shared` is deleted. Each package's `main` points at `src/index.ts` and none of the root barrels was ever resolved (zero deep imports across the repo), so resolution behavior is unchanged. The `index.ts` entry is dropped from `files` (publish surface shrink) and from the two tsconfigs' `include` that listed it.
  - `@zhushanwen/pi-llm-shared`: the `recoverable` field is removed from the `CallLLMResult` failure variant. All three construction sites in `src/call.ts` hardcoded `true`, the sole production constructor outside the library (`permission` classifier) never read it, and no consumer branched on it — the field was pure noise on every `ok:false` result. The `CallLLMResult`-typed test fixtures are updated accordingly.
  - `@zhushanwen/pi-llm-shared`: `extractText` is no longer re-exported from `src/index.ts` (zero external consumers; same-named helpers elsewhere in the repo are deliberate local implementations). The function itself stays in `src/call.ts` for internal use, so deep imports of `../call.ts` are unaffected.

## 0.3.1

### Patch Changes

- 837f2faf6: (no changeset body; patch version bump)

## 0.3.0

### Minor Changes

- d4f466667: Add per-message fixed-window rate limiting for appendEntry writes so a hot loop of log entries can no longer flood the session file; excess entries within a window are summarized instead of written one by one

## 0.2.2

### Patch Changes

- 63aa77435: Repo reorganization and dependency convergence for the 0.9.5 cycle

  - Extension packages are grouped into `extensions/taiji/` (xyz-agent integrated) and `extensions/universal/` (standalone); install targets and READMEs updated accordingly
  - earendil family dependencies converged to 0.84.1 (peer/dependency ranges updated)
  - llm-shared: export shared `getCurrentModelId` helper for model consumers
  - model-switch: consume the shared helper, internal simplification

## 0.2.1

### Patch Changes

- 2a724190c: **extension-logger / pending-notifications / subagent-workflow: unify debug env switches on XYZ_AGENT_DEBUG**

  - File-log gating in `extension-logger` now reads `XYZ_AGENT_DEBUG=1` (previously `PI_EXT_DEBUG`); `pending-notifications` console debug logs switch from `PENDING_DEBUG` to `XYZ_AGENT_DEBUG`; `subagent-workflow` debug traces likewise moved to `XYZ_AGENT_DEBUG`.
  - One switch now toggles debug logging across all extensions that follow the logging conventions doc — no per-extension env vars to remember.

## 0.2.0

### Minor Changes

- 1e33329: Add shared extension logger package with three-channel routing (appendEntry audit / debug file log / no console).

## 0.1.0

### Patch Changes

- Initial release. Shared logging helper for Pi extensions with three-channel routing:
  - `warn`/`error` → `pi.appendEntry` (audited in session.jsonl, not in LLM context, not shown in TUI)
  - `debug` → file log at `~/.pi/agent/logs/<extName>-YYYY-MM-DD.log` (only when `XYZ_AGENT_DEBUG=1`, no-op by default)
  - `notify` intentionally not wrapped — UI decision, left to each extension
- `createLogger(extName, pi?)` for extension init time; `getLogger(extName)` for deep code without `pi` access (global singleton with deferred `setPiHandle`)
