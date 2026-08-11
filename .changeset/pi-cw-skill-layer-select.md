---
"@zhushanwen/pi-cw-tool": patch
---

Fix pi-cw skill internal inconsistency: the flow hardcoded `cw create epic` while description and "when to use" listed all four layers (epic/feature/slice/wave), blocking legitimate "feature as root" recursive orchestration.

- Flow step 1 now uses `cw create <顶层>` with layer-selection guidance reused from cw-cli (the "scale × nature" table), plus an explicit gate: the root must split into ≥2 parallelizable child units, else use cw-cli's single-agent linear mode.
- Generalize the planning-agent task template and frontier examples (`<epicId>` → `<根Id>`, "cw epic" → "cw <根层>").
- Sharpen the pi-cw vs cw-cli boundary in "when to use / when not to use" from "tree depth" to "concurrency + context-isolation need" — an epic tree can be walked linearly by a single agent (cw-cli); pi-cw's value is isolation/parallelism.

No engine or agent change required: planning-agent already supports epic/feature/slice as root, and cw-tool's `create` only forwards to the cw CLI.
