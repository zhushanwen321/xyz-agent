# W06 (B-SB) · Sidebar 多余/遗留审查结果

> 审查日期：2026-06-21 | 执行员：W06 | 区域：Sidebar L2-L3
> 审查模式：自底向上（Render 实现 → 找多余），双证据判定
> 审查范围：Sidebar.vue / SessionList.vue / SessionItem.vue / SegmentedTab.vue（4 文件）
> 不重复：W05 已记录的 4 个问题（SB-L2-02/04/05/06）

---

## 一、Wave 汇总表

| ID | 层 | 区域.模块 | 组件/锚点 | 判定 | 设计来源 | 实现位置 | 根因标签 |
|----|----|----------|----------|------|---------|---------|---------|
| SB-L3-01 | L3 | Sidebar.SessionList | `void props` lint 规避标记 | 🆕多余 | — | SessionList.vue:54 | 孤立 |
| SB-L3-02 | L3 | Sidebar.SessionItem | Props 类型内联重复 SessionSummary | 🆕多余 | shared/types SessionSummary | SessionItem.vue:47-54 | 孤立（类型碎片化） |
| SB-L3-V01 | L3 | Sidebar.SessionItem | RC-07 验证：状态点数据来源 | ✅一致 | W01 RC-07 | SessionItem.vue:46→Sidebar.vue:94→useSidebar.derivedStatus | 根因关联→RC-07（无害） |
| SB-L3-V02 | L3 | Sidebar.* | 全 4 文件：无未使用 import | ✅一致 | — | 逐个 verify（见 §三.负向验证） | — |
| SB-L3-V03 | L3 | Sidebar.* | 全 4 文件：无 shadcn 模板残留 | ✅一致 | — | Button/ScrollArea 为 Reka UI 项目组件 | — |
| SB-L3-V04 | L3 | Sidebar.* | 全 4 文件：无旧设计残留 | ✅一致 | v3 tokens | 全语义色（bg-accent/text-fg 等） | — |
| SB-L3-V05 | L3 | Sidebar.* | 全 4 文件：无死分支/注释死代码 | ✅一致 | — | 仅 G2-003/G-022 defer 标记（有意） | — |

---

## 二、RC-07 验证结论

### 调用链追踪

```
SessionItem.vue:46  dotClass ← props.status
                           ↑
SessionList.vue:12  :status="statusOf(s.id)"
                           ↑
Sidebar.vue:94      statusOf(id) = derivedStatus(id).value
                           ↑
Sidebar.vue:94      const { derivedStatus } = useSidebar()
                           ↑
useSidebar.ts:      derivedStatus(id) → computed → deriveStatus(id, chat, isStreaming)
                           ↑
deriveStatus()      chat.getMessages(sessionId) → 读消息实数据 → 派生 5 态
```

### 结论

**SessionItem 不受 RC-07 影响。** 状态点数据流为：

`useSidebar().derivedStatus(id)` → `deriveStatus()` → `chat.getMessages(sessionId)` → 读实际消息派生 running/waiting/done/stopped/error。

`sessionStore.derivedStatus(id)`（恒返回 `computed(() => 'waiting')`）**全项目零调用**（renderer 源码全量 grep 确认），是 RC-07 的根因本体——僵尸代码，但对 sidebar 渲染无任何影响。

**根因关联标注**：`sessionStore.derivedStatus` → 关联 RC-07，但本次审查的 4 个文件**无受害点**。

---

## 三、条目详情卡

### [SB-L3-01] SessionList.vue: `void props` lint 规避标记

