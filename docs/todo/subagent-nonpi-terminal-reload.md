# TODO: 非 pi 引擎 subagent 终态后 drawer tab 自动回填

> 创建：2026-08-25。状态：待实现（用户 2026-08-26 实施）。
> 优先级：高——这是 U4「zcode drawer render」的落地缺口：设计 D7 场景 1 承诺「完成后 drawer 渲染完整对话」，实现只覆盖了「终态后打开」，漏了「运行中已打开、终态后回填」路径。

## 1. 问题现象

改造 subagent engine（stage-1 U0-U6，zcode 引擎接入）后：

- 主 agent 派发 **zcode 引擎** subagent，任务 running 期间从**对话流 subagent block** 点击打开 drawer subagent tab → tab 空白，只有 coarse hint（「zcode 引擎：运行中（不支持实时流…）」）。
- 任务终态后，**已打开的 tab 永远不更新**——即使 journal/sqlite 已有完整对话内容，也必须切走再切回（制造 virtualId 变化或组件重挂载）才能看到终态内容。
- 对照观察（曾误判为入口差异）：点击**侧边栏 subagent item**「能看到内容」——不是入口代码不同，而是点击时刻 record 已终态（journal 有内容）且 vid 发生变化触发了重拉。两个入口代码路径完全等价（见 §2.1）。

## 2. 根因分析（证据链）

### 2.1 两个入口代码等价（排除入口差异）

| 入口 | 代码 | virtualId |
|------|------|-----------|
| 对话流 block | `packages/ui/src/features/chat/BlockSubagent.vue:125-130` | `subagentVirtualId(props.sessionId, JSON.parse(tool.output).subagentId)` |
| 侧边栏 item | `packages/renderer/src/composables/features/sidebar/useSidebarSubagentActions.ts:30-34` | `subagentVirtualId(panelStore.currentLeaf?.sessionId, record.subagentId)` |

两处 id 同源（record.id = `sa-${uuid}`，`extensions/universal/subagent-workflow/src/execution/subagent-service.ts:1415`，与引擎无关），都汇到 `drawerControl.setSubagentView`（`packages/core/src/domain/drawer/control.ts:106`）→ SubagentTab 的 `watch(selectedSubagentId)`。

### 2.2 SubagentTab 数据加载是一次性的

`packages/renderer/src/components/panel/SubagentTab.vue:330-338`：

```ts
watch(
  selectedSubagentId,
  (vid, oldVid) => {
    if (oldVid) subagentStore.stopStream(STREAM_SCOPE)
    if (vid) void loadSubagentData(vid)
  },
  { immediate: true },
)
```

`loadSubagentData`（同文件 :286-328）= 一次 `fetchAndInject`（RPC 拉历史快照）+ `subscribeStream`（订阅 `subagent.stream_delta`）。**watch 只在 vid 变化时触发；此后没有任何重拉、轮询或终态回填机制。** 唯一手动刷新入口是错误态的 retry 按钮（仅在 `loadError` 非空时渲染）。

### 2.3 zcode 引擎无实时流（设计内），终态才写 journal

- zcode 引擎 spawn 形态：`node zcode.cjs --json --cwd <dir> --mode yolo --prompt <完整任务>`（one-shot，`launcher.ts`）。子进程跑完整个任务才退出，stdout 输出**终态单 JSON**；运行期间无事件流可 tee。
- 事件产出「不变量 5」：只在终态后一次性合成 coarse 事件（`zcode-engine.ts:233,335`），journal 终态才写入。
- 因此 running 期间：无 `subagent.stream_delta` 帧、无 `session.subagentEntriesAppended` 帧、三级读链（①sqlite ②journal replay ③outcome-only，`packages/runtime/src/services/session/subagent-engine-history.ts`）全返回空。**这是设计裁决**（`docs/architecture/subagent-engine-gui-visibility.md` D7：「zcode 对话流 = 终态渲染 + 运行中如实提示，不伪造流」），不是 bug。
- pi 引擎不受影响：子进程 stdout 经 relay-registry → `relay-tee.ts` 实时翻译持续广播，drawer 实时流与打开入口无关。

