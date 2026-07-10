# Composer 历史导航与草稿持久化 spec

## Background

Composer 的 ↑/↓ 历史导航功能自 2026-06-05 chat-area-round1 起明确排除在范围外，后无声落地，未补 spec。当前规则散落在三处源码注释中（`useComposerHistory.ts` 文件头、`Composer.vue:327-349`、`useContenteditableInput.ts:60-86`），存在内部矛盾（注释声称"CDP 实测可靠"但实际有 bug），且多个已确认缺陷 + 未实现需求无 SSOT。

本 spec 统一历史导航 + 草稿持久化的行为规则，作为实现与测试的依据。

## Scope

### In Scope

| # | 需求 | 性质 |
|---|------|------|
| FR1 | ↑/↓ 视觉行导航（软换行 + 硬换行统一） | bug 修复 |
| FR2 | 历史翻阅光标定位（↑→首位，↓→末位） | 已实现，需固化规则 |
| FR3 | 草稿/历史回填保留换行（`\n` ↔ `<br>` 往返） | bug 修复 |
| FR4 | 跨 session 草稿持久化（per-session，切换保留） | 新功能 |

### Out of Scope

- 草稿磁盘持久化（关闭 app 后丢失，仅内存）
- chip 的草稿持久化（纯文本存储，slash/mention chip 在 session 切换时丢失）
- 草稿内容长度限制
- 跨 session 草稿的 import/export

## Glossary

| 术语 | 定义 |
|------|------|
| **视觉行** | 浏览器渲染的可见行，包括 soft-wrap（自动折行）产生的行和 hard-wrap（Shift+Enter `<br>`）产生的行。一段无换行的长文本在窄窗口下可占多个视觉行 |
| **逻辑行** | 文本中由 `\n` 分隔的行。soft-wrap 不产生逻辑行 |
| **edit 态** | 正常编辑状态，未在浏览历史 |
| **browsing 态** | 正在用 ↑/↓ 浏览历史消息，composer 内容为历史条目而非用户输入 |
| **H[index]** | 历史数组。`H[0]` = 最近一条已发送消息，`H[last]` = 最老一条。来源：`chatStore.messages[sessionId]` 中 `role==='user' && status==='complete'` 的 content，倒序，连续相同文本去重 |
| **草稿（draft）** | 用户在 composer 中输入但尚未发送的文本。属于特定 session |

## FR1: ↑/↓ 视觉行导航

### 前置条件

以下规则仅适用于**无修饰键**的纯 ArrowUp / ArrowDown（`!shift && !alt && !ctrl && !meta`）。带修饰键时放行浏览器原生行为（选区扩展、按词移动、段首段尾跳转等），不拦截。

IME 组合中（`e.isComposing === true`）不拦截任何键。

### 交互规则 — 三阶段模型

#### edit 态 ArrowUp

| 阶段 | 光标位置 | 行为 |
|------|---------|------|
| 1 | 不在第一视觉行 | 上移一个视觉行 |
| 2 | 在第一视觉行，但不在行首（文本绝对起始位置） | 移到行首（文本起始 position 0） |
| 3 | 在第一视觉行行首（文本起始 position 0） | 保存草稿 → 回填 H[0] → 进 browsing 态 → 光标定位首位 |

> 阶段 3 历史为空时不响应（光标不动，保持草稿）。

#### edit 态 ArrowDown

| 阶段 | 光标位置 | 行为 |
|------|---------|------|
| 1 | 不在最后视觉行 | 下移一个视觉行 |
| 2 | 在最后视觉行，但不在行末（文本绝对末尾位置） | 移到行末（文本末尾 position last） |
| 3 | 在最后视觉行行末（文本末尾 position last） | 不响应（光标不动） |

#### browsing 态 ArrowUp

| 条件 | 行为 |
|------|------|
| 未到最老一条（`index + 1 < H.length`） | `index++` → 回填 H[index] → 光标定位首位 |
| 已在最老一条 | 保持不动 |

browsing 态跳过阶段 1+2，↑ 直接翻历史（shell 行为）。

#### browsing 态 ArrowDown

| 条件 | 行为 |
|------|------|
| 未到最近一条（`index > 0`） | `index--` → 回填 H[index] → 光标定位末位 |
| 已在最近一条（`index === 0`） | 恢复草稿 → 退出 browsing 回 edit 态 → 光标定位末位 |

