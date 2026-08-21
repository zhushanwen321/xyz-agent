---
"@zhushanwen/pi-cw-tool": minor
---

Adapt to cw 2.0: read-only cw_query tool + runner-guide skill (Phase 2-B, breaking)

The 1.x stack shipped in this package is dead weight on cw >= 2.0: the role-restricted write tools and orchestration agents target a command surface that no longer exists, and cw 2.0's engine (runner + ledger gates) already covers what they were for. This release collapses the package to a thin wrapper over the cw 2.0 engine.

Breaking changes:

- cw_planning / cw_wave / cw_dev / cw_review (4 role-restricted tools) are removed, replaced by a single `cw_query` tool exposing the cw 2.0 read-only surface only: status / frontier / tree / report, with the 2.0 parameter faces (`--unit`, `--root`, `--json`; report selectors are mutually exclusive). Write commands (create / evidence submit / review submit / verify / run) are not in the tool surface — agents invoke `cw` via bash, with the cw-cli skill as the SSOT for usage.
- The 5 orchestration agents (planning / wave / dev / review / merge) are deleted along with the package's `pi.agents` registration. Recursive orchestration is now the cw 2.0 runner's job (`cw run --root <id> --spawn pi`); "no self-review" is enforced at the ledger layer (`review submit` requires `--role reviewer`), no longer by tool whitelists.
- The pi-cw skill is rewritten as a thin runner practical guide (background run, monitoring via cw_query, escalation handling, merge-back), deferring command-surface teaching to the cw-cli skill.
- The 1.x workspace gating (detectRepoWorkspace + `--workspace` passthrough + cw version probing) is removed: cw 2.0 locates its ledger per-cwd under `~/.cw/` and has no `--workspace` flag.

Migration: upgrade the global `@zhushanwen/coding-workflow` to 2.x, read the new pi-cw skill, and replace any cw_planning/cw_wave/cw_dev/cw_review usage with cw_query (reads) or bash `cw` invocations (writes). Design doc: docs/todo/pi-cw-cw2-adaptation.md in the xyz-agent repo.
