---
"@zhushanwen/pi-cw-tool": patch
---

Add cw 2.0 version guard to pi-cw skill and fix stale routing (Phase 1)

cw 2.0.0 is a full rewrite: the 1.x command surface used throughout the pi-cw skill (`cw handoff`, `cw guidance`, `cw gate`, `cw replan`, positional `cw create <layer> --slug`) is gone. Without a guard, agents on cw >= 2.0 would still follow the skill and hit "unknown command" mid-flow.

Changes (skill doc only, no code):
- [MANDATORY] version guard before the workflow section: run `cw --version` first; >= 2.0 stops the skill and routes multi-unit orchestration to `cw run --root <id> --spawn pi` (cw-cli skill's mode table stays the single authority for runner usage)
- "when not to use" routing: "cw-cli single-agent mode" wording removed — multi-unit tasks now route to the cw-cli runner mode instead of manual agent-driven stepping
- 1.x-only banner at the top of the workflow section to catch skip-readers

Phase 2 (skill rewrite as thin runner wrapper vs full retirement) is a separate decision, see docs/todo/pi-cw-cw2-adaptation.md.