browsing 态跳过阶段 1+2，↓ 直接翻历史。

### 边界判定约束

**"第一视觉行行首"** = 光标在文本绝对起始位置（第一个文本节点 offset 0）。此时光标必然在第一视觉行。

**"最后视觉行行末"** = 光标在文本绝对末尾位置（最后一个文本节点末尾）。此时光标必然在最后视觉行。

**"不在第一/最后视觉行"** 的判定基于 `document.caretRangeFromPoint` 坐标查找：计算目标行 Y 坐标，查找该位置的光标落点，落点有效且与当前位置不同则为「已移动」。不依赖 `Selection.modify` 副作用（该 API 对软换行不产生跨行移动，见缺陷 1）。

### 软换行 vs 硬换行统一规则

两种换行方式的视觉行导航行为完全一致：
- **软换行（soft-wrap）**：长文本自动折行产生的视觉行，↑/↓ 在其间逐行移动
- **硬换行（Shift+Enter `<br>`）**：用户主动换行产生的视觉行，↑/↓ 同样在其中逐行移动

唯一差异：硬换行的文本在 getText/setText 往返时需保留 `\n`（FR3），软换行不涉及（`\n` 本就不存在）。

## FR2: 历史翻阅光标定位

| 操作 | 光标位置 | 理由 |
|------|---------|------|
| ↑ 翻到历史条目 | **第一视觉行行首**（文本起始 position 0） | 便于连续按 ↑ 回溯更老条目 |
| ↓ 翻到历史条目 | **最后视觉行行末**（文本末尾 position last） | 便于连续按 ↓ 回溯更新条目 |
| ↓ 恢复草稿 | **最后视觉行行末** | 与 ↓ 翻历史一致 |

光标定位必须下沉到文本节点内部（非元素节点边界），否则 `Selection.modify` 会先把光标"下沉"并误报 moved，导致边缘判定多按一次键。

## FR3: 文本往返保留换行

### 规则

`getText`（DOM → 纯文本）和 `setText`（纯文本 → DOM）必须对称：

| 方向 | 转换 | 当前状态 |
|------|------|---------|
| getText | `<br>` → `\n` | 已实现（`useContenteditableInput.ts:164-166`） |
| setText | `\n` → `<br>` | **未实现**（当前 `el.textContent = text`，`\n` 为字面字符不渲染） |

### 影响范围

setText 的 `\n → <br>` 修复影响所有调用方：

| 调用方 | 场景 | 修复效果 |
|--------|------|---------|
| `handleArrowUp` | 回填历史条目 | 多行历史消息保留换行 |
| `handleArrowDown` | 回填历史条目 | 同上 |
| `handleArrowDown` | 恢复草稿 | 多行草稿保留换行 |
| `restoreInput` | 发送失败恢复草稿 | 多行草稿保留换行 |
| FR4 草稿恢复 | session 切换回填 | 多行草稿保留换行 |

### 约束

- 禁止用 `innerHTML`（XSS 风险 + 项目规则禁用 v-html）
- 实现方式：按 `\n` 拆分文本，用 `document.createElement('br')` 交替拼接文本节点

## FR4: 跨 session 草稿持久化

### 需求

用户在 session A 输入内容但未发送，切换到 session B 时：
1. session A 的草稿保存
2. composer 清空，显示 session B 的草稿（B 无草稿则空）
3. 切回 session A 时，composer 恢复 session A 的草稿
4. 在 session B 时，composer 绝不展示 session A 的草稿

### 存储模型

per-session 草稿存储：`Map<sessionId, string>`（纯文本）。存储位置：store 层或独立 composable，不放在组件局部 ref（组件复用 + split 模式下需要跨实例共享）。

草稿内容 = `getText()` 返回的纯文本（含 `\n`，不含 chip DOM 节点）。chip 在 session 切换时丢失——已知限制。

### 切换行为

session 切换（`sessionId` prop 变化）时：

```
1. 保存旧 session 草稿：
   - edit 态 → draft = getText()
   - browsing 态 → draft = savedDraft（用户浏览前的实际输入，非历史条目）
2. 退出 browsing 态（browsing = false, index = 0）
3. 恢复新 session 草稿：
   - 新 session 有草稿 → setText(draft, 'end')，光标置末
   - 新 session 无草稿 → clear()
```

