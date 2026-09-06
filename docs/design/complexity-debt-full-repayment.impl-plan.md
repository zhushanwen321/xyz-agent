# 继承复杂度债务全量清零（第二批）实施计划

基线: <见 git log docs(impl-plan)> | 来源设计: docs/design/complexity-debt-full-repayment.md | 日期: 2026-09-06

## 0 章节映射

| 内容 | 设计文档实际位置 |
|------|------------------|
| 背景/目标 | §1 背景/目标 |
| 终态/机制 | §2 终态/机制（含 commit 粒度与回滚通道、特殊风险点表） |
| 验收场景表 | §3 验收场景表 A1-A12 |
| 下一层拆分 | §4 下一层拆分 |
| 待验证检查点 | §3 A1（fallow=0 + helper ≤12 抽验）、A7（字面量抽样比对）、A8/A9（lint 与 bundle 产物 diff） |

## 1 目标快照（逐字摘录自设计 §1）

> 全仓 cyclomatic>15 函数清零（fallow health --max-cyclomatic 15 复测 = 0 findings）；每个目标函数与提取的新 helper 全部降到 ≤12（保守余量）；行为保持：错误文案、调用时序、事件发射顺序、返回值语义逐字节不变；债务清单 SSOT（docs/todo/complexity-debt-inventory.md）终态删除。
>
> Out-of-scope：不动 introduced 门禁阈值；不借重构改行为/修 bug/加功能；不改 fallow 工具与 metrics-gate 脚本；第一批 21 项不回炉。

## 2 单元列表

27 unit / 93 文件 / 109 函数（脚本校验：全覆盖、零交集、每 unit ≤5 文件）。派发通道一律原生 Agent tool（run_in_background）；worker 禁跑 vitest/fallow、禁 git。

