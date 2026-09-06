# 继承复杂度债务清单（2026-09-16 全仓普查）

> 生成方式：`fallow health --max-cyclomatic 15 --sort cyclomatic --top 423`（全仓 336,995 LOC，
> 平均圈复杂度 2.8 / p90 = 6，整体健康度 90.2/100 good）。
> 背景：PR #198 的 metrics-gate（introduced-only）已把**本 PR 引入**的复杂度全部清零
> （21 个超标函数重构到 ≤12）；本清单是**存量**（main 上即存在，门禁口径不覆盖），
> 登记供后续渐进偿还——**不建议在发布 PR 内一次性重构**（top 项多为 500 行级核心分发函数，
> 行为保持验证成本高，风险收益不匹配）。

## 总量

- 全仓 cyclomatic > 15 的函数：**130 个**（占 423 个大函数的少数，全仓函数基数更大）
- CRITICAL（>30）集中区：runtime 的 4 个 message-handler / event-adapter / session-lifecycle，subagent-core 的 meta-parser / session-reconstructor

## Top 25（按圈复杂度降序）

| # | cyclo | 位置 | 函数 | 备注 |
|---|-------|------|------|------|
| 1 | 96 | runtime/transport/session-message-handler.ts:69 | handleSessionMessage | 534 行，消息分发主干 |
| 2 | 77 | runtime/transport/settings-message-handler.ts:68 | handleSettingsMessage | 486 行 |
| 3 | 61 | subagent-core/shared/meta-parser.ts:79 | typecheckMeta | 116 行高密度 |
| 4 | 55 | runtime/infra/pi/event-adapter.ts:392 | handleExtensionUIRequest | 243 行 |
| 5 | 52 | runtime/transport/extension-message-handler.ts:99 | handleExtensionMessage | 184 行 |
| 6 | 50 | runtime/services/session/session-lifecycle.ts:272 | create | 186 行 |
| 7 | 48 | dom-core/composer/input/input-dom.ts:84 | visitNode | |
| 8 | 48 | subagent-core/execution/session-reconstructor.ts:306 | reconstructFromFile | |
| 9 | 44 | runtime/cli/commands.ts:69 | executeCommand | |
| 10 | 43 | renderer/composables/logic/markdown.ts:684 | scanMarkdownBlocks | |
| 11-25 | 31-39 | taste-lint walkStatements、runtime listProviders/applyImport/rpc-client.start/event-interpreter.handle/forkSession、electron download-asset/cleanupCompletedUpdate、dom-core moveCaretVerticalOf、renderer renderIncremental、migration parsers ×2、subagent-workflow WorkflowsView.handleInput 等 | | 完整清单跑上方命令 |

## 偿还策略建议（登记待批）

1. **不动门禁阈值**：introduced-only 门禁继续拦截新增（本 PR 已实证有效）。
2. **触及即偿还**：后续 PR 凡改动本清单文件，要求顺手把所触函数降到 ≤15（review agent
   的 complexity 维度已消费 metrics.json warn 清单，可加此约定）。
3. **专项批次**：top 6（消息分发族 + meta-parser）值得独立 tech-design + dev-flow 批次
   （表驱动 dispatch 重构是显然形态——四个 message-handler 的 switch 分发同构，
   可一并考虑统一分发框架，与 duplicate-code-audit D8 的 MessageHandlerContext 收敛呼应）。
4. 每 PR 偿还后更新本清单计数（或直接删除对应行）。

## 变更历史

- 2026-09-16 创建（PR #198 清零行动附产物；同批落地的护栏：tsconfig 测试纳入 typecheck
  ×2 包、vitest setup 宿主 env 剥离、alias↔tsconfig 同步守卫 `scripts/check-alias-tsconfig-sync.mjs`
  已接 CI invariants）。
