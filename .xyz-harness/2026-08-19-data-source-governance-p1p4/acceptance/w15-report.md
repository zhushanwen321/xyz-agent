# W15 验收报告：scannedToSummary 空值守卫（对抗验收）

**结论：PASS**（9 检查点全过；两裁决均支持 builder 判定；4 条 minor 观察项不阻塞）

> verifier 独立实测于 2026-08-19。基线 9382ccb57，HEAD 3ebd8b27c，工作区 W15 改动未提交（6 文件）。
> W24 builder 在途文件（taste-lint/ 4 个）与本验收无交集，未评判。

## 1. 防篡改 —— PASS

```
git diff 9382ccb57 -- .xyz-harness/.../w15-acceptance.md  → 0 行
git diff 9382ccb57 -- docs/architecture/data-source-governance-plan.md → 0 行
git status 未列出 ledger.md（工作区未改；harness 目录其余 diff 均来自其他 wave 已提交记录）
```

## 2. 范围 —— PASS

工作区恰好 W15 6 文件 + W24 4 文件（W24 领地零触碰）：

- M `packages/shared/src/session.ts`（SessionDataSource 类型 + SessionSummary.source）
- M `packages/shared/src/protocol.ts`（SessionViewSnapshot.source + D1b 注释更新）
- M `packages/runtime/src/services/session/session-scanner.ts`（scannedToSummary + source:'scan' + 注释）
- M `packages/core/src/domain/session/store.ts`（守卫 + docstring，21+/6-）
- M `packages/core/src/domain/session/__tests__/store.test.ts`（TC-W15-1..5）
- ?? `packages/runtime/src/__tests__/session-scanner-source.test.ts`（3 用例）

W13 其余逻辑零重构：store.ts diff 仅 mergeViewSnapshot 守卫两行 + isScan 一行 + docstring；`git diff HEAD -- packages/core/src/domain/chat/useChat.ts` = 0。HEAD 中 `function setGroups|function updateSessionState` 0 命中（W13 已收敛，非本 wave 改动）。

## 3. 守卫读码 —— PASS

`packages/core/src/domain/session/store.ts` L103-118：

- L106 `const isScan = snapshot.source === 'scan'` —— 唯一分流开关
- label/status/thinkingLevel 三字段无守卫条件（owner 权威空 `''` 照常覆盖，守卫未扩大化）
- modelId：`snapshot.modelId !== undefined && !(isScan && snapshot.modelId === '' && target.modelId !== '')` —— owner 快照（isScan=false）短路回原 D1b 无条件覆盖；扫描占位仅在 target 有非空真值时跳过；target 同为占位（''）时走覆盖（等值无害）
- tokenCount 同构（占位 0）

## 4. scanner 读码 —— PASS

`session-scanner.ts` L79-86：`modelId: '', tokenCount: 0, source: 'scan'` 三者同产出处，注释显式化占位语义。owner 侧 `session-service.ts` toSummary（L1221-1240）不标 source（缺省 undefined）。两 DTO 同名字段同用 `SessionDataSource`（`shared/src/session.ts:30`）。全仓 `source: 'scan'` 产出点唯一（scanner L86）。

## 5. 用例真实性 —— PASS

core 5 用例（acceptance 要求 ≥4，覆盖其 4 条意图）：

- TC-W15-1：真值 `provider/m-true` 遭 scan 占位 `''` → 保留（acceptance 用例 1）
- TC-W15-2：真值 512 遭 scan 占位 0（含双字段同帧）→ 保留（用例 2）
- TC-W15-3：owner `label:''` 覆盖旧名 + owner `modelId:''/tokenCount:0` 正常覆盖（用例 3 等价形态 + 防守卫扩大化，见裁决 8a）
- TC-W15-4：owner modelId 真值正常覆盖（用例 4）
- TC-W15-5：守卫边界（scan 非守卫字段照常 / scan 非空真值照常覆盖 / target 同占位等值）

runtime 3 用例：scan 条目带标记+占位值 / 活跃条目 source undefined / 条目数回归（6 文件=5 scan+1 active 去重，f6 取实例真值版本）。

## 6. 红性验证 —— PASS（两组，还原 diff 空）

**a. 删守卫**（modelId/tokenCount 两行恢复无条件 D1b 覆盖）：

```
Tests  3 failed | 11 passed (14)
FAIL TC-W15-1 / TC-W15-2 / TC-W15-5（全为守卫路径）；TC-W15-3/4 与既有 TC-1..6 全绿
```

**b. 守卫扩大化**（label 守卫**脱离来源判定**：`!(snapshot.label === '' && target.label !== '')`）：

```
Tests  1 failed | 13 passed (14)
FAIL TC-W15-3（owner label:'' 被错误拦截）；其余全绿
```

注：扩大化的正确形态是守卫脱离 `isScan`——若仅在 isScan 分流内给 label 加守卫，owner 快照天然不受影响（14 全绿不红），TC-W15-3 防的正是来源分流被移除的扩大化。

**还原**：`diff /tmp/w15-store-backup.ts store.ts` 字节级为空；还原后 store.test.ts 14/14 绿；`git diff --stat` 回到 builder 原状（21+/6-）。未用 git checkout/restore，未 add/commit。

## 7. 回归 —— PASS

