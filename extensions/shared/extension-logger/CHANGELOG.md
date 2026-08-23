# @zhushanwen/pi-extension-logger

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