- **层级位置**：L3 · Sidebar.SessionList
- **设计要求**：无直接设计要求。Vue `<script setup>` 中 props 在模板自动可用，script 块无需显式引用。
- **实现现状**：SessionList.vue:54 `void props` — props 已在模板使用（`:sessions="sessions"`, `:active-id="activeId"`, `@select="emit('select', $event)"`），但 `<script setup>` 块内无 `props.xxx` 引用，故加 `void props` 压制 lint 报错。
- **判定**：🆕多余
- **差异描述**：`void props` 是规避代码而非修复代码。正确做法是调整 lint 规则使其理解 Vue `<script setup>` 的模板绑定（eslint-plugin-vue 的 `no-unused-vars` 通常已处理此场景，若未生效应修复配置）。
- **设计证据**：无设计 spec 涉及此模式。项目 CLAUDE.md 编码规范未提及 `void props` 为合法模式。
- **实现证据**：

```typescript
// SessionList.vue:47-55
const props = defineProps<{
  sessions: SessionSummary[]
  activeId: string | null
  statusOf: (id: string) => DerivedStatus
}>()

// 显式声明 props 已读（避免某些 lint 规则误报未使用）。
void props
```

- **初步根因**：孤立问题。lint 配置未正确识别 Vue `<script setup>` 模板引用。
- **修复性质**：短期方案 · 治标：删除 `void props` 行，验证 ESLint 不报错（eslint-plugin-vue 应已处理）。若仍报错，修复 lint 规则而非加规避代码。

---

### [SB-L3-02] SessionItem.vue: Props 类型内联 vs SessionSummary 不一致

- **层级位置**：L3 · Sidebar.SessionItem
- **设计要求**：shared 类型 `SessionSummary`（`@xyz-agent/shared`）是 session 摘要的权威类型定义。同一目录下 SessionList.vue 已正确使用。
- **实现现状**：SessionItem.vue:47-54 的 `session` prop 内联定义 `{id, label, cwd, gitBranch?, lastActiveAt}`，与 `SessionSummary` 字段高度重叠（仅少 `createdAt` 字段）。未 import `SessionSummary`，未复用 shared 类型。
- **判定**：🆕多余
- **差异描述**：同一 sidebar 目录内，SessionList.vue 用 `SessionSummary` 类型，SessionItem.vue 用内联类型——同一数据源（`session.list: SessionSummary[]`）在相邻组件中被两种类型描述。内联类型是 shared 类型的子集重复，未来 `SessionSummary` 增字段时不编译报错→静默漂移。
- **设计证据**：

```typescript
// shared/src/session.ts:3 — SessionSummary 全量字段
// id, label, cwd, gitBranch?, gitIsWorktree?, status,
// lastActiveAt, modelId, thinkingLevel?, tokenCount

// SessionList.vue:37 — 正确使用 shared type
import type { SessionSummary } from '@xyz-agent/shared'
const props = defineProps<{ sessions: SessionSummary[]; ... }>()
```

- **实现证据**：

```typescript
// SessionItem.vue:47-54 — 手工摘取子集，未 import SessionSummary
const props = defineProps<{
  session: {
    id: string        // ← SessionSummary 子集
    label: string
    cwd: string
    gitBranch?: string
    lastActiveAt: number
    // 省略：gitIsWorktree, status, modelId, thinkingLevel, tokenCount
  }
  active: boolean
  status: DerivedStatus
}>()
```

- **差异描述**：SessionItem 内联类型是 `SessionSummary` 的 5/11 字段子集（手工 Pick）。同一目录 SessionList 用 `SessionSummary` 全量——数据源相同（`session.list: SessionSummary[]`），类型源不同。风险：未来 `SessionSummary` 增字段时编译不报错，SessionItem 静默不渲染。
- **初步根因**：孤立问题（类型碎片化苗头）。非架构问题，纯属未同步。
- **修复性质**：短期方案 · 治本：`import type { SessionSummary }`，prop 直接 `session: SessionSummary`（或用 `Pick<>` 显式摘取——语义更清晰但代码量不变）。推荐直接用全量：Vue props 解构不增运行时开销，多余字段无害。

---

## 四、负向验证清单（逐文件逐项确认无问题）

以下 5 类"可能多余"经全量扫描**未发现**实例，记录为 ✅ 供阶段 C 聚合。