### 2.4 缺口：record 终态时 drawer 不回填

record 终态 → renderer store 更新的链路**是通的且与引擎无关**（宿主层统一持有 record 生命周期，设计 D6/D14）：

1. zcode `run()` resolve → 宿主 finalize-record：record status 迁移终态 + `appendEntry`（custom type `SUBAGENT_RECORD_CUSTOM_TYPE`）写主 pi session
2. runtime `invalidateRecordEntries`（`session-service.ts:694-702`，custom entry 变更触发）→ 防抖 → `refreshRecordEntries` → `scanSubagentEntries` 派生 → status 变化 → `applyRecordEntries` publish `session.subagents` 全量帧（`session-service.ts:786-812`）
3. renderer `route-inbound.ts:215` → `useMessageEffects.handleSubagents` → `subagentStore.applyRecords`

record 更新后，SubagentTab 内的响应式消费（标题栏 `subagentMeta`、coarse hint 可见性 `coarseHintVisible`）都会正确变化——**唯独对话流（chatStore 虚拟分区）不重拉**。这就是「coarse hint 消失了、标题状态变了、但内容永远停在打开时刻的快照」的机制。

结论：不是渲染层 bug，是 **SubagentTab 缺一个「非 pi record 终态 → reload」的响应式桥**。

## 3. 修复方案

**SubagentTab 新增一个 status watch：同一 subagent 的 record status 从 `running` 跨越到终态、且引擎非 pi 时，自动调一次 `loadSubagentData(vid)`。**

### 3.1 实现位置与代码草案

`packages/renderer/src/components/panel/SubagentTab.vue`，紧挨现有 `watch(selectedSubagentId)` 新增：

```ts
/**
 * 非 pi 引擎终态回填（U4 落地缺口）：zcode 等引擎运行中无实时流（设计 D7 coarse），
 * record 终态（session.subagents 广播 → store applyRecords）时重拉一次历史快照，
 * 让运行中打开的 tab 在任务结束后自动显示完整对话。pi 引擎走 tee 实时通道，
 * 终态内容已由 entry 帧投影，行为零变化（设计 D5 守护），不触发。
 */
watch(
  () => {
    const record = currentRecord.value
    return record ? { vid: selectedSubagentId.value, subId: record.subagentId, status: record.status } : null
  },
  (cur, prev) => {
    if (!cur || !prev) return
    // vid/subId 变化 = 切换 subagent：新 vid 由 watch(selectedSubagentId) 负责加载，此处跳过
    if (cur.vid !== prev.vid || cur.subId !== prev.subId) return
    // 仅 running → 终态的跨越触发（打开时已终态的 record 首拉已覆盖，prev 非运行态不触发）
    if (prev.status !== 'running' || cur.status === 'running') return
    const record = currentRecord.value
    if (!record || recordEngine(record) === DEFAULT_ENGINE_ID) return
    void loadSubagentData(cur.vid)
  },
)
```

已存在的复用件（全部无需改动）：

- `currentRecord` computed（SubagentTab.vue:217-224）：按 vid 从 `subagentStore.getRecordsBySession` 查 record，响应式跟随 `applyRecords`
- `recordEngine(record)`（同文件 :227-229）：`record.engine || DEFAULT_ENGINE_ID`，缺省映射 pi（与 runtime `extractRecordEngine` 同语义，D5）
- `loadSubagentData(vid)`（同文件 :286-328）：幂等可重入——`loadError` 先置 null；`fetchAndInject` 是 `setMessages` 全量覆盖；`subscribeStream` 内部先 `stopStream(scope)` 再挂新 handler（`stores/subagent.ts:295`）。终态 reload 时 `coarseHintVisible` 已因 status 变化自动消失，时序无依赖
- A8 兜底自动生效：reload 后若读链三级全空且 `record.result/error` 有值，`loadSubagentData` 内的 outcome-only 投影照常注入（不白屏）

### 3.2 status 判据事实（写用例前核对）

