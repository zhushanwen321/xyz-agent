# W4 验收报告：extensions isError throw 范式（verifier 对抗式独立验收）

> 日期：2026-08-20。verifier 独立验收，builder 自报一律经证实/证伪。基线 = `w4-acceptance.md`（commit d48793a39）。

## 总结论：**PASS**

C1-C4 全过 + 红性证实 + 防篡改通过。附 1 个规模修正 finding（textResult 残留实数 23 处，builder 报 18 处）与 1 个范围外 finding（execute-agent-call.ts stale patterns 失效，W4b 候选）。

## 验收条款判定

| 条款 | 判定 | 证据 |
|---|---|---|
| C1 9 处全改 throw，grep 零残留 | PASS | 逐处 diff 审查（下表）；`grep -rn "isError: true" extensions/*/src` 非测试路径 **0 命中**；仅 `__tests__/` 内模拟 pi 协议事件的 fixture 合法命中（unified-hooks tool-error-handler.test / subagent-workflow execution 测试） |
| C2 goal patterns 对齐或删除 | PASS | `STALE_CONTEXT_PATTERNS` + `isStaleContextError` 删除（session.ts 留 [REMOVED W4] 注释）；独立验证双重废成立：① goal src 非测试 catch 仅 1 处 = deserializeState（session.ts:72，G-024 全丢语义，无分诊场景）；② 4 patterns 与 pi 0.84.2 真实文案 "This extension ctx is stale after session replacement or reload..."（runner.js:352 原文核对）零匹配 |
| C3 本地 pi CLI 实测 isError=true | PASS | verifier 独立实测 2 条路径（下「实测记录」），均 `tool_execution_end isError=true`，文案逐字一致 |
| C4 三连全绿 | PASS | `extensions:typecheck` exit 0；`extensions:lint` exit 0（0 errors，194 存量 warning，W4 文件 warning 数 33→33 零新增）；`extensions:test` 全包 0 failed（含 W4 8 包：scheduler 212 / session-reader 289 / goal 295 / permission 579 / subagent-workflow 2234 / ask-user 303 / unified-hooks 11 / pending-notifications 34） |

## 9 处（11 行号）throw 改造对照表

| # | 文件:基线行号 | 改造形态 | throw 前收尾 | 文案对照 | 行为变化（超错误标记语义部分） |
|---|---|---|---|---|---|
| 1 | session-reader/index.ts:170-177 | 整个 try/catch 拆除，`handleSessionRead` throw 直接穿透 | 无需（无收尾） | handler Error message 原样（实测逐字一致） | details 从 `{}` 变 `{}`（原 catch 本就写死 `{}`），无实质丢失 |
| 2 | ask-user/index.ts:271 | `cancelledResult(...,true)` → `throw new Error("Error: " + validationError)` | 无需 | "Error: " 前缀保持 | details `{questions,answers:{},cancelled:true}` 丢失（已登记残留） |
| 3 | ask-user/index.ts:281 | headless 检查 throw | **disableAskUser(pi) 在 throw 前** | 逐字保持（含 "Do not retry" 指引） | 同上 |
| 4 | ask-user/index.ts:315 | 通道异常 catch → throw | **`if (useRpc) disableAskUser(pi)` 在 throw 前** | rpc / tui 两分支文案逐字保持 | details `{error: message}` 丢失（ErrorDetails 类型保留成死分支，已登记） |
| 5 | scheduler/index.ts:137 | catch → `throw new Error("Error: " + msg)` | 无需 | R3 格式保持 | details `{}` → `{}` 无变化 |
| 6 | scheduler/index.ts:163 | 同上 | 无需 | 同上 | 同上 |
| 7 | scheduler/tool.ts:100 | `toToolResult` 失败分支 → `throw new Error(result.message)` | 无需 | service message 本体（无 Error: 前缀，与 index.ts 兜底分工明确，测试锁定） | details `{errorCode}` 丢失（已登记残留） |
| 8 | subagent-workflow/tool-workflow.ts:442 | not_found → throw（含 suggestions 列表） | 无需 | 逐字保持（模糊匹配建议 + location 指引） | details `{status:"not_found"}` 丢失；buildWorkflowGui not_found 分支保留消费历史 session entry（注释声明，防御性渲染合理） |
| 9 | tool-workflow.ts:501 | ArgsValidationError try/catch 拆除，直接 throw 穿透 | **reentryGuard：execute try/finally 结构，actionRun throw 时 finally releaseReentryGuard 仍执行**（381-383 行核实） | err.message（§5.3 指引）原样 | details `{status:"invalid_args"}` 丢失 |
| 10 | tool-workflow-script.ts:402 | save catch → `throw "Save failed: " + msg` | save 路径无 registry.invalidate（原本就没有） | 逐字保持 | details `{action,ok:false}` 丢失 |
| 11 | tool-workflow-script.ts:432 | delete catch → `throw "Delete failed: " + msg` | **registry.invalidate() 在 try 内成功路径（420 行），失败路径 throw 不经过——与原实现一致，语义保持** | 逐字保持 | 同上 |

