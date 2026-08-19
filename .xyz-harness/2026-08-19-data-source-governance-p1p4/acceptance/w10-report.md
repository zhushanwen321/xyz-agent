# W10 验收报告：applyContextUpdate 收编 + switchModel 重算入 owner

> verifier 独立对抗验收（builder 自报一律待证实）。验收权威：`w10-acceptance.md` + `docs/architecture/data-source-governance-plan.md` §W10（L343-364）。

## 总结论：PASS（附 2 项 minor 非阻塞发现，移交主 agent）

## 1. 基线与防篡改

- 验收基线 commit：`b8db5afe7`；工作区分支 `fix-chat-flow-order`，HEAD = `ed26b3da8`。
- `git diff b8db5afe7 -- .xyz-harness/.../w10-acceptance.md docs/architecture/data-source-governance-plan.md` = **空**（两文档零篡改）。
- sha256（验收时点）：
  - `7d89555c65033abbfdfb287e86e52fa25ac62223b41ee137da16aa143e5034ac` w10-acceptance.md
  - `f76097ed3055fd88b6d29e6bdbcc0c5216d78e0dc14e105519ca6795cc1f06c4` data-source-governance-plan.md

### 越界扫描（工作区全部变更 vs 豁免清单）

| 变更 | 归属 | 裁定 |
|---|---|---|
| M packages/runtime/src/services/session/session-service.ts | W10 清单 | 豁免 |
| M packages/runtime/src/services/session/replicated-states.config.ts | W10 清单（仅 usage 条目注释 + 新增 recomputeUsageWithWindow；label/thinkingLevel/modelId/queue/commands 条目零触碰） | 豁免 |
| M packages/runtime/src/interfaces.ts | W10 超清单（编译连带） | 豁免，裁决① |
| M packages/runtime/src/services/session/session-internal.ts | W10 超清单（注释连带） | 豁免，裁决① |
| M packages/runtime/test/{session-service,session-service-w3,model-service}.test.ts | W10 清单（测试适配） | 豁免 |
| ?? src/__tests__/equivalence/w10-usage-switchmodel-race.test.ts | W10 交付物 3 | 豁免 |
| ?? src/__tests__/equivalence/{broadcast-getstate,chaos}.test.ts | W22 领地 | 并行豁免 |
| M packages/runtime/package.json | 仅 `test:equivalence` 别名一行，无 W10 夹带 | W22 豁免 |

禁改清单核对：replicated-state.ts 本体、event-adapter、extensions/ 均零变更。**越界 = 0**。

## 2. 通过命令实跑

1. `grep -n "setInputTokens\|s\.inputTokens =" session-service.ts` → **0 命中**（exit 1）。全仓 `setInputTokens` 仅剩 4 处注释提及、0 处代码引用。
2. `grep -n "缓存写入先于" session-service.ts` → **0 命中**（旧时序约定注释已改写为 W10 owner 结构说明，session-service.ts L506-518）。
3. `cd packages/runtime && pnpm typecheck` → **exit 0**。
4. `pnpm test` → **272 文件 / 3119 用例全绿**（Duration 35.64s），与 builder 自报一致；本次无偶发竞态（裁决③）。W10 竞态文件单跑 3/3 绿。
5. `grep -n "inputTokens" session-service.ts` 逐处归属核对：全部非注释命中均为读点/派生/初始化/广播 payload/函数参数，抽查 4 处——L902（getInputTokens 读实例快照）、L1130（toSummary.tokenCount 派生 `usage.get()?.inputTokens ?? s.tokenCount`）、L1428（switchModel 重算读快照）、L1530（usage config fetch merge，唯一数据写路径）。`grep "\.inputTokens = \|\.tokenCount = "` 全仓 src+renderer **0 直写**（L1296 为对象字面量恒 0 基线初始化，非赋值语句）。

## 3. 条款对照（w10-acceptance.md 交付物 1-4）

| 条款 | 结果 |
|---|---|
| 1. 五写点处置 | **通过**。turn-usage（event-interpreter.ts:295）/ turn-end（:468）/ compaction 估算（:778-780）三路径经 onContextUpdate → index.ts:277 → `applyContextUpdate` 内仅 `usage.markDirty()`；restore 拉取（fetchContext，session-service.ts L1521-1530）仅 markDirty，旧 setInputTokens 回写已删；switchModel 重算（broadcastSessionState L1426-1431）读 `getInputTokens`（实例快照）+ resolver 新窗口，口径 `recomputeUsageWithWindow`（config L255-276，公式与 pi getContextUsage 同构：round + clamp 100）。外部 inputTokens 写点 4→0 |
| 2. 字段直接外部写删除 | **通过**。getInputTokens / getUsagePercent（L902 / L1001-1004 读快照 percent 投影）/ toSummary.tokenCount（L1130）全改实例快照派生；`computeUsage` 私有方法整体删除（MAX_PERCENT 常量连带删除） |
| 3. 竞态回归用例 | **通过**（3 用例 fake timers，见 §4） |
| 4. 时序约定注释改写 | **通过**（session-service.ts 内 grep 零残留）；**例外发现见 §6-1（index.ts 残留）** |

## 4. 真实性抽查

