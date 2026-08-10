---
"@zhushanwen/pi-goal": patch
"@zhushanwen/pi-todo": patch
---

Flatten tool parameters schema to a single top-level Type.Object for OpenAI compatibility.

`goal_control` and `todo` registered `Type.Union([...])` as `registerTool` parameters,
which serializes to `{ anyOf: [...] }` with no `type` field. Strict OpenAI-compatible
gateways reject this with HTTP 400, blocking the whole session from starting.

Both tools now use a flat `Type.Object` with an action field-level literal union (matching
scheduler's `ScheduleControlParams` pattern) + `Static<typeof Schema>` derived types +
runtime handler branch validation. Branch isolation moves from the schema layer to runtime
handler checks (field-presence guards with actionable error messages).

No behavior change for well-formed calls. Missing required fields previously rejected at
the schema layer now throw at runtime with correct-call hints. Dual-form trap detection
(todo `text`/`texts`, `id`/`ids`) is preserved unchanged.