- `SubagentStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'crashed' | 'closed'`（`packages/shared/src/subagent.ts:26`）。终态 = 非 `'running'` 全集，不需要逐枚举。
- **v4 语义注意**：pi chatMode subagent 轮终会「故意回写 status='running'」（`stores/subagent.ts` hasRunning 注释、shared/subagent.ts:70-72）——即 pi record 可能出现 done→running→done 波动。本 watch 有非 pi 守卫，pi 波动天然不触发，无影响。
- zcode 不支持 conversation（`subagent-service.ts:1495-1502` assertEngineParamSupport），zcode record 不会回写 running，终态一次到位。

### 3.3 明确不做（防 scope 膨胀）

- 不给 zcode 做运行中实时流 / 轮询 journal 冒充流式——设计 D7/D12 已裁决「伪造流式是反模式」，统一实时面是阶段 3 预留（AgentEvent 为唯一实时面）。
- 不改 pi 路径任何行为（D5 字节级/行为零变化守护）。
- 不加「刷新按钮」之类 UI——终态自动回填后没有用户主动刷新的需求场景。

## 4. 验收标准（真机 `pnpm dev`，非单测）

1. **主场景（block 入口全链路）**：dev 环境 `defaultEngine=zcode`（或显式 `engine: "zcode"` 派发），主 agent 派 zcode subagent → running 中点对话流 block 打开 drawer → 空流 + coarse hint → 等任务终态（sidebar item 状态翻转）→ **tab 自动出现完整对话**（user task + assistant response 含 toolCalls），无需任何切换操作。
2. **失败路径**：zcode 任务 failed（如 LLM 401）→ 已打开 tab 自动回填错误态内容；读链异常时 outcome-only 摘要兜底可见（`subagent-outcome-summary` testid）。
3. **pi 零变化**：pi subagent 打开 drawer → 逐字实时流照常；终态时**无**多余 reload（可在 fetchAndInject 路径加临时 log 或断点验证调用次数 = 打开时 1 次）。
4. **切换不误触发**：drawer 内在 subagent A（zcode, running）→ B → A 之间切换，不因 vid 切换触发重复加载风暴（status watch 的 vid 守卫生效）；A 终态时若 tab 正停留在 A，仍正确回填。
5. **重开 session 一致**：终态回填后关闭重开 session，再点开同一 subagent，内容一致（live ≡ reload，快照同源）。

## 5. 测试计划

`packages/renderer/src/__tests__/panel/subagent-tab.test.ts` 已有完整 mock 骨架（openSubagent 驱动 + store mock + `subagentVirtualId` 构造），照抄模式新增用例：

1. 非 pi record：先 openSubagent（status=running，断言 fetchAndInject 调用 1 次）→ mock `applyRecords` 推 status=done → 断言 fetchAndInject 第 2 次调用（终态回填）。
2. pi record（engine 缺省或 'pi'）：同样 running→done 推送 → 断言 fetchAndInject 仍只 1 次（零变化守护）。
3. vid 切换：openSubagent A(running) → openSubagent B → 推 A 终态 → 断言不为 A 触发加载（A 已非当前 vid）。
4. 打开时已终态：openSubagent 时 record status=done → 首拉后推一次 records（status 不变）→ 不二次加载。
5. 按 TEST-STRATEGY 三视角：用例 1 同时断言用户可见 DOM（coarse hint 消失 + 终态内容出现在消息流），不只 mock 调用计数。

## 6. 关联

- 设计依据：`docs/architecture/subagent-engine-gui-visibility.md` D5（pi 零变化）/ D7（终态渲染 + coarse 提示）/ D12（实时流统一是阶段 3，本修复不动它）
- U4 落地 commit：0b8f1fc23（coarse hint + A8 兜底；本修复补其「运行中打开、终态后回填」缺口）
- 约束登记：`docs/constraints.json` C-ext-16..18（engine GUI 相关，本修复不改约束面）
- 教训记录：U4 验收只测了「终态后打开」形态，「运行中打开等终态」形态漏测——错误归因/渲染类修复必须枚举全部已知形态各写用例（同 2026-08-25 两轮教训）
