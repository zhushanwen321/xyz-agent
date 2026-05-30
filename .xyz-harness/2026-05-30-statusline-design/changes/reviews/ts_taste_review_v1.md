---
verdict: pass
must_fix: 1
reviewer: ts-taste-check v1
date: 2026-05-30
scope: 54f68e6..HEAD (statusline feature)
---

# TypeScript 代码品味审查报告

审查范围：17 files changed, 1327 insertions(+), 94 deletions(-)

## 文件逐项审查

---

### `src-electron/runtime/src/index.ts`（137 行，新增 ~25 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| **P0** | 结构 | L68-89 | `onContextUpdate` 回调内嵌 22 行逻辑（provider 查询、model 查找、百分比计算、广播），在 DI 工厂的 lambda 内直接操作 3 个 service | 提取为独立函数 `computeAndBroadcastContextUpdate(sid, ctxData, deps)`，lambda 内仅一行调用 |
| P1 | 魔法数字 | L80 | `inputTokens === 0` 跳过 + 隐式语义"token 为 0 时无意义" | 可接受——0 是业务语义而非魔法值 |
| P1 | 类型 | L72 | `session?.modelId` 返回 `string \| undefined`，下游 `modelRef.indexOf('/')` 安全，但 `modelRef.slice(0, sepIdx)` 拼接 providerId/modelId 的隐式解析散落在此 | 已有 `sepIdx >= 0` 保护，但建议 future 提取为 `parseModelRef(modelId): { providerId, modelId } \| null` |

**统计**: P0: 1 | P1: 1

---

### `src-electron/runtime/src/event-adapter.ts`（327 行，新增 ~18 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | `as` 断言 | L209 | `event.method as string \| undefined`——pi 事件字段无类型声明，此为已有模式（白名单：pi patch 层） | 可接受，符合白名单 |
| P1 | `as` 断言 | L186-187 | `lastMsg?.usage as { totalTokens?: number; ... }`——运行时数据结构断言，符合白名单（pi response patch 层） | 可接受 |

**统计**: P0: 0 | P1: 0（均在白名单内）

---

### `src-electron/runtime/src/server.ts`（783 行，新增 ~14 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| — | — | — | 新增 `handleStatusSetUpdate` 6 行，职责清晰：路由到 PluginService | 良好 |
| P1 | 防御 | L757-758 | `this.pluginService?.handleBridgeEvent` 可选链安全，但 `pluginService` 在 `setServices` 后应始终存在——可选链是冗余防御还是有意 late-init 保护？ | 如果 `setServices` 在构造后立即调用且不变，可改为非空断言；否则保持现状合理 |

**统计**: P0: 0 | P1: 0

---

### `src-electron/runtime/src/services/plugin-service/plugin-service.ts`（734 行，新增 ~64 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | 魔法数字 | L425 | `priority: options?.priority ?? 100`——100 是默认优先级常量 | 提取为 `const DEFAULT_STATUS_BAR_PRIORITY = 100` |
| — | 结构 | L695-720 | `broadcastStatusBarItems` + `getStatusBarItems` + `clearStatusBarItems` 三个方法组织良好，单一职责 | 良好 |
| — | 错误处理 | L596-598 | `handleBridgeEvent` 内 `.catch` 有 `console.error`，不静默 | 良好 |
| — | 类型安全 | L413-432 | `updateStatusBarItem` 参数类型完整（`StatusBarItemOptions`），构造 `StatusBarItem` 时所有字段显式赋值 | 良好 |

**统计**: P0: 0 | P1: 1

---

### `src-electron/runtime/src/services/plugin-service/api/ui-api.ts`（100 行，新增 ~6 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | `as` 断言 | L69 | `params.options as StatusBarItemOptions \| undefined`——RPC params 来自 Worker 线程 IPC，类型已在 RPC 层约束 | 可接受——RPC handler 处于边界层，`as` 断言符合 "函数签名兼容性优先" 偏好 |

**统计**: P0: 0 | P1: 0

---

### `src-electron/runtime/src/services/plugin-service/plugin-types.ts`（421 行，新增 ~11 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| — | — | — | `StatusBarItemOptions` interface 定义完整，字段均有类型约束和 `?` 可选标注 | 良好 |

**统计**: P0: 0 | P1: 0