| Unit | 职责（目标函数(复杂度)） | 领地（精确文件路径） | 依赖 | 隔离 | 特殊处置 | 验收条款 |
|------|--------------------------|----------------------|------|------|----------|----------|
| U01 | walkStatements(39) + **补规则判定测试先行** | taste-lint/rules/no-unbounded-while-true.mjs（+ 新测试文件，对齐 no-chat-ops-in-components.test.mjs 形态） | 无 | plain | 规则测试修前绿；运行通道 `pnpm exec vitest run taste-lint` | cyclo≤12；测试落绿；`pnpm run lint` findings 前后 diff 为空 |
| U02 | Composer.vue onKeydown(20)、SettingsModal.vue onKeydown(18) | packages/renderer/src/components/panel/Composer.vue、packages/renderer/src/components/settings/SettingsModal.vue（+ 新 composable 文件，按项目目录约定） | 无 | plain | Composer script 299/300 行硬拦：**必拆 composable**；ADR-0049 checklist 核对 | vue-tsc 0 错误；cyclo≤12；vue_rules_checker 过（pre-commit） |
| U03 | downloadAsset(35)、cleanupCompletedUpdate(35)、maybeRollbackInterruptedUpdate(25)、getDescendantPids(16) | apps/electron/main/update/download-asset.ts、apps/electron/main/update/update-self-healer.ts、apps/electron/main/supervisor/process-control.ts | 无 | plain | 行为漂移=事故级；报告列既有测试覆盖分支清单 | 包 vitest 0 failed；cyclo≤12 |
| U04 | runAndFinalize(31)（2369 行巨型文件） | packages/subagent-core/src/execution/subagent-service.ts | 无 | plain | **锚定测试先行**：先补特征用例修前绿，再重构；报告逐分支行为等价证据 | 包 vitest 0 failed；cyclo≤12 |
| U05 | validateFixResult(27)、reconcileIssues(26)（.cjs 运行时） | packages/subagent-core/workflows/review-fix-loop-utils.cjs | 无 | plain | 纯提取不改导出；**顺手修正头注释过时测试路径** | subagent-core vitest 含 review-fix-loop-utils.test.ts 0 failed；node --check；cyclo≤12 |
| U06 | bundleOne(20)、validate(28)、main(25)（CI/pre-commit 关键链路） | scripts/bundle-extensions.mjs、scripts/render-constraints.mjs、scripts/verify-staged-extensions.mjs | 无 | plain | 真实干跑 diff 输出锚定；bundle-extensions 产物比对走全局 A9 | 各脚本干跑 diff 为空；node --check；cyclo≤12 |
| U07 | setServices(26)、handleFileMessage(23)、handleBridgeRequest(20)、handleGitMessage(19)、handlePresetMessage(19) | packages/runtime/src/transport/{server,file-message-handler,bridge-handler,git-message-handler,preset-message-handler}.ts | 无 | plain | — | runtime vitest 0 failed；tsc 0 错误；cyclo≤12 |
| U08 | handlePluginMessage(18)、sendBash(24)、createForkedSessionFile(19)、findSubagentSessionFile(17)、tailReadHistory(16) | packages/runtime/src/transport/plugin-message-handler.ts、packages/runtime/src/services/session/{message-dispatcher,session-fork,subagent-extractor}.ts、packages/runtime/src/services/session-history.ts | 无 | plain | session-fork 触碰 pi session 文件语义（EEXIST 红线） | 同 U07；文件操作时序逐条确认 |
| U09 | parsePlugin(26)、dispatch(24)、handleMessage(16) | packages/runtime/src/services/plugin-service/{plugin-registry,plugin-rpc-server,plugin-bootstrap}.ts | 无 | plain | — | 同 U07 |
| U10 | classifyCredential(18)、previewImport(18)、migrateLegacyProviderConfig(19)、parsePresetsFileFromDisk(16)、parseSkillMd(16) | packages/runtime/src/services/migration/parsers/pi-parser.ts、packages/runtime/src/services/migration/provider-importer.ts、packages/runtime/src/services/migration/legacy-provider-migration.ts、packages/runtime/src/services/preset-service.ts、packages/runtime/src/services/scanners/skill-scanner.ts | 无 | plain | — | 同 U07 |
| U11 | globToRegex(20)、xyToGitStatus(18)、rebuildHistoryFromEntries(16)、runDeviceCodeFlow(17)、handleAgentEnd(17) | packages/runtime/src/infra/fs/ignore-parser.ts、packages/runtime/src/infra/git/git-status-parser.ts、packages/runtime/src/infra/pi/{entry-tree-builder,event-adapter}.ts、packages/runtime/src/services/auth/device-code-flow.ts | 无 | plain | — | 同 U07 |
| U12 | parseSingleRecord(20)、segmentsToText(24) | packages/shared/src/{message,segments}.ts | 无 | plain | shared 被多包消费：导出面零变化 | shared vitest + runtime/core 渲染侧 vitest 0 failed |
| U13 | parseAgentWithMeta(26)、defaultDialogForward(30)、extractMethodFields(24) | packages/subagent-core/src/execution/{agent-registry,ui-request-handler-factory,ui-request-queue}.ts | 无 | plain | — | subagent-core vitest 0 failed；cyclo≤12 |
| U14 | updateFromEvent(26)、jsonlToAgentEvent(19)、addUsage(16)、doFinalizeRecord(22)、parseIdentityFromText(19) | packages/subagent-core/src/execution/{execution-record,finalize-record,session-reconstructor}.ts | 无 | plain | — | 同 U13 |
| U15 | scanFile(23)、walkAndClean(22)、isPositiveIndexEntry(19)、loadIndex(18) | packages/subagent-core/src/execution/{record-store,session-file-gc,sessions-index}.ts | 无 | plain | fs 操作时序保持 | 同 U13 |
| U16 | validateRunArgs(18)、executeNestedWorkflow(17)、forEachAgentCallRange(26)、checkMetaQuality(18) | packages/subagent-core/src/orchestration/{args-validator,launcher,script-lint}.ts | 无 | plain | — | 同 U13 |
| U17 | formatToolCallSummary(30)、findSessions(27)、parseRunSnapshot(23)、renderWorkflowOverview(23)、mapCallToStep(20) | extensions/universal/session-reader/src/core/{toolcall,workflow}.ts、extensions/universal/session-reader/src/discovery/find.ts | 无 | plain | — | extensions 三连 0 failed；cyclo≤12 |
| U18 | extractCommits(24)、doSearch(16)、buildFamilyIndex(20)、renderOutline(19)、toEntry(18) | extensions/universal/session-reader/src/{tool-handler.ts,core/family.ts,core/render.ts,core/parser.ts} | 无 | plain | — | 同 U17 |
| U19 | buildFamilyFromFs(19)、readTailIdentity(18)、extractCallSessionFiles(18)、parseGoalArgs(16)、renderTodoResult(16)、countActiveFromEntries(18) | extensions/universal/session-reader/src/discovery/{subagents,workflows}.ts、extensions/universal/{goal/src/commands.ts,todo/src/render.ts,pending-notifications/src/state.ts} | 无 | plain | — | 同 U17 |
| U20 | parsePlainCommand(21)、classifyRisk(19)、checkPermission(20)、editViaRpc(16)、execute(22) | extensions/universal/permission/src/{ast/analyzer.ts,classifier/classifier.ts,pipeline.ts,rule-editor.ts}、extensions/universal/plan/src/tool.ts | 无 | plain | — | 同 U17 |
| U21 | handleOptionsInput(19)、buildOptionLines(24)、validateInput(18)、executeScheduleCommand(16)、replayFoldEntries(19) | extensions/universal/ask-user/src/{component.ts,question-view.ts,validate.ts}、extensions/universal/scheduler/src/{commands.ts,replay.ts} | 无 | plain | — | 同 U17 |
| U22 | handleInput(31)、renderLevel1(19)、saveTraceToFile(16)、formatToolCall(29)、processKey(27)、buildDetailContent(22)、renderSplitBox(17) | extensions/universal/subagent-workflow/src/interface/{views/WorkflowsView.ts,format.ts,list-view.ts,list-component.ts} | 无 | plain | — | 同 U17 |
| U23 | bench×2（main 31/29、parseArgs 16/19）、classifyFailure(17)、arrow(19)（.mjs/.bench 无自动通道） | extensions/universal/subagent-workflow/bench/{cold-scan,concurrent-scan}.bench.ts、extensions/universal/rename-session/e2e/{harness.mjs,run-a1.mjs} | 无 | plain | bench/tsc+node --check 锚定（显式登记不运行）；run-a1 主会话手工跑一轮 | node --check / tsc；cyclo≤12；A10 |
| U24 | computeTraceWindow(24)、deriveStatus(21)、unsub(19)、expandAssistantMessageBlocks(17)、message.queue_update(18) | packages/core/src/domain/chat/{trace-window,derive-status,useChat,message-turns}.ts、packages/core/src/domain/chat/effects/registry.ts | 无 | plain | — | core vitest 0 failed；cyclo≤12 |
| U25 | parseContributes(18)、parseStatusBarUpdate(16)、onSend(23) | packages/core/src/extension-host/{contribution-registry,message-bus-bridge}.ts、packages/core/src/domain/composer/dispatch/send.ts | 无 | plain | — | 同 U24 |
| U26 | runRender(22)、resolveInitialAuthMethod(19) | packages/ui/src/features/chat/composables/useMarkdownStreaming.ts、packages/ui/src/features/settings/provider/use-quick-setup-form.ts | 无 | plain | — | ui vitest + renderer vitest 0 failed |
| U27 | runSmoke(17)、parseArgs(20)、arrow(19)+main(19)、handleBackspaceOnChip(17)、spec arrow(19) | scripts/{dev-smoke.mjs,visual-capture.mjs,verify-scheduler-e2e.cjs}、packages/dom-core/src/composer/input/chip-commands.ts、e2e/workflow-thinkinglevel-real.spec.ts | 无 | plain | 脚本干跑 diff；spec 重构后 A10 锚定 | 干跑 diff 为空；dom-core vitest 0 failed；cyclo≤12 |

