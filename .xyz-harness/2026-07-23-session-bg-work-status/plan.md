# 实施计划：session 状态反映 background work

> 目标：主 agent 对话已结束但 background subagent/workflow 还在跑时，session 状态显示「进行中」（working，转菊花）。
> 根因两层：①数据层 `subagent/workflow` 的 `records` 是全局单例（ADR-0036 否决的 watch 清理派）；②派生层 `deriveStatus` 优先级链不含 background work。
> 路径根：`/Users/zhushanwen/Code/xyz-agent-workspace/fix-new-worktree-folder/`（下记 `$R`）。仅改前端 `packages/renderer/`。

## 关键架构约束（已核实）

1. **`useSessionScopedState` 不能在 store 内用**——它是 composable 层工厂（需 `Ref<string|null>` + effect scope），store 内无 focusedSessionId ref、不在 setup scope。Step 1/2 必须像 `command.ts`（`commandsBySession: ref<Map<string, SessionCommand[]>>`）/`tasks.ts` 那样**手写 `ref<Map<sid, T>>`**。
2. **store 互不 import（R2 铁律）**——`records` getter 不能读 session store 的 activeId。采用「调用方注入 sid」范式（`recordsOf(sid)`，对齐 `command.ts` 的 `commandsOf(sessionId)`）。
3. **`useSessionDerivations` 是加 `hasBackgroundWork` 的正确位置**——features 层 composable，已同时 import chat+session store，加 subagent+workflow store 是自然延伸。
4. **working 优先级在 streaming 之后**（修正 planner 原稿矛盾）：`isGenerating→streaming` 分支必须先于 `hasBackgroundWork→working`，否则主 turn 流式时被 working 抢占。最终链：`waiting > retrying > compacting > streaming > working > pending > error > stopped > done`。

---

## Step 1 — subagent store records 改 per-session Map 分区

**文件**：`$R/packages/renderer/src/stores/subagent.ts`
**范式参考**：`stores/command.ts`（`commandsBySession` L87 / `getCommands` L123 / `commandsOf` L133 / `applyCommands` L162 / `clearCommands` L180）

**改动**：
1. `records: ref<SubagentRecord[]>` → `recordsBySession: ref<Map<string, SubagentRecord[]>>(new Map())`。
2. **删除无参 `records` getter**（铁律：store 拿不到 focusedSessionId）。新增：
   - `recordsOf(sid): ComputedRef<SubagentRecord[]>`（响应式视图，`computed(() => recordsBySession.value.get(sid) ?? [])`，对齐 `commandsOf`）
   - `getRecordsBySession(sid): SubagentRecord[]`（非响应式读，对齐 `getCommands`）
   - `hasRunning(sid): boolean`（该 sid 分区存在 `status==='running'` 即 true）
   - `applyRecords(sid, list)`（不可变写：`recordsBySession.value = new Map(recordsBySession.value).set(sid, list)`）
   - `clearSession(sid)`（has 守卫 + `new Map → delete → 赋值`，对齐 `clearCommands`）
3. **`isRunning(mainSessionId, subagentId)`**（修正 planner 原稿「全扫」）：签名加 `mainSessionId` 参数，直接读该 sid 分区查 subagentId。调用方 `MessageStream.vue:196` 补传 mainSessionId（panel 绑定的 session，已有）。
4. `loadSubagents(sessionId)`：`records.value = await ...` → `applyRecords(sessionId, await ...)`。空 sid 分支：`if(!sessionId) return`（不写分区）。
5. `subscribeSubagentPush(sid)` handler：`records.value = payload.subagents` → `applyRecords(payload.sessionId ?? sid, payload.subagents)`。**优先用帧 payload 的 sessionId**（AGENTS.md 规则 #7 推送链路 session 隔离延伸，非焦点 session 终态推送也写对应分区）；payload 无 sessionId 时回落闭包 sid。
6. `getCurrentSubagent(panelId, mainSessionId)`：签名加 mainSessionId，从该 sid 分区查 viewing subagentId 对应 record。调用方补传（panel 绑定 session 已知）。
7. `selectSubagent`/`cancelSubagent`：内部 `records.value.find/.map` 改为操作对应 mainSessionId 分区。`cancelSubagent` 乐观更新：先 `const prev = getRecordsBySession(sessionId)`，失败回滚 `applyRecords(sessionId, prev)`。
8. `clearSubagents()`（无参全清）保留：清 `recordsBySession` + per-panel viewing/streaming。仅全局重置场景用；deleteSession 主路径走 `clearSession(sid)`。

