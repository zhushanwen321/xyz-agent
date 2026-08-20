# W13 验收报告：session store 单一 applySnapshot 入口 + view-ready DTO

**结论：PASS**（10 检查点全部通过；3 冲突裁决均支持 builder 处置；2 组红性实验均红且工作区已还原。minor 观察项 5 条，不阻塞）

- 验收对象：builder 交付（工作区在途，基线 996063a6f）
- 验收人：W13 对抗 verifier（独立于 builder）
- 日期：2026-08-19
- 权威依据：`acceptance/w13-acceptance.md` + `docs/architecture/data-source-governance-plan.md` §4 W13（L438-463）

---

## 检查点 1：防篡改 —— PASS

| 命令 | 结果 |
|------|------|
| `git log --oneline --all -- .xyz-harness/.../w13-acceptance.md` | 仅 1 条：`a87831c3a chore(harness): pre-stage W13/W14 baselines`（builder 派发前的预置提交，非 builder 产出） |
| `git diff HEAD -- .xyz-harness/.../w13-acceptance.md` | 0 行（工作区未改） |
| `git diff 996063a6f -- docs/architecture/data-source-governance-plan.md` | 0 行；`git log 996063a6f..HEAD -- <plan>` = 0 提交（§4 W13 节 L438-463 原文在位） |
| `git diff HEAD --stat -- .xyz-harness/.../` | 空（登记表 ledger.md 未被 builder 改；目录内唯一 untracked = w14-report.md，属并行 W14 verifier） |

## 检查点 2：范围 + 交叉领地 —— PASS

W13 源文件 11 个，与 git status 逐一对应：shared/protocol.ts、shared/index.ts（W13 部分 = SessionViewSnapshot 导出）、core session/store.ts、session/use-session.ts、chat/useChat.ts、chat/effects/registry.ts（W13 部分 = 3 行注释）、composer/model-thinking.ts（注释）、renderer useSidebar.ts / useModel.ts / useForkBranchNotify.ts（注释）、taste-lint/rules/no-non-owner-store-mutation.mjs。测试 38 文件 = core session 2 + chat useChat.test.ts 1 + renderer 35（38 total renderer 改动 − 3 源文件）。与自报数字一致。

**useChat.ts 逐 hunk（6 hunk，全部 W13 最小 diff）**：① import 加 SessionViewSnapshot 类型；② SessionStoreLike 接口两方法签名 → `applySnapshot(id, snapshot)`；③ 1 行注释；④ renamed handler `updateLabel(sid, name)` → `applySnapshot(sid, { label: name })`；⑤ state_changed handler `updateSessionState` → `applySnapshot`（保留 `!== undefined` 条件展开，语义不变）；⑥ thinkingLevelSet handler 同理。**未触碰** W14 领地（chat/store.ts、effect-types.ts、registry L549 起 queue_update effect）——`git diff -- packages/core/src/domain/chat/store.ts packages/core/src/domain/chat/effect-types.ts | grep -c "applySnapshot|updateLabel|updateSessionState|setGroups|SessionViewSnapshot"` = 0（纯 W14，无 W13 污染）。

**registry.ts 逐 hunk**：W13 部分 = 恰 3 行注释替换（L10 头注、L20 头注、L617 applyMessageEvent 注释，均为 updateLabel/updateSessionState 字样 → applySnapshot）；其余全部 hunk（L81-90 countDrained 注释、L549-585 queue_update effect 的 drainN/reconcilePending 改写）属 W14 领地，与 W13 关键词零交集。自报「仅 3 行注释」属实。

**chat/useChat.test.ts**（14 行改动）：mock `updateLabel/updateSessionState` 两 fn → 单 `applySnapshot` fn + 3 处断言改写，0 个 W14 关键词（drainN/reconcilePending/pendingMessageCount 命中 0）——纯 W13 因果必需（接口变了 mock 必须跟），属 acceptance 交付物 4「对应测试更新」。

renderer 测试抽样（session-renamed-sync.test.ts 等）：机械播种改写（setGroups([...]) → applySnapshot({groups})），无逻辑改动。

## 检查点 3：applySnapshot 结构读码 —— PASS

`packages/core/src/domain/session/store.ts` L71-84：两个重载——`(id: string, snapshot: SessionViewSnapshot)` 单 session 形态（未知 id 静默跳过，L82）+ `(listSnapshot: { groups: SessionGroup[] })` 整表形态（直接替换 groups 真源，L78）。

`mergeViewSnapshot` L96-103：D1b 语义正确——5 个托管字段（label/status/modelId/thinkingLevel/tokenCount）均以 `!== undefined` 判断，**显式空值（''/0/false）覆盖旧真值**，与 patch 合并（falsy 跳过）形成语义区分（红性实验 a 证实该区分被测试锁定）。

W15 守卫挂点两处注释在位且锚定 mergeViewSnapshot：L68-69（applySnapshot docstring「[W15 挂点] …将接入 mergeViewSnapshot 合并策略」）+ L93-94（mergeViewSnapshot docstring「[W15 挂点] 磁盘占位值守卫的唯一接入位置」）。

