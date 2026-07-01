---
slug: 2026-07-01-model-list-empty-race
title: 修复 ModelSelectPopover 模型列表为空的时序竞态
created: 2026-07-01
status: planning
scope_ensemble_overlap: na
reuse_ensemble_overlap: high
test_ensemble_overlap: na
reconstruct_blind_spot: na
---

# plan.md — 模型列表为空的时序竞态修复

## 1. 业务目标

**一句话目标**：打开模型切换 popover 时，模型列表始终有数据，不再出现"无匹配模型"空列表。

**可衡量成功标准**：
- 切换 session / 切换 panel / landing↔session 切换后打开 popover，列表非空
- 首屏无 session → 新建 session → 打开 popover，列表非空
- 全量单测通过，零回归（基线 1653 passed）

**约束 / 不做**：
- 不改 runtime（`model.list` 推送逻辑已正确：连接时推 + providers 变更时广播）
- 不改其他全局订阅（providers/skills/agents/defaults 已是 store 常驻订阅，正确）
- 不引入新的 RPC 请求入口（runtime 当前 `model.list` 无 client 主动拉 handler，本计划也不补——长期方案靠 store 常驻订阅即可，不需要主动拉）
- 只提交本次改动，不动别人的代码（用户约束延续）

## 2. 技术改动点

### 根因
`ModelSelectPopover.vue:92-95` 的模型列表是**组件本地订阅**，在 `onMounted` 才注册：
```ts
const models = ref<ModelInfo[]>([])
onMounted(() => {
  unsub = modelApi.onModels((list) => { models.value = list })
})
```
`model.list` 由 runtime `sendInitialState`（`server.ts:325`）在 **WebSocket 连接建立时推一次**，以及 `broadcastProviderList`（`server.ts:430`）在 providers 变更时广播。

`ModelSelectPopover` 在 `Composer` 内，`Composer` 用 `v-if="showPanelComposer"`（`Panel.vue:69`）随 session/panel 状态反复挂载卸载。**重新 mount 时 sendInitialState 早已推送过**，订阅再也收不到 → `models` 永远是初始 `[]` → popover 空。

对比同项目正确模式：`providers/skills/agents/defaults` 同源数据由 `settingsStore.init()`（`settings.ts:80-95`）在 **AppShell 应用根**（`AppShell.vue:52`）注册**常驻订阅**，生命周期内不断开。`ModelSelectPopover` 独自在组件本地订阅一次性事件，是唯一异类。

### 改动点清单（文件级）

| # | 文件 | 改动 | 复用来源 |
|---|------|------|---------|
| C1 | `src-electron/renderer/src/stores/settings.ts` | 新增 `models` ref + 在 `init()` 加 `modelApi.onModels` 订阅；return 暴露 `models` | 复用既有 `providers/skills/agents` 订阅模式（L84-90），逐行同构 |
| C2 | `src-electron/renderer/src/components/panel/ModelSelectPopover.vue` | 删除本地 `models` ref + `onMounted`/`onBeforeUnmount` 订阅逻辑；`models` 改读 `settingsStore.models` | — |
| C3 | `src-electron/renderer/src/__tests__/panel/model-select-popover.test.ts` | 现有 4 个用例（U15/U18/U18b/U19）数据源从 `vi.mock('@/api')` 捕获 onModels 改为 mock store `models`；新增竞态回归用例 | — |
| C4 | 新增 `src-electron/renderer/src/__tests__/stores/settings-store-models.test.ts` | settingsStore.init 订阅 onModels + models ref 更新的单测 | 复用既有 settingsStore 测试模式 |

**不做**（显式排除）：
- 不改 `Composer.vue`（它只透传 `currentModelId` 给 popover 的 `:selected`，不碰 models 列表）
- 不改 `ThinkingLevelPopover.vue`（它读 `settingsStore.providers`，与 models 列表无关）
- 不改 runtime（推送逻辑正确）

## 3. Wave 拆分与依赖

改动点 4 个，但 C1 是 C2/C3/C4 的依赖（store 先有 models，popover 才能读，测试才能 mock）。改动集中在单一子系统（renderer store + 组件 + 测试），无并行价值 → 单 Wave 串行 + 末尾验收 Wave。

| Wave | 改动文件 | 依赖 | 并行组 | 说明 |
|------|---------|------|--------|------|
| W1 | settings.ts, ModelSelectPopover.vue, model-select-popover.test.ts, settings-store-models.test.ts | - | - | store 提升 + popover 改读 + 测试全改（同子系统，单 subagent 串行）|
| W2 | — | W1 | - | 验收：全量单测 + tsc + lint |

**不并行的理由**：4 个文件都在 renderer 层，C2/C3/C4 都直接依赖 C1 的 `settingsStore.models`，且 C2/C3 改同一组件族（popover 组件 + 其测试），同 worktree 并行会文件冲突。单 subagent 串行更稳。

## 4. 单测用例清单（AC 级）