- core：typecheck 0 err；`Tests 999 passed | 6 todo (1005)`，77 文件全绿
- runtime：typecheck 0 err；首跑 `5 failed | 3153 passed | 5 skipped (3163)`——失败 6 文件全部位于 `src/__tests__/equivalence/`（broadcast-getstate / chaos / live-reload / pi-protocol-contract / scalar-state-invalidation / usage-queue-commands-invalidation），均真实 pi 子进程用例、7s 超时特征；**隔离复跑 6 文件 23/23 全过** → 并发资源竞争 flaky，与 W15 无关（builder 自报首跑 3 个 flaky，本次 6 个，同性质）。session-scanner-source.test.ts 全量跑中绿。

## 8. 两裁决

### 8a. 「owner 快照 sessionName=undefined 必须覆盖旧名」的等价映射（{label:''}）—— 成立

语义链独立核对：

1. `SessionViewSnapshot.label?: string` 的 undefined = 快照未涉及、保留现值——W13 TC-4 逐行锁定（store.test.ts L90-111），乐观更新形态（只带部分字段）依赖此语义；
2. owner 侧 label 恒为 string（`session-service.ts` L1222 `label: s.label`，types.ts L38 非可选）——owner 快照的 label wire 形态只有真名或 `''`，不存在 undefined；
3. pi 层 sessionName 为空/undefined 时 useChat.ts L253-256 有 guard 直接跳过（「防 pi 推空名覆盖用户手动 rename 的值」）——undefined 根本不进 applySnapshot；
4. owner 权威空（用户清名）的可达路径是 rename 乐观更新 `applySnapshot(id, { label: '' })`（use-session.ts L289 / useSidebar.ts L262）。

结论：acceptance 用例 3 字面「sessionName=undefined 覆盖」若照搬到快照层实现，与 TC-4/乐观更新形态直接冲突、破坏 D1b。builder 按 `{label:''}` 等价落断言（TC-W15-3）正确。**上报主 agent：建议后续修订 acceptance 该句措辞**（验收权威禁改，本报告仅记录落差：plan §4 L504 的表述「sessionName 的 undefined 是权威空值必须覆盖」中 sessionName 是 pi 层概念，映射到快照层即 label:''）。

### 8b. usagePercent/inputTokens/contextLimit 组件本地态 —— 可接受（观察项定性）

ContextCapacityPopover.vue（renderer/src/components/panel/）L180 本地 `stats` ref + L211-220 `useSessionEvents` 订阅 `context.update`/`session.state_changed`（D9 映射 used←inputTokens / total←contextLimit / percent←usagePercent），sessionId prop 变化重订。判定：显示态数据、无持久化需求、本地 ref 随组件实例生命周期不进 store、无跨 session 数据污染——不绕范式（ADR-0049 管的是「持有 per-session 状态的 composable」，组件内嵌订阅 + props 驱动重订符合隔离要求）。遗留观察项见下（sessionId 切换不清 stats）。

## 9. W13 移交 5 字段落盘路径 —— PASS（grep 实测）

| 字段 | 落点 | 证据 |
|---|---|---|
| pendingMessageCount | core chat store | `chat/store.ts:387`（W14 深度对账注释） |
| commands | command-store | `core/src/domain/new-task-search/command-store.ts` L143 `commandsBySession` Map（per-session 隔离） |
| usagePercent | 组件本地态 | ContextCapacityPopover.vue L216-220 |
| inputTokens | 组件本地态 | 同上 |
| contextLimit | 组件本地态 | 同上 |

## minor 观察项（不阻塞）

1. **SessionDataSource 未随 barrel 导出**：`packages/shared/src/index.ts` 是显式列举式导出，新增的 `SessionDataSource` 不在列（SessionViewSnapshot 在）。当前无编译缺口（typecheck 全绿、无外部 import 需求），但后续包外消费该类型名时需补一行导出。
2. **整表替换路径不经守卫**：store.ts L80-83 整表分支直接 `groups.value = idOrList.groups`。已退出实例的 session 在 config.sessions 整表广播中以 scan 占位形态（modelId:''）整表替换 store 里的旧真值——「死 session 真值回退」窗口在整表路径仍存在。W15 交付范围是 applySnapshot 合并策略（单条 merge 路径，plan L499），此为 W13 D1b 整表设计的既有行为，记录为后续 wave 关注。
3. **ContextCapacityPopover sessionId 切换不清 stats**：切换 session 后旧 session 用量残留显示，直至新 session 首次广播到达。UI 残留级（无数据外溢），建议后续补 watch(sessionId) 清零。
4. **acceptance 交付物 3 的字面与落位差异**：原「store.ts:70 setGroups 踩坑注释」在基线 9382ccb57 挂于 updateSessionState docstring（L69-70），已随 W13 重构删除（HEAD 中该函数 0 命中）；builder 在 applySnapshot/mergeViewSnapshot docstring 等价落位历史叙事（「三入口时代 setGroups 整表覆盖曾把…真值抹回磁盘扫描的空串」）——等价成立，与自报一致。
5. **runtime equivalence flaky 基线**：本次首跑 6 文件失败（builder 报 3），隔离复跑全过。真实 pi 子进程用例对并发资源敏感，与 W15 无关。
