---
'@zhushanwen/pi-plan': minor
---

**pi-plan: remove `pi.__planStart` external API mount**

- The `pi.__planStart(requirement, ctx)` external mount and its `startPlanMode` implementation are removed. The only cross-extension consumer (the goal extension's plan-mode probe) had already been deleted — the probe could never fire across extension boundaries, so the mount was unreachable in practice. `/plan` command, plan tool, and widget behavior are unchanged; this only removes the dead programmatic surface.
