---
'@zhushanwen/pi-subagent-workflow': minor
---

**pi-subagent-workflow: builtin agents move to @zhushanwen/subagent-core, tools whitelist dropped from templates, workflow run accepts builtin names**

- The 10 builtin agent templates (analyst/coder/debugger/doc-reviewer/explorer/general-purpose/orchestrator/planner/researcher/reviewer) now ship with `@zhushanwen/subagent-core` (the `agents/` asset directory, distributed via the package dependency) instead of inside this package — their `<location>` in the `<available_subagents>` injection points at the core package directory; discovery priority is unchanged (user-level < builtin < project-level)
- The templates no longer declare a `tools:` frontmatter whitelist (orchestrator and 8 others): subagents are no longer started with a `--tools` allowlist, tool constraints return to the host's default toolset. To restore a per-role whitelist, drop a same-name `.md` override into `<workspace>/.agents/agents/` — the project-level source is the escape hatch that shadows the builtin
- `workflow run` now accepts a builtin/saved workflow name (e.g. `{"action":"run","name":"review-fix-loop"}`) in addition to absolute script paths — resolving names first, then paths (strict superset; existing path usage unchanged)
- The `<available_subagents>` injection guide was updated to match the current subagent tool parameter surface: agent refs are `<location>` paths (not bare names), and unmatched tasks should omit the agent param (falls back to general-purpose) — the old "pass systemPrompt" hint referenced a parameter that no longer exists