## 3 DAG 图

重构均为文件内提取、unit 领地互斥 → 无跨 unit 数据依赖，DAG 接近平铺。分层仅表达派发波次（流式调度：unit committed 即解锁下一波补派，不整层等待）：

```mermaid
graph TD
  subgraph W1[Wave1 特殊处置先导 · 6 并发]
    U01[U01 taste-lint 规则<br/>测试先行]
    U02[U02 vue keydown<br/>必拆 composable]
    U03[U03 electron 更新族]
    U04[U04 runAndFinalize<br/>锚定先行]
    U05[U05 rfl.cjs]
    U06[U06 scripts 关键链路]
  end
  subgraph W2[Wave2 runtime+shared · 6 并发]
    U07[U07 rt-transport-a]
    U08[U08 rt-transport-b-session]
    U09[U09 rt-plugin]
    U10[U10 rt-migration-scan]
    U11[U11 rt-infra-auth]
    U12[U12 shared]
  end
  subgraph W3[Wave3 subagent-core · 4 并发]
    U13[U13 sc-exec-a]
    U14[U14 sc-exec-b]
    U15[U15 sc-exec-c]
    U16[U16 sc-orch]
  end
  subgraph W4[Wave4 extensions · 7 并发]
    U17[U17 sr-top3]
    U18[U18 sr-mid]
    U19[U19 sr-tail-misc]
    U20[U20 permission-plan]
    U21[U21 askuser-scheduler]
    U22[U22 sw-interface]
    U23[U23 sw-bench-rename]
  end
  subgraph W5[Wave5 core/ui/scripts · 4 并发]
    U24[U24 core-chat]
    U25[U25 core-exthost]
    U26[U26 ui]
    U27[U27 scripts-dom-e2e]
  end
  W1 -.->|"范式先导验证通过后放行后续波"| W2
```

无串行边（领地互斥 + 文件内提取）；W1→W2 的虚线是**流程门**（特殊处置范式验证），非数据依赖。波间共享包的 vitest 串行由主会话统一排队。

## 4 测试策略（命令从 package.json / CI 实读）