三 mutation（updateLabel/updateSessionState/setGroups）已删（diff 确认删除块 + 返回表移除）。

## 检查点 4：DTO 读码 —— PASS

`packages/shared/src/protocol.ts` L1523-1537 `SessionViewSnapshot`：10 字段全 optional——label/status/modelId/thinkingLevel/usagePercent/inputTokens/contextLimit/pendingMessageCount/commands/tokenCount。对照 W12 后 runtime publish payload：

- `session.state_changed`（session-service.ts L1569-1576 payload）：sessionId/modelId/thinkingLevel?/usagePercent/inputTokens/contextLimit —— DTO 覆盖其中 5 个 view 字段，形状一致
- `session.commands`（L1548）：`{ sessionId, commands }` —— DTO.commands 直接复用 `ServerMessageMap['session.commands']['commands']` payload 形状（类型引用，非复制）
- label ← session.renamed、pendingMessageCount ← message.queue_update、tokenCount ← SessionSummary：docstring 逐字段标注来源

renderer 零派生：消费方全部改为直接投喂快照（useChat/useSidebar/useModel 的 diff 均为形态转换无 merge/normalize 逻辑）；mergeViewSnapshot 落盘 5 字段、usagePercent/pendingMessageCount/commands 不进 session store 的取舍有 docstring 说明（归 W15+ 收敛对象，见 minor-1）。

## 检查点 5：grep 清零 —— PASS

```
grep -n "updateLabel\|updateSessionState\|setGroups" packages/core/src/domain/session/store.ts   → 0 命中（exit 1）
grep -cn "applySnapshot" packages/core/src/domain/session/store.ts                              → 5 命中（≥1 达标）
grep -rn "updateLabel\|updateSessionState\|setGroups" packages/renderer/src packages/core/src \
  --include="*.ts" --include="*.vue" | grep -v __tests__                                        → 0 命中（exit 1）
```
renderer `stores/session.ts` 薄壳：`git diff` 空 + 文件 14 行（defineStore 包 createSessionStore），零改动。

## 检查点 6：R2 联动 + lint —— PASS

`taste-lint/rules/no-non-owner-store-mutation.mjs` diff：WATCHED_MUTATIONS 三键收敛为单键 `applySnapshot: '#1/#2 ——W13 起唯一写入口'`；PERMITTED_FILES 四文件不变；头注同步改写。无规则弱化（受管面等价迁移）。

`pnpm run lint` 全仓：1 error 462 warning。唯一 error = `packages/runtime/src/services/session/subagent-extractor.ts:47 'SubagentRecordEntryData' is defined but never used`——**归因 W18 在途已证**：该标识符是 W18 diff 新增的本地 interface（`git diff -- <该文件>` 中 `+interface SubagentRecordEntryData` 在 +58 行），基线 996063a6f 同位置无此行，与 W13 文件零关联。W13 范围文件单独 eslint（session 域 + useChat + registry + useSidebar + useModel + useForkBranchNotify + protocol.ts）：0 error 0 warning。

## 检查点 7：TC-4a/4b/4c 真实性 —— PASS

`packages/core/src/domain/session/__tests__/store.test.ts` L113-167，逐行读断言：

- **TC-4a**（L113）：多字段整字段覆盖一次到位（modelId+thinkingLevel 同帧）+ 未涉及字段保留（label/tokenCount 不变）+ status 同路径（'dead'）
- **TC-4b**（L132）：**本 wave 语义核心**——显式 `{ modelId: '', thinkingLevel: '', tokenCount: 0 }` 覆盖旧真值 'm1'/'high'/100，断言 after 三字段 === ''/''/0；注释明确「与旧 patch 语义的差异点即在此」。红性实验 a 证实该用例在 falsy 跳过语义下必红
- **TC-4c**（L146）：rename 乐观更新（只带 label）→ config.sessions 整表回流收敛（乐观名→权威名）→ switchModel 单字段乐观 → state_changed 同值收敛（幂等双写断言）

三条均断言 store 实际状态（非 mock 调用计数），语义真实。

## 检查点 8：红性验证 —— PASS（两组均红，还原后指纹一致）

实验前记录 `git diff -- store.ts | shasum` = `f7c591b85ebbe538f4cc0c368d5f939c156473d5`。

**a. mergeViewSnapshot 改回 patch 语义**（undefined 判断 → falsy 判断，python 精确替换 5 行）：`npx vitest run src/domain/session/__tests__/store.test.ts` → `1 failed | 8 passed`，失败用例恰为 **TC-4b**（其余 8 条含 TC-4a/4c 全绿）——D1b 与 patch 语义区分被测试真实锁定。还原后 shasum 复测一致。

