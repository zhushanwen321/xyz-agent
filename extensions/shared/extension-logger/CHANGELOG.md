# @zhushanwen/pi-extension-logger

## 0.2.0

### Minor Changes

- 1e33329: Add shared extension logger package with three-channel routing (appendEntry audit / debug file log / no console).

## 0.1.0

### Patch Changes

- Initial release. Shared logging helper for Pi extensions with three-channel routing:
  - `warn`/`error` → `pi.appendEntry` (audited in session.jsonl, not in LLM context, not shown in TUI)
  - `debug` → file log at `~/.pi/agent/logs/<extName>-YYYY-MM-DD.log` (only when `PI_EXT_DEBUG=1`, no-op by default)
  - `notify` intentionally not wrapped — UI decision, left to each extension
- `createLogger(extName, pi?)` for extension init time; `getLogger(extName)` for deep code without `pi` access (global singleton with deferred `setPiHandle`)