- **增量（unit 级，worker 自检）**：ts 领地 `npx tsc --noEmit`；.vue 领地 `npx vue-tsc --noEmit`；.cjs/.mjs 领地 `node --check`。worker 禁跑 vitest/fallow。
- **波收口（主会话串行，vitest 全局排队）**：按波涉及包跑 `npx vitest run`——runtime / subagent-core / renderer / dom-core / ui / core / shared / apps/electron(`cd main && npx vitest run`)；`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test`；仓库根 `pnpm exec vitest run taste-lint`（U01 修前 + 波收口）。
- **全量（阶段 5）**：A1-A12 全表（设计文档 §3），含 `pnpm run lint` findings diff（A8）、bundle-extensions 产物 diff（A9）、playwright TC1 + run-a1.mjs（A10）。
- 慢用例排查：各包 junit xml（`test-results/vitest-junit.xml`）。

## 5 合理偏差登记表

| Unit | 偏差 | 裁决 | 状态 |
|------|------|------|------|
| U17 | U18 staged 文件被同批 add 带入 U17 commit（fab5876ac 含两 unit） | 接受：内容均已单独验证，同 extensions 域合批不损回滚粒度 | 已裁决 |
| U17/U16 | 同文件非目标函数顺手消重（mapCacheEntryToStep、runAndWait lint 段） | 接受：行为零漂移有锚定，消真差异 | 已裁决 |

## 6 状态表

| Unit | 状态 | 轮次 | 证据指针 |
|------|------|------|----------|
| U01 | committed | 1 | c65ce3759 |
| U02 | committed | 1 | 69300aa25 |
| U03 | committed | 1 | 66b942b0e+50612b2d5 |
| U04 | committed | 1 | 3f5fda9b3 |
| U05 | committed | 1 | d44be8434 |
| U06 | committed | 1 | 3d104f42f |
| U07 | committed | 1 | c14638edb+cc79cff3b |
| U08 | committed | 1 | 01ddc2041+12dc75582 |
| U09 | committed | 1 | 98e3e0450 |
| U10 | committed | 1 | babd1138a |
| U11 | committed | 1 | dfcd0b49a |
| U12 | committed | 1 | d61151d72 |
| U13 | committed | 1 | 8c822baeb |
| U14 | committed | 1 | 07d16048b |
| U15 | committed | 1 | f9b5d6629 |
| U16 | committed | 1 | 217dc21ac |
| U17 | committed | 1 | fab5876ac |
| U18 | committed | 1 | fab5876ac（并入，见偏差登记） |
| U19 | committed | 1 | deb426f99 |
| U20 | committed | 1 | dd5314908 |
| U21 | committed | 1 | 157e7108c |
| U22 | committed | 1 | c6d96b070 |
| U23 | committed | 1 | c6d96b070（并入） |
| U24 | committed | 1 | 8c9e2da43 |
| U25 | committed | 1 | 8c9e2da43（并入） |
| U26 | committed | 1 | 0db23f064 |
| U27 | committed | 1 | c407af332 |

（2026-09-06 终态校准：27/27 committed。轮次说明：U03 含 1 轮时序修复、U08 含 3 轮（PiBashResult 泄漏 + 竞态时序 ×2）、U07 含断言修订补 commit cc79cff3b。U18 并入 fab5876ac、U23 并入 c6d96b070、U25 并入 8c9e2da43——同域 staged 合批，均已单独验证。）

## 7 残留风险与变更历史

### 残留风险

1. U02 拆 composable 触发 ADR-0049：若 onKeydown 持有 per-session 状态，必须 useSessionScopedState 工厂——reviewer 按 ADR-0049 checklist 核对；拆错目录归属算 doc_errors 级偏差。
2. U04 subagent-service 2369 行文件多函数并存（runAndFinalize 仅其一）：worker 严格限定只动目标函数链路，报告须声明未触碰同文件其他函数。
3. U06/U27 脚本干跑有副作用（render-constraints 会重写 docs/constraints.md、verify-staged-extensions 读 staged 区）：干跑前 git stash 工作区、干跑后 diff 恢复，主会话执行而非 worker。
4. 高并发（波内 6-7 worker）可能触发 provider 限流：worker 失败率异常时降半并发重派，不静默重试。
5. 本机高负载（load>4）时 runtime real-pi 类用例漂移假红：以单跑复跑为准（第一批实证教训）。

### 变更历史

- 2026-09-06 创建：27 unit / 93 文件 / 109 函数，脚本校验全覆盖、零交集、≤5 文件/unit。用户本轮消息「进入开发后尽量用高并发度」= 评审确认 + 并发度指令（波内 6-7，超出全局默认 5 以用户指令为准）→ 按预授权进入阶段 2。

- 2026-09-06 状态表校准至终态：27/27 unit committed（以 git log a76440034..HEAD 为准）；A1-A12 验收执行中，A11 design-code-sync 校准记录随轮次追加。