---

### `src-electron/renderer/src/components/chat/InputToolbar.vue`（239 行，新建）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | 魔法数字 | L53-60 | `THINKING_BAR_HEIGHTS` 的数字（2/3/4/5/6/7/8/9/10/11/12）是 SVG bar 高度像素值，语义明确但散落在对象字面量中 | **可接受**——已用命名常量 `THINKING_BAR_HEIGHTS` 收敛，数字含义自解释 |
| P1 | 魔法数字 | L87-90 | `85` 和 `60` 是 context 严重程度阈值百分比 | 提取为 `CONTEXT_WARN_THRESHOLD = 60` / `CONTEXT_DANGER_THRESHOLD = 85` |
| P1 | 魔法数字 | L76 | `2.4` 是 thinking bar 动态高度步进值 | 提取为 `const BAR_HEIGHT_STEP = 2.4` 或在注释中说明语义 |
| P1 | 模板函数 | L83,96 | `getBarHeights(currentThinkingLevel)` 和 `getThinkingColor(currentThinkingLevel)` 在模板中直接调用，每次渲染执行 | 可接受——thinking bar 高度/颜色是轻量计算，参数变化频率低；若后续有性能问题再改 computed |
| P1 | Emoji | L171,176 | `&#8593;` (↑) 和 `&#8595;` (↓) 是 Unicode 箭头实体，非 Emoji | 合规——HTML entity，跨平台一致 |
| P1 | 事件 | L25 | `emit('select-thinking-level', level)` — 单参数 emit 合规 | 良好 |
| — | 组件行数 | 全文件 | 239 行（script ~120 行 + template ~119 行），在 300 行限制内 | 良好 |
| — | 职责 | 全文件 | 单一职责：输入区域工具栏（model picker + thinking + context + tokens + send/cancel） | 良好——关注点多但都是"输入行辅助" |

**统计**: P0: 0 | P1: 3

---

### `src-electron/renderer/src/components/chat/SessionStrip.vue`（57 行，新建）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| — | 职责 | 全文件 | 单一职责：展示 per-session 扩展状态条目（chips） | 良好 |
| — | 类型安全 | 全文件 | `PluginStatusItem` 类型完整，无 `any` | 良好 |
| — | 命名 | L15-17 | `getChipClasses` 按前缀匹配返回颜色方案，逻辑清晰 | 良好 |
| — | 组件行数 | 全文件 | 57 行，远低于限制 | 良好 |

**统计**: P0: 0 | P1: 0

---

### `src-electron/renderer/src/components/layout/AppStatusbar.vue`（86 行，重写）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| — | 职责 | 全文件 | 重构后只保留全局状态栏：连接状态 + 分支名 + 全局扩展条目 | 良好——职责更清晰 |
| — | 删除 | — | 删除了 `chatStore` 依赖、token 格式化逻辑、`TOKEN_THRESHOLD` 常量——这些已迁移到 `InputToolbar` | 正确——消除重复 |
| — | 类型 | 全文件 | `globalStatusBarItems` 使用 store computed，无 `any` | 良好 |

**统计**: P0: 0 | P1: 0

---

### `resources/plugins/statusline/index.ts`（70 行，新建）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| **P0** | 耦合 | L1 | `import type { PluginContext } from '../../../src-electron/runtime/src/services/plugin-service/plugin-types.js'`——内置插件直接引用源码相对路径，构建不可移植 | 应通过 `@xyz-agent/plugin-types` 包导入或从 `../../../src-electron/shared/src/` 导入共享类型。当前路径在 `npm run build` 后可能无法解析 |
| P1 | `as` 断言 | L50 | `data as BridgeEventData`——hook handler 的 `data` 参数类型为 `unknown`，此处用 `as` 断言 | 可接受——hook 回调签名是泛型的，入口断言符合"函数签名兼容性优先"偏好。但建议增加运行时校验（`if ('data' in bridgeData && 'sessionId' in bridgeData.data)`） |
| — | 命名 | 全文件 | `KEY_METADATA_MAP` 用 Record + 白名单模式管理 key 映射，良好实践 | 良好 |
| — | 结构 | 全文件 | 70 行，职责单一：监听 statusSetUpdate 事件，调用 UI API | 良好 |

