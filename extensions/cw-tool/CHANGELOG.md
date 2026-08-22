# @zhushanwen/pi-cw-tool

## 0.5.0

### Minor Changes

- ccd7d2d70: Add cw 2.0 version guard to pi-cw skill and fix stale routing (Phase 1)

  cw 2.0.0 is a full rewrite: the 1.x command surface used throughout the pi-cw skill (`cw handoff`, `cw guidance`, `cw gate`, `cw replan`, positional `cw create <layer> --slug`) is gone. Without a guard, agents on cw >= 2.0 would still follow the skill and hit "unknown command" mid-flow.

  Changes (skill doc only, no code):
  - [MANDATORY] version guard before the workflow section: run `cw --version` first; >= 2.0 stops the skill and routes multi-unit orchestration to `cw run --root <id> --spawn pi` (cw-cli skill's mode table stays the single authority for runner usage)
  - "when not to use" routing: "cw-cli single-agent mode" wording removed — multi-unit tasks now route to the cw-cli runner mode instead of manual agent-driven stepping
  - 1.x-only banner at the top of the workflow section to catch skip-readers

  Phase 2 (skill rewrite as thin runner wrapper vs full retirement) is a separate decision, see docs/todo/pi-cw-cw2-adaptation.md.

- ccd7d2d70: Adapt to cw 2.0: read-only cw_query tool + runner-guide skill (Phase 2-B, breaking)

  The 1.x stack shipped in this package is dead weight on cw >= 2.0: the role-restricted write tools and orchestration agents target a command surface that no longer exists, and cw 2.0's engine (runner + ledger gates) already covers what they were for. This release collapses the package to a thin wrapper over the cw 2.0 engine.

  Breaking changes:

  - cw_planning / cw_wave / cw_dev / cw_review (4 role-restricted tools) are removed, replaced by a single `cw_query` tool exposing the cw 2.0 read-only surface only: status / frontier / tree / report, with the 2.0 parameter faces (`--unit`, `--root`, `--json`; report selectors are mutually exclusive). Write commands (create / evidence submit / review submit / verify / run) are not in the tool surface — agents invoke `cw` via bash, with the cw-cli skill as the SSOT for usage.
  - The 5 orchestration agents (planning / wave / dev / review / merge) are deleted along with the package's `pi.agents` registration. Recursive orchestration is now the cw 2.0 runner's job (`cw run --root <id> --spawn pi`); "no self-review" is enforced at the ledger layer (`review submit` requires `--role reviewer`), no longer by tool whitelists.
  - The pi-cw skill is rewritten as a thin runner practical guide (background run, monitoring via cw_query, escalation handling, merge-back), deferring command-surface teaching to the cw-cli skill.
  - The 1.x workspace gating (detectRepoWorkspace + `--workspace` passthrough + cw version probing) is removed: cw 2.0 locates its ledger per-cwd under `~/.cw/` and has no `--workspace` flag.

  Migration: upgrade the global `@zhushanwen/coding-workflow` to 2.x, read the new pi-cw skill, and replace any cw_planning/cw_wave/cw_dev/cw_review usage with cw_query (reads) or bash `cw` invocations (writes). Design doc: docs/todo/pi-cw-cw2-adaptation.md in the xyz-agent repo.

## 0.4.3

### Patch Changes

- 291d9645a: fix: register worktree pid synchronously after spawn + robust cw spawn errors

  - `subagent-workflow` session-runner: register the worktree pid synchronously right after `spawn()` returns (`child.pid` is available synchronously), instead of only in the stdout header branch which never fires in RPC mode. Previously the pid stayed 0 and the orphan reaper deleted **live** worktrees after the 60s grace period — killing wave-agent cwds and breaking recursive orchestration. Adds warn logs for pid=0 entries past grace and pid-write failures (observability loop).
  - `cw-tool` cw-spawn: check cwd exists before spawning, and include the cwd in ENOENT error messages (previously only the command name was shown, causing misdiagnosis of missing worktree directories).

## 0.4.2

### Patch Changes

- bc336c3b5: Fix workspace gate activation and bare-repo detection in cw-tool

  - Activate gate threshold 99.0.0 -> 1.6.2 (first cw-cli tag with store-key normalization); cw-tool no longer passes --workspace to cw-cli >= 1.6.2
  - Harden detectRepoWorkspace: bare repo (.bare) git-common-dir returns undefined so old cw-cli falls back to per-cwd store (no "unit not found" on every write)
  - Append upgrade guidance to write-action errors in degraded modes

## 0.4.1

### Patch Changes

- 43a4ae5e6: Fix pi-cw skill internal inconsistency: the flow hardcoded `cw create epic` while description and "when to use" listed all four layers (epic/feature/slice/wave), blocking legitimate "feature as root" recursive orchestration.

  - Flow step 1 now uses `cw create <顶层>` with layer-selection guidance reused from cw-cli (the "scale × nature" table), plus an explicit gate: the root must split into ≥2 parallelizable child units, else use cw-cli's single-agent linear mode.
  - Generalize the planning-agent task template and frontier examples (`<epicId>` → `<根Id>`, "cw epic" → "cw <根层>").
  - Sharpen the pi-cw vs cw-cli boundary in "when to use / when not to use" from "tree depth" to "concurrency + context-isolation need" — an epic tree can be walked linearly by a single agent (cw-cli); pi-cw's value is isolation/parallelism.

  No engine or agent change required: planning-agent already supports epic/feature/slice as root, and cw-tool's `create` only forwards to the cw CLI.

## 0.4.0

### Minor Changes

- a0d700161: cw 生态改进：worktree-fork 解耦、cw-tool workspace gate、goal budget 默认策略

  - **pi-cw-tool**: 新增 workspace gate——探测 cw-cli store-normalization 能力，支持时作为纯 wrapper（不传 `--workspace`），不支持时回退 detectRepoWorkspace + `--workspace`。placeholder 版本号（99.0.0）保持当前行为不变，待 coding-workflow S1 落地后激活。同时把 planning-agent / wave-agent / pi-cw skill 的 `fork` 默认值改为 false。
  - **pi-subagent-workflow**: worktree（文件隔离）与 fork（上下文继承）解耦——移除 "worktree 必须配 fork" 的强约束，`worktree:true + fork:false` 现在可用。subagent-tool / types / notifier / bg-notify-render 同步去掉 fork+worktree 耦合描述。
  - **pi-goal**: 强化 budget 默认策略——tokenBudget 参数 description、tool description、promptGuideline 三处一致声明「默认不设预算；仅在用户显式要求或明确同意时才设；切勿自行决定」（timeBudget 已在上游 main 移除，本 PR 适配到 main 的新 schema 结构）。

## 0.3.1

### Patch Changes

- 3863af8f0: pi-cw skill: default subagent model to inherit the main agent, drop per-layer model recommendations.

  Previously the dispatch example hardcoded `model="glm-5.1"` and recommended per-layer model assignment (glm-5.1/ds-flash/ds-pro/glm-turbo), conflicting with the expectation that subagents inherit the parent agent's model. pi's subagent model resolution is three-layer (explicit param → agent frontmatter → parent current model passed through) and frozen at spawn via `--model`, so leaving `model` unset makes the whole cw tree inherit one model recursively with zero config. The skill now documents default-inherit with single-point override; per-layer differences are opt-in reference only.

## 0.3.0

### Minor Changes

- 76ecde5: builtin agent + skill: cw orchestration agents (dev/planning/review/wave/merge) and pi-cw skill now ship inside the package.

  cw 递归编排的 5 个 agent（dev/planning/review/wave/merge）与编排 skill（pi-cw）现打包在 @zhushanwen/pi-cw-tool 内，随 npm 分发。安装 cw-tool 即获得全套编排资源（cw\_\* 工具 + 5 agent + pi-cw skill），不再依赖项目 `.agents/` 手动复制。package.json 声明 `pi.agents` / `pi.skills`，被 pi-subagent-workflow resource-discovery（agent）与 pi core（skill）自动发现。

## 0.2.0

### Minor Changes

- b5c36a2: Land cw recursive orchestration tooling and harden subagent-workflow keep-alive.

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
