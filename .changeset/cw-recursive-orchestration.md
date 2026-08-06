---
"@zhushanwen/pi-cw-tool": minor
"@zhushanwen/pi-subagent-workflow": patch
"@zhushanwen/pi-goal": patch
"@zhushanwen/pi-pending-notifications": patch
---

Land cw recursive orchestration tooling and harden subagent-workflow keep-alive.

- **pi-cw-tool** (new): role-restricted wrapper around the `cw` CLI. Forwards
  `--workspace <repo root>` so cw operates on the caller's repo regardless of
  the agent's cwd, and maps cw E1 actions (`design`/`execute`/`review`/...) to
  capability-restricted tool surfaces for each recursive-split agent role
  (planning/wave/dev/review/merge).
- **pi-subagent-workflow**: split the single `agent_end` keep-alive timeout
  into spawn grace (MF-3) and long-running descendants grace (MF-4); add a
  recent-unregister window so a subagent that just unregistered does not
  immediately kill its layer-owner agent (race fix); keep layer-owner agents
  alive while descendants are still pending; guard null entries (S-10).
- **pi-goal**: align `agent_end` handler with the new keep-alive contract.
- **pi-pending-notifications**: track pending-descendants state consumed by
  the keep-alive guard.
