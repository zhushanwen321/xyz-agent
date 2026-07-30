# @zhushanwen/pi-rename-session

## 0.3.0

### Minor Changes

- 83e97ab: Integrate xyz-pi-extensions into xyz-agent monorepo

  - Migrate 17 @zhushanwen/pi-\* extension packages from standalone repository
  - Unify typebox imports to @sinclair/typebox across all extensions
  - Add unit tests for vision, quota-providers/cache, model-switch/advisor+setup
  - Fix type safety issues (PiAPI=any, TUnsafe compatibility)
  - Clean up migration residue (dead aliases, dangling symlinks, stale comments)

## 0.2.0

### Minor Changes

- eea3e5f: New extension: auto-rename sessions after the first turn.

  - Listens to `turn_end` and, on a new session's first assistant reply, generates a short (3-8 word, language-following) title via an independent LLM call that reuses the main turn's full context (hits kvcache, near-zero extra cost).
  - Title is persisted via `setSessionName` without touching session history.
  - Subagent sub-process sessions (path contains a `subagents` segment) are auto-excluded.
  - fire-and-forget: any failure (LLM / extraction / auth / read) is silently skipped, leaving the original label and never blocking the agent loop.
  - Gated by an opt-in switch file (default off).