**依赖**：无（起始）。
**验证**：`cd $R/packages/renderer && grep -rn "subagentStore\.records[^O]" src` 应无残留无参 `.records` 引用；`npx vitest run src/__tests__/stores`（若有 subagent store 测试）。

---

## Step 2 — workflow store records 改 per-session Map 分区

**文件**：`$R/packages/renderer/src/stores/workflow.ts`（与 Step 1 对称）

**改动**：
1. `records: ref<WorkflowRunRecord[]>` → `recordsBySession: ref<Map<string, WorkflowRunRecord[]>>(new Map())`。
2. 新增：`recordsOf(sid)` / `getRecordsBySession(sid)` / `hasRunningOrPaused(sid)`（`status==='running'||'paused'`）/ `applyRecords(sid, list)` / `clearSession(sid)`。
3. **删除 `workflowCount()` 无参版**——Sidebar 改用 `recordsOf(sid).length`。
4. `loadWorkflows(sessionId)`：`records.value = await ...` → `applyRecords(sessionId, await ...)`；空 sid 分支 `if(!sessionId) return`。
5. `subscribeWorkflowPush(sid)` + running 重试 timer 的 `loadWorkflows(sid)`：经 Step 4 已写分区，无需额外改。
6. `getCurrentWorkflow(panelId, mainSessionId)`：签名加 mainSessionId，从该 sid 分区查。
7. `clearWorkflows()` 无参全清保留（清 recordsBySession + viewing Map + mainSessionAgentCalls）；deleteSession 走 `clearSession(sid)` + 既有 `clearAgentCallMapping(sid)`。

**依赖**：Step 1（范式对齐）。
**验证**：`grep -rn "workflowStore\.records[^O]\|workflowStore\.workflowCount\b" src` 无残留无参调用。

---

## Step 3 — 两个 ListSync composable 退化（去 clear）

**文件**：
- `$R/packages/renderer/src/composables/features/useSubagentListSync.ts`
- `$R/packages/renderer/src/composables/features/useWorkflowListSync.ts`

**改动**（两文件对称）：
1. 第一个 watch（focusedSessionId 变化）：**删除 `clearSubagents()`/`clearWorkflows()` 调用**（切走不清，切回直接读 Map 分区——ADR-0036 正确范式）。保留 `subscribeXxxPush(sid)` 重订阅 + `loadXxx(sid)` 首拉。
2. 第二个 watch（tab 激活）：`loadXxx(sid)` 不变（RPC 写对应分区）。

**依赖**：Step 1、Step 2。
**验证**：手动 review 切会话时无 `clear*()`；切到 B 再切回 A，A 的 records 仍正确（不闪不丢）。

---

## Step 4 — deleteSession 编排点挂钩 clearSession

**文件**：`$R/packages/renderer/src/composables/features/useSidebar.ts`（`deleteSession` 约 L325-390）

**改动**：
1. 在现有 `useFileTreeStore().clearSession(id)` / `tasks.clearSession(id)`（约 L373）并列，加：
   - `subagentStore.clearSession(id)`
   - `workflowStore.clearSession(id)`
2. `subagentStore`/`workflowStore` 在 deleteSession 内已通过 `useSubagentStore()`/`useWorkflowStore()` 获取（约 L350，现有 viewing 清理已用），复用同两变量。

**依赖**：Step 1、Step 2。
**验证**：手动核对删 session 后 `recordsBySession` 无该 sid 条目（防泄漏，ADR-0036 AC-8）。

---

## Step 5 — 消费点适配（Sidebar.vue + MessageStream.vue + getCurrent* 调用方）

**文件**：
- `$R/packages/renderer/src/components/sidebar/Sidebar.vue`（L255-270）
- `$R/packages/renderer/src/components/panel/MessageStream.vue`（L196，实际路径以 grep `isRunning` 确认，疑为 `components/panel/MessageStream.vue`）
- 调用 `getCurrentSubagent` / `getCurrentWorkflow` 的组件（grep 定位）

