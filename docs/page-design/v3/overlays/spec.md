# 搜索浮层 · 全局 Overlay（设计规范）

**类型**: L0 Shell · Overlay 级组件
**关联**: architecture-and-terminology §1（Search Modal 归 Overlay）、shell/spec.md（⌘K 全局快捷键 + Sidebar nav `.a-kbd` 提示）、sidebar/spec.md（搜索「触发入口」归属，浮层本体不归属 Sidebar）、design-tokens.md、design-system.md §2（Card-Active inset ring）
**配套 HTML**: `draft-search-modal.html`（七节探索稿，含真实可交互 ⌘K 浮层）
**术语源**: 规范名以 architecture-and-terminology §1 为准。

## 背景

Search Modal 原嵌在 `sidebar/draft-five-states.html` 的「卡 D」里，导致「容器内子视图」与「全局浮层」两种性质的东西混在同一画板、术语越界。术语裁决后明确：Search Modal 是 **L0 Shell 的 Overlay 级组件**——⌘K 触发、模糊遮罩 + 居中浮层，浮于 Sidebar / Workspace / Workspace 顶栏之上，**不归属任何 Region**。Sidebar 仅保留「搜索」**触发入口**（nav 项 + ⌘K）。本 spec 把这层契约固化。

## 归属与边界（P0）

| 项 | 搜索浮层（⌘K） | File View 树内搜索 |
|---|---|---|
| **归属** | L0 Overlay（独立组件） | Sidebar 容器内 · File View 子视图的一部分 |
| **入口** | `⌘K` / Ctrl+K / Sidebar「搜索」nav 项 | File View 顶部的内联过滤输入框 |
| **范围** | **全局·跨项目**：命令 + 文件 + 符号 + 会话 | **当前 active session** 的改动文件树 |
| **形态** | 模糊背景 + 居中浮层（模态） | 内联，无浮层（收窄树本身） |
| **结果** | 分组列表 + 跳转到任意 Region | 原树按查询过滤（保留层级缩进） |
| **匹配** | 模糊 + 子串高亮 | 子串过滤（命中保留，未命中折叠） |
| **关闭** | Esc / 再按 ⌘K / 点遮罩 | 清空输入框即恢复全树 |

> **为何必须分两条**：模糊全局检索（找「我上次那个 auth 的会话在哪」）与当前会话改动文件收窄（「这次改动有没有动到 token.ts」）是**两个心智任务**。合并会导致：模态打断当前编辑流，或树过滤无法跨项目/跨类型。保留两条独立路径，各自最短。

## 四类分组

结果按类型分组展示，顺序固定：

| 类型 | 图标语义 | 数据源 | 跳转目标 |
|---|---|---|---|
| **命令**（command） | 动作类 | 命令注册表（与 Sidebar nav 共享 `⌘N/⌘K` 注册） | 直接执行（危险命令如「终止任务」二次确认，复用 Flow-3 机制） |
| **文件**（file） | 文件类 | 项目索引（LSP / ripgrep 后端） | Workspace 打开并定位 |
| **符号**（symbol） | 符号类 | 项目索引（LSP） | Workspace 打开并定位到符号 |
| **会话**（session） | 会话类 | 本地会话库 | 切换 active session（可带 `?focus=overview` 进概览） |

> **[BACKFED from clarity on 2026-06-30]** 上表为 v3 UI 形态原始设计。需求澄清（`.xyz-harness/2026-06-30-search-modal/`）已对以下项做出决策调整，实现以 requirements.md 为准：
> - **文件数据源**：原「项目索引（LSP / ripgrep 后端）」→ 复用 runtime 现有 `file-service.searchFiles` 全递归（D-003，不引 LSP/ripgrep）
> - **文件跳转**：原「Workspace 打开并定位」→ DetailPane 打开预览（D-006，复用 file.read + useDetailPane）
> - **符号数据源**：原「项目索引（LSP）」→ 降级占位，显示「需要语言服务，暂不可用」（D-001）
> - **会话跳转**：原「可带 ?focus=overview 进概览」→ 本期只切换 active session，不进概览（D-010）
> - **危险命令**：见下方「边缘状态」表，本期不做二次确认（D-008）

