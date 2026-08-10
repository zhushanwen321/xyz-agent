# @zhushanwen/pi-cw-tool

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
