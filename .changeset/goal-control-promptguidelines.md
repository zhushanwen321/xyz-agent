---
"@zhushanwen/pi-goal": patch
---

Add `promptGuidelines` to the `goal_control` tool so the agent proactively calls `complete` / `report_blocked`:

- `complete`: call when the active goal's objective is actually achieved with concrete evidence (finishing all todos incl. verification todos is the usual readiness signal, but the objective being met is the real bar)
- `report_blocked`: call when genuinely blocked after ≥3 distinct alternative approaches — do not silently stop or leave the goal hanging

`create` deliberately omitted — its "only when user asks" deterrence is already covered by the tool description and promptSnippet.