> 测试框架：vitest（renderer 用 @vue/test-utils + happy-dom）。运行命令：`cd src-electron/renderer && npx vitest run <file>`。

### settings-store-models.test.ts（新增，覆盖 C1）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U1 | settings.ts:init 订阅 onModels | mock onModels 捕获 handler 后调用 handler([M1,M2]) | `settingsStore.models` === [M1,M2] | 正常 |
| U2 | settings.ts:init 幂等 | 连续调 init() 两次 | onModels 只订阅一次（vi.mock 的 onModels 被调用 1 次）| 边界 |
| U3 | settings.ts:init models 初始值 | init() 前读 settingsStore.models | `[]`（空数组初始值）| 正常 |
| U4 | settings.ts:dispose 清订阅 | init() → dispose() → 再推 onModels | 第二次推送后 settingsStore.models 不变（订阅已断）| 异常 |

### model-select-popover.test.ts（改写现有 + 新增，覆盖 C2/C3）

> 数据源从 `vi.mock('@/api').model.onModels` 改为 mock `settingsStore.models`。现有 4 用例（U15/U18/U18b/U19）断言不变，只是数据注入方式变。

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U5 | ModelSelectPopover 读 store 渲染 | settingsStore.models=[M1,M2], props.selected='anthropic/claude-4' | 触发器文案含 'Claude 4'（原 U18，数据源改 store）| 正常 |
| U6 | ModelSelectPopover 纯受控 props 变化 | mount 后 setProps selected 从 M1 改 M2 | 触发器文案跟随更新为 M2.name（原 U18b）| 正常 |
| U7 | ModelSelectPopover onSelect emit | 点选 gpt-4 | emit('select', {modelId:'gpt-4',provider:'openai'})（原 U19）| 正常 |
| U8 | ModelSelectPopover selected 空串 | props.selected='' | 触发器 Button 存在，不崩（原 U15）| 边界 |
| **U9** | **竞态回归：store 有数据但组件后挂载** | 先设 settingsStore.models=[M1,M2]，再 mount ModelSelectPopover（无 onModels 推送）| 触发器文案含 'Claude 4'（**核心回归用例：模拟 v-if 翻转后重新 mount，不依赖任何推送**）| **边界** |
| U10 | ModelSelectPopover 分组渲染 | settingsStore.models 含 2 个 provider 各 1 model | groups 计算出 2 个分组，每组 1 个 model | 正常 |
| U11 | ModelSelectPopover 搜索过滤 | settingsStore.models=[M1('Claude'),M2('GPT')], query='cla' | groups 只含 M1 | 正常 |
| U12 | ModelSelectPopover store 空 | settingsStore.models=[] | 渲染"无匹配模型"提示 | 异常 |

> **U9 是本计划的核心回归用例**——它直接复现了 bug 场景：组件后挂载（错过 sendInitialState），但 store 已有数据（常驻订阅早收到）。旧实现此场景必空，新实现因读 store 必有数据。

### 反向自检（同源盲区）

- 调用方反推：ModelSelectPopover 还有别的数据源吗？已确认仅 `models`（列表）+ `props.selected`（选中值），无其他。
- 数据集反推：ModelInfo 的 providerId/providerName 缺失时分组 key 怎么办？`groups` computed 用 `m.providerId` 作 key，若 ModelInfo 无 providerId → key=undefined，仍分组（不崩）。无需额外用例（边界由现有 groups 逻辑兜底）。
- 异常路径：store dispose 后组件读 models？dispose 仅在 AppShell 卸载时调（应用生命周期内不触发），组件不会读到 dispose 后状态。U4 已覆盖 dispose 语义。

## 5. E2E 用例清单

> 本 bug 是**纯时序竞态**（订阅时机 vs 推送时机），根因在数据流架构，不在 DOM 交互。自动化覆盖由单测 U9（竞态回归）保证——它精确复现了"组件后挂载、store 已有数据"的 bug 条件。

真实 DOM 交互验证（打开 popover 看列表）需要完整 Electron + runtime 环境，且 mock 模式（`VITE_MOCK=true`）的 `makeMockSubscription` 订阅即推初始值（`subscription.ts:17` `queueMicrotask`），**mock 模式无法复现此竞态**——这也是为什么 mock 模式测试一直绿但真实环境出 bug。

| 用例ID | 场景 | 前置 | 步骤 | 预期 | 执行方式 |
|--------|------|------|------|------|---------|
| E1 | 切换 session 后模型列表非空 | dev 模式（npm run dev），已连接 runtime，≥1 个 provider 配置 | 1.选 session A 2.打开模型 popover 3.切 session B 4.打开模型 popover | 两次打开列表都非空，含已配置的模型 | 手动（需真实 runtime + WebSocket，mock 无法复现竞态）|
| E2 | 首屏新建 session 后列表非空 | dev 模式，首屏无 session（landing 态）| 1.点新建 2.输入发送（创建 session，Composer v-if 翻转）3.打开模型 popover | 列表非空 | 手动 |

