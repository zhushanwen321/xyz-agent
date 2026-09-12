---
'@zhushanwen/pi-subagent-cli': minor
---

Align with the subagent-core chat-run unification ([H1]). Breaking changes to the package's public exports — hosts MUST be upgraded in lockstep with `@zhushanwen/subagent-core` in the same release batch.

- **`ChatSessionRegistry` family exports removed** (`ChatSessionRegistry`, `ChatSessionRegistryDeps` and related session-registry types from the barrel): the "session outlives runs, askUser binds per chat session" special case is retired. With chat-run unification every chat round is a run dispatched as a session-form run (`run.resume`), and host/askUser two-phase channels are bound per-run (`bindAskUser` per active run, unbound on run exit).
- Protocol behavior follows the engine-sdk surface narrowing: `run.resume` is the only session-form key, the `interact` method and `host/roundLifecycle` channel are gone.