**b. 恢复直呼**：在非许可文件 GitPanel.vue（含 `useSessionStore()`）注入 `sessionStore.applySnapshot('probe', {...})` → eslint 报 `taste/no-non-owner-store-mutation error`（错误文案含「W13 起唯一写入口」受管条目）；换注 `sessionStore.updateLabel('probe','probe')` → 检查点 5 同款 grep 命中该行。R2 规则实弹拦截 + grep 兜底双双验证。还原后 `cmp` 与备份逐字节一致、`git status` 该文件无条目。

终态：`git stash list` = 0；两探针文件与验收开始时状态一致（W14/W18 在途文件未被本验收触碰）。

## 检查点 9：回归 —— PASS

| 命令 | 结果 |
|------|------|
| `cd packages/core && pnpm typecheck` | 0 错 |
| `cd packages/core && pnpm test` | **77 files / 994 passed + 6 todo**（含 W14 pending-drain-fifo.test.ts 5 用例——全绿） |
| `cd packages/renderer && pnpm typecheck` | 0 错 |
| `cd packages/renderer && pnpm test` | **293 files passed / 3054 passed + 3 skipped**（1 skipped 文件） |
| `cd packages/shared && pnpm typecheck` | 0 错 |

ADR-0049：W13 触碰的 5 个 composable/store 文件均不使用 useSessionScopedState（grep 全仓使用处核对），diff 中无实例级状态新增、无 watch(sessionId) 手动清空——分区范式未破坏。useChat state_changed handler 保留条件展开（thinkingLevel undefined 不覆盖），与旧 updateSessionState 行为等价，无隐性退化。

## 检查点 10：三冲突裁决

**冲突 1（chat 域最小 diff）——裁决：builder 处置正确，PLAN 为准。** 依据链：acceptance 自身存在内部冲突——禁改清单写「chat 域（W21 已交付）」，但交付物 3 的 grep 命令显式覆盖 `packages/core/src`（useChat.ts 三处直呼必被定位）且要求「全部调用点逐一改」；按 acceptance 头部「冲突以 plan 为准」，plan §4 W13 步骤 1（L453）明文「全部调用点…改走 applySnapshot」。且禁改清单的 chat 条目语义应读作「派生逻辑上移不越界进 chat 域」（关键锁定第 3 条原文），而非禁止改写 chat 域内的 session-store 消费点——旁证：编排方自己正把 W14 派进 chat 域。**最小 diff 合规已实证**：useChat.ts 6 hunk 全部机械改写 + registry.ts W13 部分恰 3 行注释；chat/store.ts、effect-types.ts、registry L549+ queue_update effect（W14 区）0 个 W13 关键词，零重叠成立。

**冲突 2（lint error 归因）——裁决：归因成立。** 见检查点 6：error 位于 W18 在途 diff 新增的本地 interface，基线无此行，W13 范围文件 lint 0 问题。

**冲突 3（单入口 vs 乐观更新/ADR-0049）——裁决：无冲突，结论成立。** 乐观更新保留为 applySnapshot 本地入参形态（useModel.switchModel/setThinkingLevel、use-session/useSidebar.renameSession 四处实证），权威确认经广播回流同入口幂等（TC-4c 断言）；ADR-0049 见检查点 9。

---

## minor 观察项（不阻塞，供后续 wave 参考）

1. **mergeViewSnapshot 只落 5/10 字段**：usagePercent/inputTokens/contextLimit/pendingMessageCount/commands 不进 session store（docstring 声明归各自消费 store，W15+ 收敛对象）。与 acceptance「DTO 字段定义」不冲突（DTO 是并集），但 W15 接手时需确认这些字段的落盘点不绕过 applySnapshot 范式。
2. **useChat state_changed handler 丢弃 usagePercent 三字段**（payload cast 只取 sessionId/modelId/thinkingLevel）——与旧代码行为一致非本 wave 退化，属 W15 收敛范围。
3. **shared/src/index.ts 同文件混含 W18 改动**（SUBAGENT_RECORD_CUSTOM_TYPE/WORKFLOW_RECORD_CUSTOM_TYPE 导出）——按全局「文件级颗粒度」提交政策可整体提交，但 W13/W18 若分批 commit 需主 agent 拆分处置。
4. **session store 仍有 markDead/revive/updateProjectId/appendSession/removeFromList 等写方法**——acceptance 仅要求三入口收敛，此为 W24（R2 收紧）的后续范围，非遗漏。
5. **mergeViewSnapshot 行长**：L96 函数签名行超 100 字符（`function mergeViewSnapshot(target: SessionSummary, snapshot: SessionViewSnapshot | undefined): void {`）——lint 未拦（规则未启用行长），纯风格观察。

## 验收通过命令存档

- 通过命令 1（grep 双检 + 双包 typecheck/test）：见检查点 5、9，全过
- 通过命令 2（R2 联动 lint）：见检查点 6，归因后 W13 范围 0 问题
- 通过命令 3（单测层合并规则用例）：TC-4a/4b/4c 在位且红性可证；行为级（断连重连侧栏一致）按 acceptance 留 P2 gate