**统计**: P0: 1 | P1: 1

---

### `src-electron/shared/src/protocol.ts`（290 行，新增 ~9 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| — | 类型 | — | `StatusBarItem` 新增 `scope` 和 `sessionId` 字段，与前端 `PluginStatusItem` 对齐 | 良好——共享类型作为契约 |
| — | 类型 | — | `StatusSetUpdatePayload` 新增 interface，字段完整 | 良好 |

**统计**: P0: 0 | P1: 0

---

### `src-electron/renderer/src/stores/plugin.ts`（287 行，新增 ~16 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| — | 结构 | — | `globalStatusBarItems` computed + `getSessionStatusBarItems()` 函数，关注点分离清晰 | 良好 |
| — | 类型 | — | 使用 `PluginStatusItem` 类型，无 `any` | 良好 |

**统计**: P0: 0 | P1: 0

---

### `src-electron/renderer/src/types/plugin.ts`（76 行，新增 ~2 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| — | 类型一致性 | — | `PluginStatusItem.scope` 和 `PluginStatusItem.sessionId` 与 shared `StatusBarItem` 对齐 | 良好 |
| P3 | 类型重复 | 跨文件 | `PluginStatusItem`（renderer/types/plugin.ts）与 `StatusBarItem`（shared/protocol.ts）结构高度相似，两份独立定义 | 理想情况下前端应 `extends` 或 `Omit<Pick<StatusBarItem, ...>>` 复用，但前端可能需要额外 UI 状态字段，当前分离可接受 |

**统计**: P0: 0 | P1: 0 | P3: 1

---

## 汇总

### 问题总数

| 优先级 | 数量 |
|--------|------|
| **P0（必须修复）** | **1** |
| P1（推荐修复） | 6 |
| P3（细节） | 1 |

### 必须修复（P0）

1. **`resources/plugins/statusline/index.ts` L1 — 插件 import 路径引用源码**
   - 路径 `../../../src-electron/runtime/src/services/plugin-service/plugin-types.js` 是源码相对路径，在构建/发布后不可解析
   - 修复方案：将 `PluginContext` 等 plugin API 类型提取到 `src-electron/shared/` 并通过包路径导入，或通过构建步骤处理路径映射

### 推荐修复（P1）

1. **`index.ts` L68-89 — `onContextUpdate` lambda 内嵌 22 行逻辑** — 提取为命名函数
2. **`plugin-service.ts` L425 — 默认优先级 `100`** — 提取常量
3. **`InputToolbar.vue` L87-90 — context 阈值 `85`/`60`** — 提取为命名常量
4. **`InputToolbar.vue` L76 — 魔法数字 `2.4`** — 提取或注释
5. **`InputToolbar.vue` L53-60 — bar 高度数字** — 已收敛为命名常量，可接受

### 跨文件重复

| 类型 | 位置 | 建议 |
|------|------|------|
| `PluginStatusItem` vs `StatusBarItem` | renderer/types/plugin.ts ↔ shared/protocol.ts | 结构高度相似但前端可能需要额外字段，当前分离可接受 |

### 正面评价

- **类型安全良好**：无 `any` 使用，所有新增类型定义完整（`StatusBarItemOptions`、`StatusSetUpdatePayload`）
- **职责分离清晰**：`InputToolbar`（输入行工具）/ `SessionStrip`（per-session 状态）/ `AppStatusbar`（全局状态栏）三组件各司其职
- **状态管理规范**：`plugin.ts` store 的 `globalStatusBarItems` / `getSessionStatusBarItems()` 分区查询设计良好
- **事件流设计**：`event-adapter → server → plugin-service → plugin hook → UI API → broadcast` 路径单向、清晰
- **错误处理**：`handleBridgeEvent` 的 `.catch` 有 `console.error`，`executeHooks` 有超时保护
- **组件行数**：所有 Vue 组件在 300 行限制内（最大 239 行 InputToolbar）

### 建议修复顺序

1. **P0**: 修复 statusline 插件的 import 路径（影响构建可移植性）
2. **P1**: `index.ts` 提取 `onContextUpdate` 逻辑为独立函数
3. **P1**: 魔法数字常量化（`100` → `DEFAULT_STATUS_BAR_PRIORITY`，`85`/`60` → 阈值常量）