- **竞态用例断言手法**：乱序 1（switchModel 先/context.update 后）断言两态——防抖前即时广播 `session.state_changed` payload（快照 tokens × resolver 新窗口 = 20%）+ 防抖到点（`advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 1)`）后 `usage.get()` **toEqual** `authoritativeProjection()`（直接调 mock `getSessionStats` 计算的权威投影），且 getUsagePercent/getInputTokens 同值。乱序 2（反序）终态 toEqual 同一权威投影 + 字面值。快速连切 3 模型（B→C→B，每步间隔 < 防抖窗口）终态 = 最后模型权威快照 + `isDirty() === false` + modelId 实例收敛 `{ modelId: 'p/model-b' }`。「结构自愈不依赖顺序」由两用例终态同基准（authoritativeProjection）实质承载，非顺序敏感断言。
- **pi 侧核实（builder 说法属实）**：pi-mono `coding-agent/src/core/agent-session.ts:3007-3050` `getContextUsage()` 读 `this.model` 的 `contextWindow`，`percent = (estimate.tokens / contextWindow) * 100`；`setModel`（:1478）更新 `this.model`——setModel 后 get_session_stats 天然按新窗口报 percent，与 xyz 侧 recomputeUsageWithWindow 同公式收敛。
- **两态断言（验收动作 4-3）**：乱序 1 同时断言「即时值可用」（防抖前 state_changed payload）与「最终收敛」（防抖到点 == 权威投影），满足。

## 5. 行为对抗记录

1. **红性验证**：备份 session-service.ts（sha256 `00566123...`）→ 在 applyContextUpdate `if (!session) return` 后注入一行 `if (typeof _totalTokens === 'number') session.tokenCount = _totalTokens` → `vitest run` w3/session-service/w10-race 三文件：**1 failed**（session-service-w3「tokenCount 不再被事件直写」`AssertionError: expected 30000 to be +0`）——测试真实防御直写回归，非摆设。**字节还原**（cp 回 + shasum 与注入前完全一致 `00566123bb96893a64a9c097033547bb9e684c3e9f40fe254218bf83abdb7d86`），w3 复跑 8/8 绿，git diff 恢复 83+/68-。
2. **tokenCount 语义回归**：builder「数值语义不变」的关键声称 = 事件链路 totalTokens 与 inputTokens 同值。核实 `infra/pi/event-adapter.ts:290-291`：`inputTokens: usage?.totalTokens, totalTokens: usage?.totalTokens ?? 0` **同源直出**；compaction 路径 interpreter:779-780 双取 `estimatedTokensAfter` 同值。旧实现写 totalTokens ≡ 新实现派生 inputTokens（事件链路恒等）；权威快照侧 pi getContextUsage.tokens 与 usage.totalTokens 同为 context 占用口径（adapter L288 注释，calculateContextTokens 同源）。语义无回归，声称成立。
3. **recomputeUsageWithWindow 口径**：见 §4 两态断言；即时广播值（快照 tokens × resolver 新窗口）与 pi 权威值同公式，防抖到点收敛一致（mock 中两值相等因公式同构，非巧合断言）。

## 6. 发现（均 minor，不阻塞 PASS）

1. **[minor] 过时注释残留 index.ts:273-276**：onContextUpdate 处注释仍描述旧行为（「inputTokens 回写 + tokenCount 写入」「W3：totalTokens 写入 session.tokenCount」「inputTokens 回写打通数据源」）——W10 后 applyContextUpdate 已不回写。验收条款 4 字面只查 session-service.ts（通过），但与「注释与结构同步，不留过时纪律注释」精神不符。建议下个 wave 顺带清理。
2. **[minor] 超清单改动 × 2**：session-service.ts:1178/1198 新增 `// eslint-disable-next-line taste/no-silent-catch`（notifySessionCreated/onSessionDestroyed 的存量 catch）。与项目规范「禁 eslint-disable-next-line 静默；规则误报应修正规则本体」存在张力（catch 内已有 console.error，疑似规则误报）。与 W10 主题无关，文件在清单内但内容超出。移交主 agent 裁决是否要求 builder 改为修正规则本体。

## 7. 三项裁决

1. **3 个超清单文件连带：合理**。interfaces.ts 删 `setInputTokens` 声明是编译必需（ISessionService mock 按接口构造，model-service.test.ts 同步删 mock 行）；session-internal.ts 纯注释同步（applyContextUpdate 语义描述）；测试 3 文件为断言 API 删除的机械适配（直写断言→快照派生断言，U-setInput-3 新增防直写用例）。无夹带。
2. **tokenCount 恒 0 派生基线：无 UI 读 0 风险**。全仓 grep：renderer 正式代码 **零消费** tokenCount（仅 api/mock/data.ts mock 数据与 shared/session.ts:37 类型必填）；runtime 唯一出口 toSummary L1130 已改实例派生优先（`?? s.tokenCount` 仅磁盘 session fallback，session-scanner.ts:82 本就置 0）。
3. **真实 pi 偶发竞态归因：本次未复现**。全量 3119 用例一次全绿（无竞态红），无需归因；W22 语料 fixture 竞态说法无反证，维持 builder/并行豁免记录。

## 8. 验收环境

- 2026-08-19 09:2x（local），pnpm workspace，packages/runtime@0.6.0。
- verifier 全程零 git 写操作；除报告本体与红性验证的字节级还原注入外零文件修改。

## 9. 并行时序记录（验收期间）

- 验收进行中，并行 W22 agent 提交 `331beb627`（broadcast-getstate + chaos equivalence + package.json test:equivalence 别名，W22 领地，任务豁免范围）。该 commit 零触碰 W10 文件——W10 全部 7 个修改文件 shasum 验收前后一致（session-service.ts = `00566123...`，与红性验证还原值相同）。
- 全量测试（272/3119 绿）跑于该 commit 落地前的工作区（内容等同：W22 文件当时已在工作区且被 vitest 收集），结论不受影响。