> E2 标 `[执行前提待补:真实runtime环境]`——happy-dom/mock 无法复现 v-if 翻转后的真实订阅时序。逻辑层由 U9 覆盖，交互层手动验证。

## 6. 覆盖率 gate

- **命令**：`cd src-electron/renderer && npx vitest run --coverage`
- **增量范围**：本次改动文件（`stores/settings.ts`、`ModelSelectPopover.vue` + 2 个测试文件）。测试文件不计入覆盖率分母。
- **阈值**：改动文件行覆盖 ≥ 80%（高于 lite 下限 60%，因改动小且为 bug 修复，关键逻辑必须覆盖）
- **gate 位置**：W2 验收 todo 执行

## 实现步骤

### W1：store 提升 + popover 改读 + 测试（单 subagent 串行）

1. **C1 settings.ts**：加 `const models = ref<ModelInfo[]>([])`；`init()` 内加 `unsubs.push(modelApi.onModels((m) => { models.value = m }))`；import 从 `@/api` 取 `model as modelApi`（注意 settings.ts 已 import `config`/`extension`/`settings as settingsApi`，新增 `model as modelApi`）；return 加 `models`。
2. **C2 ModelSelectPopover.vue**：删 `import { model as modelApi, type ModelInfo }`（保留 `ModelInfo` type import 给 groups computed 类型）；删 `const models = ref<ModelInfo[]>([])` + `onMounted`/`onBeforeUnmount` 订阅块（L76-95 区域）；删 `import { onMounted, onBeforeUnmount }`；加 `import { useSettingsStore } from '@/stores/settings'` + `const settingsStore = useSettingsStore()`；`groups`/`currentName` computed 内 `models.value` → `settingsStore.models`。
3. **C3 model-select-popover.test.ts**：`vi.mock('@/api')` 去掉 model.onModels；改用 `setActivePinia` + `useSettingsStore()` 后直接设 `settingsStore.models = MODELS`；现有 U15/U18/U18b/U19 断言不变；新增 U9-U12（见单测清单）。
4. **C4 settings-store-models.test.ts**：新建，覆盖 U1-U4。
5. 逐文件 `cd src-electron/renderer && npx vitest run <file>` 验证全绿。
6. **行数自检**：ModelSelectPopover.vue `<script setup>` 删订阅逻辑后行数下降（远低于 300 限制）；settings.ts 加 ~3 行（不超 300）。

### W2：验收（blocked_by W1）

1. `cd src-electron/renderer && npx vitest run` 全量（基线 1653 passed，本次新增 ~8 用例 → 预期 ≥1661 passed，零回归）
2. `cd src-electron/renderer && npx vitest run --coverage` 看 settings.ts + ModelSelectPopover.vue 行覆盖 ≥ 80%
3. `cd src-electron/renderer && npx vue-tsc --noEmit`（renderer tsc 通过）
4. `npm run lint`（ESLint 通过；ModelSelectPopover 删 import 后无未用变量告警）
5. 提交：只提交本次 4 个文件改动，逐个 commit 或合并为一个 feature commit（用户约束：只提交自己的改动）

## Self-Check

范围与目标：
- [x] 范围守门自检：renderer 单子系统，无架构决策，属 lite
- [x] 业务目标可衡量（列表非空 + 单测全绿）
- [x] 技术改动点文件级清单，无遗漏（已确认 Composer/ThinkingLevelPopover 不动）
- [x] 已读项目规范（AGENTS.md 测试规范 + 前端编码规范）
- [x] 复用检查：C1 逐行复用 providers 订阅模式，reuse_ensemble_overlap: high（模式已验证，单路检查足够）

Wave 拆分：
- [x] W1 垂直切片（store→popover→测试 同子系统）
- [x] blocked_by 从依赖推导（C2/C3/C4 依赖 C1）
- [x] 无并行组（同子系统文件冲突风险，串行更稳）
- [x] 末尾 W2 验收 Wave

测试设计：
- [x] 每个改动点 ≥1 单测（C1→U1-U4，C2/C3→U5-U12）
- [x] 单测可机器判定（具体值断言）
- [x] 正常/异常/边界覆盖（U12 异常、U8/U9 边界）
- [x] E2E 探测测试栈（vitest renderer 层；竞态需真实 runtime → 手动）
- [x] 现有测试如何随改动改：U15/U18/U18b/U19 数据源从 onModels mock 改为 store mock（已评估）
- [x] 覆盖率 gate 写明命令 + 阈值

格式：
- [x] 含 `## 实现步骤` 标题
- [x] 无占位符

审查：
- [x] 改动点 4 个（≥3）但单 Wave，步骤 5b 草案审查条件为"改动点≥3 或 Wave≥2"，本计划 Wave=1 → 不强制触发禁读重建，走单路自检（反向自检已做）

## 标记说明

| 标记 | 含义 |
|------|------|
| [铁律] | 阶段核心不可逾越的边界 |
| [MANDATORY] | 流程强制要求 |
