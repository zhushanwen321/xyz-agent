# @zhushanwen/pi-ext-guards

## 0.2.0

### Minor Changes

- 7b33e6f00: **extension-logger: XYZ_AGENT_EXT_LOG info-level sink; ext-guards: first release of the oncePerProcess guard package**

  - `@zhushanwen/pi-extension-logger`: a new `XYZ_AGENT_EXT_LOG=1` environment variable makes extensions log at INFO level to `<agentDir>/logs/<ext>-<date>.log` with 7-day retention, for hosts (xyz-agent runtime) that inject the variable when spawning pi. Without any of the logging variables the logger stays a zero-disk no-op — standalone pi users see no behavior change. `XYZ_AGENT_DEBUG=1` keeps full DEBUG logging unchanged; when both are set the more verbose wins.
  - `@zhushanwen/pi-ext-guards` (new shared package): `oncePerProcess(key, fn)` — a process-level dedup wrapper for cross-session side effects in session_start handlers. Rationale: pi's extension cache is keyed by cwd, so a `switch_session` to a session with the same cwd re-invokes the extension factory and accumulates handler registrations — the same event is dispatched once per registration group. `oncePerProcess` caches the first result (value/Promise/error all replayed as the same instance, a rejected Promise does not release the key, and fn errors are re-thrown unwrapped), which makes "at most once per process" semantics explicit instead of relying on each extension's ad-hoc inline flags.