| 检查项 | Sidebar.vue | SessionList.vue | SessionItem.vue | SegmentedTab.vue |
|--------|------------|-----------------|-----------------|------------------|
| 未使用 import | ✅ 全部使用 | ✅ 全部使用 | ✅ 全部使用 | ✅ 全部使用 |
| 未使用 props/emits | ✅ 无 props | ✅ 全部使用 | ✅ 全部使用 | ✅ 全部使用 |
| 未使用变量/computed | ✅ 全部使用 | ✅ 无本地变量 | ✅ 全部使用 | ✅ `tabs` computed 使用 |
| 死模板分支（v-if 恒假） | ✅ A/B 态均可达 | ✅ 空/非空均可达 | ✅ active/gitBranch 均可达 | ✅ 两 tab 均可选 |
| shadcn 模板残留 | ✅ 无 | ✅ 无 | ✅ 无 | ✅ 无 |
| 旧设计 Token（warm/soft） | ✅ v3 语义色 | ✅ v3 语义色 | ✅ v3 语义色 | ✅ v3 语义色 |
| 硬编码颜色 | ✅ 无 | ✅ 无 | ✅ 无 | ✅ 无 |
| Emoji | ✅ 无 | ✅ 无 | ✅ 无 | ✅ 无 |
| 无用 `<style scoped>` | ✅ 无 style 块 | ✅ 无 style 块 | ✅ 无 style 块 | ✅ 无 style 块 |
| 无用生命周期钩子 | ✅ onMounted 使用 | ✅ 无 | ✅ 无 | ✅ 无 |
| 无用 defineExpose | ✅ 无 | ✅ 无 | ✅ 无 | ✅ 无 |

**关键依赖验证**：
- `@lucide/vue` (`^1.21.0`) — renderer/package.json 已声明，22+ 文件使用，非 typo
- `@vueuse/core` (`^11.3.0`) — renderer/package.json 已声明，`useEventListener` 正常使用
- `Button` / `ScrollArea` — Reka UI (`reka-ui`) 项目组件，非 shadcn 直接复制

**注释/defer 标记**（有意保留，非多余）：
- Sidebar.vue:1-7 — 容器组件设计文档注释
- Sidebar.vue:72 — `G2-003 deferred` 占位（已知 W05 SB-L2-04）
- Sidebar.vue:5 — `DEFERRED hide G-022` 搜索入口（已知 W05 SB-L2-06）
- SessionList.vue:1-4 — 展示组件设计文档注释
- SessionItem.vue:1-5 — 组件设计文档注释 + `DEFERRED` 右键操作标记
- SegmentedTab.vue:1-5 — 展示组件设计文档注释

---

## 五、Wave 小结

- **审查条目数**：7（✅ 5 / ⚠ 0 / ❌ 0 / 🆕 2）
- **RC-07 验证结论**：SessionItem 状态点数据来源为 `useSidebar().derivedStatus(id)` → `deriveStatus()` → `chat.getMessages()`，**不受 RC-07 影响**。`sessionStore.derivedStatus` 全项目零调用，是 RC-07 根因僵尸代码，但对 sidebar 渲染无任何影响。
- **新独立问题数**：2
  - **SB-L3-01**：SessionList.vue `void props` lint 规避标记 — 低影响，可秒删
  - **SB-L3-02**：SessionItem.vue 类型内联 vs SessionSummary — 低风险，类型碎片化苗头

- **跨 Wave 依赖提示**：
  - 无跨 Wave 依赖。本 Wave 发现的两个问题均为本文件即可修复的孤立问题。
  - `sessionStore.derivedStatus` 僵尸代码（RC-07 根因本体）建议阶段 C 统一清理，不属单个 Wave 范围。

- **整体评价**：Sidebar 4 文件的代码质量较高——无未使用 import、无死分支、无旧设计残留、无 shadcn 模板污染。仅 2 个微小遗留项（lint 规避 + 类型内联），修复成本极低。W05 已记录的功能缺失（FileView 内容、搜索入口）均为已知 deferral，不属"多余"范畴。
