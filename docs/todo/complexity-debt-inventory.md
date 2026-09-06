# 继承复杂度债务清单（2026-09-16 全仓普查，渐进偿还中）

> 生成方式：`fallow health --max-cyclomatic 15 --sort cyclomatic --top 423`（全仓 336,995 LOC，
> 平均圈复杂度 2.8 / p90 = 6，整体健康度 90.2/100 good）。
> 背景：PR #198 的 metrics-gate（introduced-only）已把**本 PR 引入**的复杂度全部清零
> （21 个超标函数重构到 ≤12）；本清单是**存量**（main 上即存在，门禁口径不覆盖），
> 登记供后续渐进偿还——**不建议在发布 PR 内一次性重构**（top 项多为 500 行级核心分发函数，
> 行为保持验证成本高，风险收益不匹配）。

## 总量

- 全仓 cyclomatic > 15 的函数：**109 个**（2026-09-06 批次偿还前为 130）
- CRITICAL（>30）剩余：taste-lint walkStatements(39)、electron download-asset/cleanupCompletedUpdate(35×2)、
  subagent-workflow WorkflowsView.handleInput(31)、subagent-core runAndFinalize(31)、
  session-reader formatToolCallSummary(30)、subagent-core defaultDialogForward(30)

## 2026-09-06 批次偿还（21 项，130 → 109）

Top 10 全部 + 同文件顺带 + migration 解析器族，全部降到 ≤12（fallow 复测零残留）。
范围：runtime transport 三 message-handler（96/77/52）、event-adapter(55)、cli executeCommand(44)、
provider-config-helper(38/31)、session-lifecycle create/forkSession(50/32)、rpc-client start(33)、
event-interpreter handle(33)、migration applyImport + 三 parser(35/31/31/30)、subagent-core
meta-parser(61)/session-reconstructor(48)、dom-core input-dom(48/35)、renderer markdown(43/36)。
验证：五包 vitest 全绿（runtime 4757 / subagent-core 3215 / renderer 3767 / dom-core 176 / ui 45）、
tsc ×4 + vue-tsc 全绿、metrics-gate fail=0、对抗式复审（2 reviewer 并行）零 must-fix。
本批同文件剩余 >15 函数（触及即偿还候选）：provider-importer previewImport(18)、
pi-parser classifyCredential(18)、event-adapter handleAgentEnd(17)、
session-reconstructor parseIdentityFromText(19)。

## 剩余 Top（按圈复杂度降序，2026-09-06 复测）

| # | cyclo | 位置 | 函数 | 备注 |
|---|-------|------|------|------|
| 1 | 39 | taste-lint/rules/no-unbounded-while-true.mjs:34 | walkStatements | |
| 2 | 35 | apps/electron/main/update/download-asset.ts:189 | downloadAsset | |
| 3 | 35 | apps/electron/main/update/update-self-healer.ts:410 | cleanupCompletedUpdate | |
| 4 | 31 | extensions/universal/subagent-workflow/src/interface/views/WorkflowsView.ts:294 | handleInput | |
| 5 | 31 | packages/subagent-core/src/execution/subagent-service.ts:1830 | runAndFinalize | 1830 行巨型文件，风险高 |
| 6 | 30 | extensions/universal/session-reader/src/core/toolcall.ts:115 | formatToolCallSummary | |
| 7 | 30 | packages/subagent-core/src/execution/ui-request-handler-factory.ts:187 | defaultDialogForward | |
| 8- | 16-29 | 完整清单跑上方命令 | | 105 项 |

## 偿还策略

1. **不动门禁阈值**：introduced-only 门禁继续拦截新增（PR #198 已实证有效）。
2. **触及即偿还**：后续 PR 凡改动本清单文件，要求顺手把所触函数降到 ≤15（review agent
   的 complexity 维度已消费 metrics.json warn 清单，可加此约定）。
3. **专项批次**（已验证可复制的范式，见 2026-09-06 批次）：按包领地互斥并行派 worker
   （≤5 文件/人，禁跑 vitest），主会话统一串行验证（vitest 全局串行防 oxc/vite 缓存竞争假红），
   HEAD 对照裁决测试分歧，对抗式复审收口。
4. 每批偿还后更新本清单计数（或直接删除对应行），终态删除该文件。

## 变更历史

- 2026-09-16 创建（PR #198 清零行动附产物；同批落地的护栏：tsconfig 测试纳入 typecheck
  ×2 包、vitest setup 宿主 env 剥离、alias↔tsconfig 同步守卫 `scripts/check-alias-tsconfig-sync.mjs`
  已接 CI invariants）。
- 2026-09-06 批次偿还 21 项（130 → 109）：Top 10 全部 + 同文件顺带 + migration 解析器族；
  范式与验证记录见上方「2026-09-06 批次偿还」节。
