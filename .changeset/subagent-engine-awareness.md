---
'@zhushanwen/pi-subagent-workflow': minor
---

**subagent-workflow: engine awareness injection + config three-state read**

- The system prompt now carries an ever-present engine state section: current engine (with routing verdict) plus a per-engine list annotated with credentialed/available state, so the agent always knows which engine dispatches subagents and what alternatives exist
- Per-turn engine switch detection: when the effective engine changes mid-session, a flow notice is emitted the same turn (not silently on next dispatch)
- Config reads are now three-state (configured / unconfigured / error) with a single normalize authority; a new `reloadGlobalConfig` action lets clients repair a broken config without restarting, and the baseline branch reloads the service cache so a failed startup read no longer leaves a permanently stale cache
- `listModels` degrade hints are split by cause: unimplemented/null aligns to core registry semantics (port contract), empty/throw keeps a credentialed-config hint
- Engine section output is byte-stable per config state (ordering + tail-only-change guarded by tests)