**改动**：
1. **Sidebar.vue L255-270**（6 个 computed，需确认 `focusedSessionId` 在 Sidebar.vue 可用——从 useSidebarSubagentActions 已用推断存在；若否则从 useSidebar 取）：
   - `subagentCount`：`subagentStore.records.length` → `subagentStore.recordsOf(focusedSessionId.value).length`
   - `subagentRunningCount`：`.records.filter` → `.recordsOf(focusedSessionId.value).filter(r => r.status==='running')`
   - `subagentList`：`subagentStore.records` → `subagentStore.recordsOf(focusedSessionId.value)`
   - `workflowCount`：`workflowStore.workflowCount()` → `workflowStore.recordsOf(focusedSessionId.value).length`
   - `workflowRunningCount`：`.records.filter` → `.recordsOf(focusedSessionId.value).filter(r => r.status==='running'||r.status==='paused')`
   - `workflowList`：`workflowStore.records` → `workflowStore.recordsOf(focusedSessionId.value)`
2. **MessageStream.vue:196**：`subagentStore.isRunning(subagentId)` → `subagentStore.isRunning(mainSessionId, subagentId)`（补 mainSessionId，panel 绑定 session 已知）。
3. **getCurrentSubagent / getCurrentWorkflow 调用方**：grep 定位后补传 `mainSessionId` 参数。

**依赖**：Step 1、Step 2、Step 3。
**验证**：`cd $R/packages/renderer && npm run lint`；手动切会话核对 6 个 computed 反映当前 session 数据。

---

## Step 6 — DerivedStatus 联合类型加 working 态

**文件**：`$R/packages/renderer/src/types.ts`（DerivedStatus 定义处，约 L20-28）

**改动**：联合新增 `'working'`（8→9 态）。

**依赖**：无（可与 Step 1-5 并行，须先于 Step 7）。
**验证**：`cd $R/packages/renderer && npx vue-tsc --noEmit`——所有 DerivedStatus 的 Record/Map 缺 working key 会报错，驱动 Step 7 补全。

---

## Step 7 — sessionStatus.ts 加 working 映射 + deriveStatus 加参数

**文件**：`$R/packages/renderer/src/composables/logic/sessionStatus.ts`

**改动**：
1. `DOT_CLASS`（约 L30）：加 `working: 'bg-accent'`（复用 accent 蓝）。
2. `STATUS_ICON`（约 L48）：加 `working: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' }`（复用转菊花）。
3. `SPINNER_STATUSES`（约 L90）：加 `'working'`。
4. `deriveStatus` 签名新增 `hasBackgroundWork = false`（建议放 `isCompacting` 之后、`metaStatus` 之前）。函数体在 **`if (chat.isGenerating(sid) || last?.status === STREAMING_STATUS) return 'streaming'`（约 L170）之后**插入：
   ```ts
   if (hasBackgroundWork) return 'working'
   ```
   **优先级链**：`waiting > retrying > compacting > streaming > working > pending > error > stopped > done`。
   （修正 planner 原稿「working 在 streaming 之前」的矛盾——streaming 必须先判，否则主 turn 流式被 working 抢占。）
5. 更新函数头注释优先级链文档。

**依赖**：Step 6。
**验证**：`cd $R/packages/renderer && npx vitest run src/__tests__/panel/session-status-icons.test.ts`（需 Step 9 补 working 用例）；`npx vue-tsc --noEmit`。

---

## Step 8 — useSessionDerivations 计算 hasBackgroundWork

**文件**：`$R/packages/renderer/src/composables/features/useSessionDerivations.ts`（`derivedStatus` 约 L64-75）

**改动**：
1. import `useSubagentStore` + `useWorkflowStore`。
2. `useSessionDerivations()` 内取实例。
3. `derivedStatus(id)` 的 computed 工厂内加：
   ```ts
   const hasBackgroundWork = subagentStore.hasRunning(id) || workflowStore.hasRunningOrPaused(id)
   ```
4. `deriveStatus` 调用补参（参数顺序对齐 Step 7.4）：
   ```ts
   deriveStatus(id, chat, chat.isActive(id), chat.isCompacting(id), hasBackgroundWork, meta)
   ```
5. **缓存无需额外处理**：computed 内读 `hasRunning`/`hasRunningOrPaused` 会建立对 `recordsBySession` 的响应式依赖，records 变化自动重算（与现有读 chat store 同理）。

**依赖**：Step 1（hasRunning）、Step 2（hasRunningOrPaused）、Step 7（签名）。
**验证**：`npx vue-tsc --noEmit`；手动：起 background subagent → 主 turn 结束 → SessionItem/PanelHeader 显示转菊花。