### 发送后清理

消息发送成功后，清空该 session 的草稿（`drafts.delete(sessionId)` 或 `drafts.set(sessionId, '')`）。

### 边界场景

| 场景 | 行为 |
|------|------|
| session 被删除 | 其草稿从 Map 中移除（垃圾回收） |
| app 重启 | 所有草稿丢失（仅内存，不持久化到磁盘） |
| 草稿含 chip | chip 丢失，仅保留纯文本（含 chip 的文本内容如 `/commit`） |
| browsing 态切换 session | 保存 savedDraft（非历史条目）作为草稿；切回时在 edit 态恢复草稿 |
| split 模式双 panel | 每个 panel 的 Composer 独立绑定各自 sessionId，草稿按 session 隔离，不串台 |

## 已知实现缺陷

### 缺陷 1: browsing 态跳过视觉行移动 + Selection.modify 跨行失效（FR1）[已修复]

**位置**：`Composer.vue` onKeydown + `useContenteditableInput.ts` moveCaretVerticalOf

**现象**：browsing 态下多行历史消息中按 ↑/↓ 直接翻历史，不逐行移动光标。

**根因（两层）**：
1. **Composer.vue `!isBrowsing.value` 守卫**（主因）：browsing 态下 `moveCaretVertical('up'/'down')` 被完全跳过，直接执行 `handleArrowUp/Down()` 翻历史。
2. **`Selection.modify('move', dir, 'line')` 跨行失效**（次因）：即使去掉 browsing 守卫，`'forward'/'backward'` 方向只在当前视觉行内水平移动（snap to line boundary），`'up'/'down'` 方向完全不移动。需要用 `document.caretRangeFromPoint` 坐标方案替代。

**修复**：
- 去掉 `!isBrowsing.value` 守卫，edit/browsing 态统一三阶段模型
- `moveCaretVerticalOf` 改用 `caretRangeFromPoint(textAreaLeft + 10, targetY)` 实现跨视觉行移动
- X 坐标用元素文本区左边缘（+10px 避开边界 quirks），不用 `caretRect.left`

### 缺陷 2: setText 不转换 \n → <br>（FR3）

**位置**：`useContenteditableInput.ts:427-463` `setText`

**现象**：浏览历史后按 ↓ 恢复草稿，或回填多行历史消息时，Shift+Enter 产生的换行消失（多行变一行）。

**根因**：`el.textContent = text` 将 `\n` 作为字面字符写入，contenteditable 中 `\n` 不渲染为换行（需 `<br>` 或块级元素）。

### 缺陷 3: 无跨 session 草稿持久化（FR4）

**位置**：`Composer.vue` 无 `watch(sessionId)`；`Panel.vue:86` `<Composer>` 无 `:key`

**现象**：session 切换时 composer 内容原样保留（看到上个 session 的未发送文本）。

**根因**：输入文本绑定在组件局部 ref（`Composer.vue:155 draft`），session 切换时无保存/恢复逻辑。

### 缺陷 4（非本次 bug，记录备忘）：useComposerHistory 的 savedDraft 与 FR4 草稿的关系

`useComposerHistory.ts:70` 的 `savedDraft` 是历史导航内部状态（进 browsing 前保存，回 edit 时恢复），与 FR4 的跨 session 草稿是不同概念。FR4 实现时需协调两者：browsing 态下 session 切换应保存 savedDraft（用户实际输入）而非 getText()（历史条目）。

## 涉及文件

| 文件 | 角色 |
|------|------|
| `packages/renderer/src/components/panel/Composer.vue` | 按键路由 + 草稿 ref + session 切换钩子（FR1/FR4） |
| `packages/renderer/src/components/panel/ComposerInput.vue` | contenteditable 模板 + ref 转发 |
| `packages/renderer/src/composables/panel/useContenteditableInput.ts` | moveCaretVerticalOf + getText + setText（FR1/FR3） |
| `packages/renderer/src/composables/panel/useComposerHistory.ts` | 历史状态机 + browsing 态（FR1/FR2） |
| `packages/renderer/src/components/panel/Panel.vue:86` | Composer 挂载点（FR4：可能需要 :key 或 session 切换处理） |