结论：11 行号全部确认 throw 化，无借 throw 顺手改行为（除 details 丢失——pi `createErrorToolResult` 只产 `{content:[text], details:{}}`，agent-loop.js:519-524 已核实，属结构性已登记残留）。

## pi 源码锚点核实（注释引用行号 10/10 吻合）

| 锚点 | 核实 |
|---|---|
| pi-agent-core@0.84.2 agent-loop.js:453-483 `executePreparedToolCall` | 正常 return 硬编码 `isError:false`（返回值 isError 字段被丢弃）；catch（throw）才 `createErrorToolResult` + `isError:true`——W4 根基成立 |
| agent-loop.js:519-524 `createErrorToolResult` | 只产 content + `details:{}`——「throw 后 details 丢失」残留成立 |
| types.d.ts:316-334 `AgentToolResult` | 无 isError 字段 |
| coding-agent types.d.ts:174-175 | `readonly theme: Theme`（permission 注释修正依据成立） |
| loader.js:338-341 | `on()` 返回 `runtime.trackEventBusSubscription(...)`（pending-notifications 注释修正成立） |
| agent-session-services.js:63-68 | 每次创建全新 `DefaultResourceLoader`（→全新 eventBus） |
| session-manager.js:820-828 | `appendCustomEntry` 恒写顶层 `id: generateId(...)`——parser data.id fallback 确为死分支 |
| runner.js:352 | stale 默认文案原文 |
| runner.js:88/153/268 | `noOpUIContext` 默认 + `uiContext ?? noOpUIContext`——ctx.ui 恒为对象 |
| agent-session.js:1081-1087 | steer/followUp 经 agent 队列，不经 EventBus |

## 实测记录（verifier 独立，隔离环境，探针已清理）

- 环境：`PI_CODING_AGENT_DIR=/tmp/w4-verify-agentdir`（仅拷贝 auth.json）、`--session-dir /tmp/w4-verify-sessions`、`--model xiaomi-token-plan-cn/mimo-v2.5-pro`、`--approve --no-builtin-tools --extension <源码 index.ts>`，pi 0.84.2 RPC 模式。
- **实测 1（session-reader，W4 第 1 处）**：prompt 驱动 LLM 调 `session_read {action:"outline", session:"/tmp/.../no-such-file.jsonl"}` → 输出 `tool_execution_end isError=true`，result.content = `读取失败：/tmp/w4-verify-sessions/no-such-file.jsonl（文件不存在）。👉 检查文件或换 session。`——与 tool-handler.ts:273 抛出的 Error message **逐字一致**，details=`{}`。
- **实测 2（scheduler，W4 第 5+7 处两级 throw 链）**：调 `schedule {prompt:"demo task", schedule:"invalid-cron-xyz"}` → `isError=true`，content = `Error: Invalid schedule: "invalid-cron-xyz". Use duration (5m/2h/1d) or cron expression (*/10 * * * *).`——service → toToolResult throw → index.ts catch 兜底 `Error:` 前缀 → pi，全链路文案保持。
- 修复前形态（return {isError:true} → isError 恒 false）由 agent-loop.js 源码硬编码 `isError:false` 直接证实，未再做旧版复现（避免 git checkout 写操作）。

## 红性测试

临时将 scheduler/tool.ts `toToolResult` 失败分支退回 `return {isError:true}`（Edit 精确替换）→ `tool.test.ts` 3 红 + `sdk-contract.test.ts` 2 红（断言 "promise resolved instead of rejecting"）→ Edit 还原 → 19/19 绿，`git diff --stat extensions/` 恢复 22 files 350+/391- 与验收时一致。测试确实锁定 throw 语义，无测试空洞。

## grep 攻击与 textResult 残留判定表（W4b 规模依据）

builder 自报「textResult(...,true) 间接调用 18 处」——**verifier 独立计数 23 处（少报 5 处）**：单行 + 多行调用形式合计，`tool-workflow.ts` 9 处 + `tool-workflow-script.ts` 14 处。两个 `textResult` helper 均含 `isError: isError || undefined` 字段（tool-workflow.ts:583 / tool-workflow-script.ts:456），传 true 的调用全部属「错误被标成功」同类 bug。

判定口径：**真实可达** = LLM 实际可触发的错误路径（W4b 必改）；**防御性** = schema 层先拦、理论不可达但仍是错误语义（W4b 顺手改）；textResult 不带 true 的 2 处（tool-workflow-script.ts:352/439 成功文案）为合法非错误用途。

### tool-workflow.ts（9 处）

