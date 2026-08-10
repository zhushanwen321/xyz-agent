# @zhushanwen/pi-scheduler

## 0.1.1

### Patch Changes

- 246cd5e72: Extract `SchedulerBackend` and unify tool/command dispatch through `SchedulerService`. Fix the cron fallback loop and correct the misleading "every X" display for once tasks (now shown as "once in X").

## 0.1.0

### Minor Changes

- 83e97ab: Integrate xyz-pi-extensions into xyz-agent monorepo

  - Migrate 17 @zhushanwen/pi-\* extension packages from standalone repository
  - Unify typebox imports to @sinclair/typebox across all extensions
  - Add unit tests for vision, quota-providers/cache, model-switch/advisor+setup
  - Fix type safety issues (PiAPI=any, TUnsafe compatibility)
  - Clean up migration residue (dead aliases, dangling symlinks, stale comments)

## 0.0.5

### Patch Changes

- Publish as public package via .npmrc access=public.

## 0.0.4

### Patch Changes

- Publish with --access public for first-time scoped package.

## 0.0.2

### Patch Changes

- b4b9fa5: Fix cron expression parsing in /schedule command: add quote-aware tokenizer so quoted cron expressions (e.g. `cron '*/10 * * * *' prompt`) are correctly handled.