---

## Step 9 — 测试：session-status-icons.test.ts 补 working 用例

**文件**：`$R/packages/renderer/src/__tests__/panel/session-status-icons.test.ts`

**改动**（测试框架 vitest，`from 'vitest'` 导入，禁止 node:test/tsx --test）：
1. `DOT_CLASS 包含所有扩展状态`（约 L27）`statuses` 数组加 `'working'`。
2. `STATUS_ICON 包含所有扩展状态`（约 L41）`statuses` 数组加 `'working'`。
3. 新增用例（参照约 L62 的 `pendingSend 派生为 pending` 模式）：
   - `hasBackgroundWork=true 且非活跃 派生为 working`：mock chat 无活跃态，`deriveStatus('sid', chat, false, false, true)` 断言 `'working'`。
   - `streaming 优先于 working`：`chat.isGenerating` 为 true 且 `hasBackgroundWork` 为 true，断言 `'streaming'`（验证 Step 7.4 streaming 分支先于 working）。
   - `working 优先于 pending`：`isActive=true`（pendingSend）且 `hasBackgroundWork=true` 且非 streaming，断言 `'working'`。

**依赖**：Step 6、Step 7。
**验证**：`cd $R/packages/renderer && npx vitest run src/__tests__/panel/session-status-icons.test.ts` 全绿。

---

## Step 10 — 其他 DerivedStatus 消费点适配

**文件**（grep `DerivedStatus` 的 switch/Record 消费点）：
- `$R/packages/renderer/src/components/sidebar/SessionItem.vue`
- `$R/packages/renderer/src/components/overview/SessionCard.vue`
- `$R/packages/renderer/src/components/panel/PanelHeader.vue`
- 其他对 DerivedStatus 做 switch 或穷举映射的组件

**改动**：
1. 评估每个 switch/Record 消费点：working 是否需专属分支。
2. 多数消费点经 `STATUS_ICON[status]`/`DOT_CLASS[status]` 驱动（Step 7 已补 working 映射），组件无需改。
3. **重点检查 PanelHeader**：若显示「正在思考/已结束」文案，working 态补「后台任务运行中」类文案（参照现有 streaming 文案 key 模式）。

**依赖**：Step 6、Step 7。
**验证**：`npx vue-tsc --noEmit`（穷举 switch 缺 case 报错）；`npm run lint`；手动 `npm run dev` 观察三处视觉。

---

## Step 11 — 全量回归

**命令**（均从 `$R/packages/renderer`）：
1. `npx vitest run`（全部单测，重点 subagent/workflow/session-status）
2. `npx vue-tsc --noEmit`（DerivedStatus 9 态 Record 完整性）
3. `npm run lint`
4. 手动 E2E（`npm run dev`）：
   - background subagent 主 turn 结束 → SessionItem 保持转菊花（working）→ subagent 终态 → 回落 done
   - background workflow（running/paused）同上
   - 切到另一 session 再切回 → background session 的 working 态仍正确（验证 per-session 分区 + 切走不清）
   - 删除 running background work 的 session → `recordsBySession` 该 sid 条目已清

**依赖**：Step 1-10 全部完成。

---

## 步骤依赖图

```
Step 6 (types) ──┐
Step 1 (subagent)─┤
Step 2 (workflow)─┼→ Step 7 (sessionStatus) → Step 9 (test)
                  │                          ↗
                  └→ Step 8 (derivations) ──
Step 1,2 → Step 3 (ListSync)
Step 1,2 → Step 4 (deleteSession)
Step 1,2,3 → Step 5 (消费点)
Step 6,7 → Step 10 (其他消费点)
全部 → Step 11 (回归)
```

可并行：Step 1‖2‖6；Step 5‖8‖9‖10 在各自依赖满足后并行。

## 约束遵守清单

- vitest（Step 9 明示，禁 node:test/tsx --test）
- 不动 runtime（全在 `$R/packages/renderer/`）
- store 互不 import（Step 1 采用 recordsOf(sid) 注入范式）
- 无 `any`（recordsOf 返回具体类型）
- 无硬编码颜色（working 复用 `text-accent`/`bg-accent` CSS 变量）
- 失败要出声（每步列验证命令）
- AGENTS.md 规则 #7 延伸（Step 1.5 推送写帧 sessionId 分区）
- ADR-0036 范式对齐（Step 3 去 clear、Step 4 挂 clearSession）
