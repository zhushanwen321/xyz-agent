---
"@zhushanwen/pi-ask-user": minor
"@zhushanwen/pi-context-engineering": minor
"@zhushanwen/pi-evolve-daily": minor
"@zhushanwen/pi-goal": minor
"@zhushanwen/pi-model-switch": minor
"@zhushanwen/pi-pending-notifications": minor
"@zhushanwen/pi-permission": minor
"@zhushanwen/pi-plan": minor
"@zhushanwen/pi-rename-session": minor
"@zhushanwen/pi-scheduler": minor
"@zhushanwen/pi-quota-providers": minor
"@zhushanwen/pi-statusline": minor
"@zhushanwen/pi-structured-output": minor
"@zhushanwen/pi-subagent-workflow": minor
"@zhushanwen/pi-todo": minor
"@zhushanwen/pi-unified-hooks": minor
"@zhushanwen/pi-vision": minor
---

Integrate xyz-pi-extensions into xyz-agent monorepo

- Migrate 17 @zhushanwen/pi-* extension packages from standalone repository
- Unify typebox imports to @sinclair/typebox across all extensions
- Add unit tests for vision, quota-providers/cache, model-switch/advisor+setup
- Fix type safety issues (PiAPI=any, TUnsafe compatibility)
- Clean up migration residue (dead aliases, dangling symlinks, stale comments)