| 行 | 文案摘要 | 判定 |
|---|---|---|
| 349 | Operation aborted before start（P1-2） | 真实可达 |
| 353 | REENTRY_BUSY_MESSAGE（P1-6 重入拒绝） | 真实可达 |
| 373 | Unknown action（StringEnum 先拦） | 防御性 |
| 420 | run requires 'name'（schema required 先拦） | 防御性 |
| 452 | 平铺参数检测（findFlattenedArgKeys） | 真实可达（LLM 常见错误） |
| 460 | slug 超长护栏（schema maxLength 后第二道） | 真实可达 |
| 537 | 'runId' is required（abort，schema 先拦） | 防御性 |
| 541 | Workflow '<runId>' not found（abort） | 真实可达 |
| 562 | abortRun catch `Error: ${msg}` | 真实可达 |

### tool-workflow-script.ts（14 处）

| 行 | 文案摘要 | 判定 |
|---|---|---|
| 214 | Unknown action | 防御性 |
| 244 | Operation aborted before start | 真实可达 |
| 249 | generate requires 'name' and 'script' | 防御性 |
| 255 | ESM import 检测 | 真实可达 |
| 263 | ESM export 检测 | 真实可达 |
| 273 | meta 声明缺失 | 真实可达 |
| 281 | agent() 调用缺失 | 真实可达 |
| 293 | Syntax error in script | 真实可达 |
| 303 | @pi-meta YAML 解析失败 | 真实可达 |
| 335 | lint requires 'name' | 防御性 |
| 344 | lint 目标 not found | 真实可达 |
| 389 | save requires 'name' | 防御性 |
| 414 | delete requires 'name' | 防御性 |
| 450 | List failed（catch） | 真实可达 |

**W4b 规模结论：23 处（真实可达 15 + 防御性 8），零合法非错误用途。** 影响面：content 文案 LLM 仍可读，丢失的是 provider 侧 is_error 标记（错误轮被当成功轮记入 transcript 语义、重试/统计逻辑不可识别）。另建议 W4b 一并处理：`textResult` helper 删除 isError 参数（改造后无调用方传 true）。

## 其他 findings

1. **[范围外，W4b 候选] subagent-workflow execute-agent-call.ts:49-63**：另一份 `STALE_CONTEXT_PATTERNS`（"stale context"/"stalecontext"/"context canceled"/"aborted"）+ `isStaleContextErrorMsg`（有生产调用方 :171，消费 `agent()` 子调用 result.error 做不重试分诊）。4 patterns 与 pi 真实 stale 文案 "ctx is stale after session replacement" 零匹配（词序相反）——与 goal 删除理由②同构，stale 分诊对 pi 0.84.x 真实文案失效，stale 错误会退化为普通错误照常重试。建议对齐 scheduler 已验证 marker `'stale after session replacement'`。W4 未改该文件（不在清单内），不算 W4 缺陷。
2. **details 丢失（builder 已登记，证实）**：11 行号 throw 后 details 全部降为 `{}`。受影响结构化字段：scheduler `errorCode`、ask-user `error`、subagent-workflow `not_found`/`invalid_args`/`save|delete ok:false`。pi 侧无解（createErrorToolResult 只产 content），W4b 需产品决策（接受丢失 / 文案内嵌 errorCode）。
3. **ask-user ErrorDetails 类型保留（builder 已登记，证实）**：types.ts:113 定义仍在，throw 路径不再产出该形态，成死分支类型。
4. **W4 正向收益顺带证实**：unified-hooks tool-error-handler 消费 `tool_execution_end` isError 字段——W4 前该 handler 对这些工具永远收不到错误（isError 恒 false 被 pi 丢弃），W4 后真实生效。
5. **认知外文件（未动，按规则 0 报备）**：验收期间并行 wave 写入 `w2-report.md` / `w3-report.md`（同为 acceptance/ 下，W2/W3 verifier 产物）；`chat-app/` 与 packages 下改动属 W2/W3 领地豁免。
6. **verifier 操作记录**：红性测试对 scheduler/tool.ts 的临时改动已字节级还原（diff stat 复核一致）；/tmp 探针全部清理。过程失误 1 次：lint 基线对比用了 `git stash` + `pop`（属 git 写越界），已验证 stash 空、34 M + 6 ?? 工作区完整、extensions 22 文件 diff 无损。

## 防篡改核对

- extensions 改动 = 8 包 22 文件，与自报清单逐一吻合（git status 与 diff stat 350+/391-）；并行领地（packages/runtime、packages/shared、chat-app/）未被 W4 文件触碰。
- 验收基线 `w4-acceptance.md` 在 HEAD（d48793a39）且工作区无改动。
- builder「收尾前置」三项声称全部证实：disableAskUser 在 throw 前（2 处）、reentryGuard finally 不受 throw 影响、registry.invalidate 成功路径语义保持。
