# @zhushanwen/pi-cw-tool

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