## 状态

| 态 | 触发 | 内容 |
|---|---|---|
| **默认（recents）** | 唤起且查询为空 | 按类展示最近项（每类 5 / 共 20，待定见遗留） |
| **查询分组** | 输入查询、命中 | 四类分组 + 命中计数 + 子串高亮 |
| **类型过滤** | Tab 切类 / `⌘1…⌘5`（待定） | 只显所选类，其余折叠 |
| **空结果** | 查询无命中 | 空态插画 + 提示文案 + 建议操作 |
| **加载** | 索引查询 >200ms | 骨架/加载条（<200ms 不显，避免闪烁） |

## 键盘契约

| 键 | 行为 |
|---|---|
| `⌘K` / `Ctrl+K` | 唤起 / 再按关闭（平台自动检测：mac 用 `Meta`，win/linux 用 `Ctrl`） |
| `Esc` | 关闭（直接关闭，非先清空查询——见遗留①） |
| `↑` / `↓` | 跨组扁平化移动选中项 |
| `Enter` | 确认当前选中项（执行/跳转），成功后 toast 反馈 |
| `Tab` / `Shift+Tab` | 循环切类（正向/反向） |
| `Home` / `End` | （可选）跳首/跳尾，待定 |

唤起即 `focus()` 输入框、光标置末尾。输入走 `debounce(120ms)` 再查索引。

## 实现要点

- **z-index**：浮层 `1000`，遮罩同层；确认 toast `1100`。高于 Sidebar / Workspace / Workspace 顶栏，低于系统 traffic-light（OS 绘制）。
- **快捷键拦截**：renderer 全局监听 `keydown`（capture phase），`preventDefault` 拦截浏览器默认行为。
- **选中态**：用 design-system §2 的 **Card-Active inset ring**（`box-shadow: inset 0 0 0 1px accent-ring`），**禁用左色条**（AI slop 反模式）。↑↓ 移动时用 `scrollIntoViewIfNeeded` 或手动 `offsetTop` 计算（避免 OD 预览嵌套 iframe 的滚动冲突，不直接用 `scrollIntoView`）。
- **匹配高亮**：后端返回命中区间数组，前端渲染为 `<mark class="hl">`（`color:accent`，不加背景，避免打断阅读节奏）。
- **无障碍**：`role="dialog"` + `aria-modal="true"`；打开时 trap focus 在浮层内，关闭后焦点还给触发元素（Sidebar「搜索」nav 项或当前 active 区）。结果列表 `role="listbox"`，项 `role="option" aria-selected`。
- **性能**：结果虚拟化仅在单类 >200 项时启用（默认全量渲染，简单优先）；分组头 sticky 便于长列表定位。

## 边缘状态与已知限制

| 场景 | 处理 |
|---|---|
| 模态打开时背景区可点 | 点遮罩关闭；浮层内部点击不冒泡 |
| 危险命令命中（终止任务） | 不直接执行，二次确认（复用 Flow-3 确认请求机制） |

> **[BACKFED from clarity on 2026-06-30]** 危险命令二次确认本期不做（D-008）。xyz-agent 当前无真正「危险命令」，所有命令选中即执行。后续有终止任务/删除会话等命令时再加 danger 标记 + 二次确认。
| 跨项目检索范围切换 | 待定（见遗留③） |
| recents 与查询结果冲突 | 有查询时隐 recents，查询清空恢复 |

## 遗留

1. **Esc 行为**：首次清空查询 / 二次关闭 vs 直接关闭——当前采「直接关闭」（更短路径），待实机验证误触率。
2. **`⌘1…⌘5` 直达类型**：与 OS 或其它面板快捷键冲突待核；不冲突则采纳。
3. **跨项目检索范围**（当前项目 / 全部项目）：进 scopes 条还是独立开关，待定。
4. **recents 持久化**：策略与上限（建议每类 5 / 共 20），待定。
