---
verdict: fail
must_fix: 1
review_metrics:
  files_reviewed: 12
  dimensions_checked: 6
  issues_found: 11
  must_fix_count: 1
  low_count: 6
  info_count: 4
  duration_estimate: "15"
---

# Robustness Review v2 — chat-area-round1

## 审查记录

- 审查时间：2026-06-05 17:50
- 审查员：Robustness Reviewer (skill: `xyz-harness-robustness-reviewer`)
- 审查范围：`git diff 5858876..HEAD` — 10 fix commits + 1 lint cleanup + 1 docs commit
- 审查文件数：12（与 v1 相比新增 `stores/layout.ts`、修改 5 个新增/改动）
- 核心任务：**v1 → v2 回归复审**，重点验证 5 个 MUST_FIX 是否完整修复，并对 6 个未修 LOW/INFO 维持 v1 评级
- 配套审查：BLR v2（待对照）、TS-Taste v2（待对照）

## v1 → v2 MUST_FIX 验证表

| v1 编号 | 描述 | 修复位置 | 验证结果 | 证据 |
|---------|------|----------|----------|------|
| **R#1** | `clipboard.ts` 空 catch | `lib/clipboard.ts:31-38` | ✅ **已修复** | `console.error('[clipboard] writeText failed:', e)` + `description: e instanceof Error ? e.message : '无法访问剪贴板'`（commit `221bcaf`） |
| **R#2** | `MessageActionMenu` 缺 Esc 关闭 | `MessageActionMenu.vue:15-16, 128-152` | ✅ **已修复** | (1) `tabindex="-1" @keydown.esc="$emit('close')"` 在 menu 根 div 上；(2) `onMounted` 注册 `document.addEventListener('keydown', handleKeydown)` 兜底；(3) `onUnmounted` 清理 listener 防内存泄漏；(4) `props.visible` guard 防误触发（commit `558ec70`） |
| **R#3** | `tree-message-handler` payload 校验 | `tree-message-handler.ts:19-25, 47-50, 62-65` | ✅ **已修复** | (1) `if (!sid)` fail-fast（顶层 guard）；(2) `if (!targetEntryId)` fail-fast；(3) `if (!entryId)` fail-fast；全部返回结构化 `*Result` 消息 + `error` 字段（commit `804f6e9`） |
| **R#4** | `MessageActionMenu` 静默 no-op（`getMessageEl` 返回 null） | **未修改** | ❌ **未修复** | `handleCopy` (L91-98) / `handleCopyPlain` (L100-107) 仍为 `if (el) { ... }` 模式，`el === null` 时静默 `emit('close')` 无 Toast。**修复摘要中 11 项列表未包含 R#4，被完全遗漏** |
| **R#5** | `server.ts` `message.steer/follow_up` 错误反馈 | `server.ts:292-317` | ✅ **已修复** | (1) `message.steer` 内 try/catch + 失败发送 `message.error`（L297-304）；(2) `message.follow_up` 同样 try/catch + `message.error`（L306-316）；(3) abort catch 由 `console.log` 升级为 `console.warn`（v1 R#9 一并修复，commit `19909f3`） |

**修复率：4/5（80%）** — R#4 仍为未修复 MUST_FIX，必须回归。

## 维度评分概览

| 维度 | 检查项数 | 通过 | 问题 | 评分 | v1 → v2 变化 |
|------|---------|------|------|------|--------------|
| D1 错误处理 | 14 | 9 | 5 | 6.0/10 | 持平偏下（R#4 未修 + ChatPanel copyBatchAs 新增 silent no-op） |
| D2 异常处理 | 8 | 7 | 1 | 8.0/10 | 显著改善（clipboard.ts 空 catch 已修） |
| D3 日志 | 7 | 6 | 1 | 8.5/10 | 改善（server.ts console.log → warn + 多个 console.error 落位） |
| D4 Fail-fast | 10 | 9 | 1 | 8.5/10 | 改善（tree-message-handler 三处 guard） |
| D5 测试友好性 | 4 | 3 | 1 | 7.5/10 | 持平（BranchIndicator prop 化是改善） |
| D6 调试友好性 | 8 | 6 | 2 | 7.0/10 | 改善但引入新问题（response type 不一致） |

**总评分：7.5 / 10**（v1: 6.8）— 整体健壮性显著改善，但 R#4 阻断通过。

## 问题清单（合并同位置）

| # | 严重度 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|------|------|------|------|---------|
| 1 | **MUST_FIX** | D1, D3, D4, D6 | `MessageActionMenu.vue:91-107` `handleCopy` / `handleCopyPlain` 仍维持 v1 的 `if (el) { ... }` 静默 no-op 模式。当 `getMessageEl()` 返回 `null`（message 已卸载、用户快速操作、entryId 不在 DOM），用户点击"复制"/"复制纯文本"**完全无任何反馈**（无 Toast、无 console.warn）。v1 review 已标记 MUST_FIX，修复摘要的 11 项 fix 列表中**未包含此项**，属于遗漏。**注意**：由于 v1 R#4 描述中 "用户点击 复制 完全无反馈" 的现象在 v2 中**仍然 100% 存在**，用户使用期间可触发 | `src-electron/renderer/src/components/chat/MessageActionMenu.vue` | 91-107 | 改为 `const el = getMessageEl(); if (!el) { emit('toast:show', { type: 'danger', title: '无法复制', description: '消息已不在视图中' }); emit('close'); return }; const text = collectMessageContent(el, { format: 'markdown' }); await copyWithToast(text, { format: 'markdown' }); emit('close')` |
| 2 | LOW | D1, D4, D6 | `ChatPanel.vue:393-395` `copyBatchAs` 内 `if (elements.length === 0) return` 静默 no-op：当用户选中 N 个 message 后在 0 个 DOM 元素被找到的场景（消息被过滤、删除、DOM 卸载）点击"Copy Markdown"无反馈。这与 R#4 是**同一类问题在新功能中的复制**——v1 review 强调过 fail-fast + 用户反馈并重的设计原则 | `src-electron/renderer/src/components/panel/ChatPanel.vue` | 393-395 | 改为 `if (elements.length === 0) { await copyWithToast('', { format }) /* 空字符串会触发 clipboard 错误 + Toast */ ; return }` 或独立 emit('toast:show', { type: 'danger', title: '复制失败', description: '所选消息已不在视图中' }) |
| 3 | LOW | D4, D6 | `tree-message-handler.ts:23-25` 顶层 `if (!sid)` fail-fast 始终返回 `type: 'session.tree-fork-result'`，**与原始消息类型不匹配**：若 client 发送 `session.tree-navigate` 且缺失 sid，response 是 `session.tree-fork-result` 类型，type-based dispatch 错误。修复时为简化只选用了一种 type | `src-electron/runtime/src/tree-message-handler.ts` | 23-25 | 改为按 `msg.type` 分发：'session.tree-data' → 'session.tree-data'，'session.tree-navigate' → 'session.tree-navigate-result'，'session.tree-fork' → 'session.tree-fork-result' 等。或在 payload 加 `requestedType` 字段 |
| 4 | LOW | D4, D6 | `App.vue:347-348` `onFullscreenChanged` IPC 回调才同步 `layoutStore.setFullscreen()`，初始 `isFullscreen = false`。**首屏竞态**：用户在 macOS 全屏模式下启动 app，sidebar 渲染用 `--sidebar-w` 但渲染后才收到 IPC，sidebar 样式有几百毫秒不一致。生产环境偶发可观察 | `src-electron/renderer/src/App.vue` + `stores/layout.ts` | 347-348 | `stores/layout.ts` 暴露 `requestInitialState()` 方法，在 App.vue `onMounted` 中 `await window.electronAPI?.getFullscreenState?.()` 主动查询一次（需后端 IPC 配合） |
| 5 | LOW | D6, INFO | `ChatPanel.vue:240-244, 273-279, 287-291` `forceScrollToBottom` / `handleScrollToTop/Bottom` / 自动滚动 watch 全部改 `behavior: 'smooth'`。**UX 副作用**：session 切换时用户期望"瞬时跳到最新消息"，smooth 滚动 300-500ms 期间用户可能看到中间消息（视觉抖动）。v1 行为是 `el.scrollTop = el.scrollHeight` 瞬时 | `src-electron/renderer/src/components/panel/ChatPanel.vue` | 240-244 | `forceScrollToBottom` 中改为 `el.scrollTop = el.scrollHeight`（瞬时），保留 Utility Rail 的 smooth 用于用户主动点击 |
| 6 | LOW | D3 | `tree-message-handler.ts:18` `payload.sessionId` 类型从 `string` 改为 `string?` 是 fail-fast 的必要放宽，但下游 `getSummary`/`navigateTree`/`forkFromEntry` 等仍接受 `string` 参数；TS 编译通过（`!` 断言未使用，靠 narrowed `sid` 字符串），但可读性下降 | `src-electron/runtime/src/tree-message-handler.ts` | 18 | 提取 `function getSid(msg: ClientMessage): string | null` 守卫函数集中校验；下游 `if (!sid) return` 一处即可 |
| 7 | LOW | D5 | `ChatPanel.vue:386` `document.querySelector(\`[data-entry-id="${id}"]\`)` 与 `MessageActionMenu.vue:84` `getMessageEl` 是**重复实现的 DOM 查询逻辑**。当 data-entry-id 选择器语义改变时需同步两处 | `src-electron/renderer/src/components/panel/ChatPanel.vue` | 386 | 提取 `lib/dom-query.ts` 暴露 `findMessageEl(entryId: string): HTMLElement | null` 统一实现 + 加 data-timestamp 解析 |
| 8 | INFO | D5 | `MessageActionMenu.vue:84-86` 仍维持 `document.querySelector` 跨组件查 DOM（v1 R#13）。`useTreeStore` / `useSession` composable 已有 session-aware 抽象，未利用 | `src-electron/renderer/src/components/chat/MessageActionMenu.vue` | 84-86 | 暴露 `useMessageEl(entryId)` composable，在 store 中缓存 el 引用；或通过 `ref` 注入 |
| 9 | INFO | D6 | `tree-message-handler.ts:42, 56, 73, 87` 错误信息如 `'Session not active'` / `'Session not available'` 不含 `sessionId`（v1 R#15），客户端 Toast 仍难以定位哪个 session 失败。`!sid` 路径已含 sid（在 `payload.sessionId` 不存在时返回 `'sessionId required'` 是合适的），但下游 not-found 分支仍用静态字符串 | `src-electron/runtime/src/tree-message-handler.ts` | 42, 56, 73, 87 | 改为 `\`Session ${sid} not active\`` 等模板字符串 |
| 10 | INFO | D3 | `server.ts:302, 313` `console.error('[runtime] message.steer/follow_up sendMessage failed:', errMsg)` 使用了 `errMsg` 变量名（已 from `e instanceof Error ? e.message : String(e)`），但未包含 `msg.id` 和 `steerSid/followSid`。多会话并发时调试无法关联到具体请求 | `src-electron/runtime/src/server.ts` | 302, 313 | 改为 `console.error(\`[runtime] message.steer sendMessage failed (id=${msg.id} sid=${steerSid}):\`, errMsg)` |
| 11 | INFO | D6 | `MessageActionMenu.vue:128-130` `handleKeydown` 函数对 `props.visible` 的判断虽然正确，但 `document.addEventListener('keydown', handleKeydown)` 在菜单未打开时也会注册监听（只要组件 mount），意味着任何 Esc 键都会调用 `handleKeydown` 然后被 `props.visible` 守卫拦截。**低效但正确**——长期可考虑在 visible=true 时才 addEventListener | `src-electron/renderer/src/components/chat/MessageActionMenu.vue` | 128-130 | 性能优化（仅在 visible=true 时注册）；或保持现状（守卫成本 < 监听注册成本） |

## v1 未修问题追踪

| v1 编号 | 描述 | 状态 |
|---------|------|------|
| v1 R#6 (LOW) | `session-service.renameSession` 静默 no-op | 仍未修（不在 v2 fix scope） |
| v1 R#7 (LOW) | `tree-service` `labelSuffix` 误导性参数 | 仍未修（不在 v2 fix scope） |
| v1 R#8 (LOW) | `tree-service` 错误 catch 无 console.error | 仍未修（不在 v2 fix scope） |
| v1 R#9 (LOW) | `server.ts` abort `console.log` → `console.warn` | ✅ **v2 R#5 修复时一并修** |
| v1 R#10 (LOW) | `collectMessageContent` messageEl null 校验 | 仍未修（不在 v2 fix scope） |
| v1 R#12 (INFO) | `MessageActionMenu` document.querySelector 跨组件 | 仍未修（v2 新增 #8） |
| v1 R#13 (INFO) | `tree-message-handler` 错误信息不含 sessionId | 仍未修（v2 新增 #9） |

**v1 11 项问题中 5 个 MUST_FIX 完成 4 个，2 个 LOW 顺手修完成 1 个（R#9）；6 个 v1 LOW/INFO 全部遗留。** v2 阶段未引入新 MUST_FIX（仅 1 个 R#4 未修 + 1 个 ChatPanel copyBatchAs 新增 LOW 同类问题）。

## 逐文件详情

### `src-electron/renderer/src/lib/clipboard.ts`

**D1 错误处理:** ✅ L31-38: catch 块保留原始 `e`，Toast 显示真实错误信息
**D2 异常处理:** ✅ L31: `catch (e)` 捕获具体错误，不再空 catch
**D3 日志:** ✅ L33: `console.error('[clipboard] writeText failed:', e)` 含 stack trace
**D4 Fail-fast:** N/A
**D5 测试友好性:** ✅ 无回归
**D6 调试友好性:** ✅ L35: 错误信息保留上下文

**结论:** R#1 完全修复。

---

### `src-electron/renderer/src/components/chat/MessageActionMenu.vue`

**D1 错误处理:**
- ❌ L91-98: `handleCopy` `if (el) { ... }` 静默 no-op — R#4 **未修复**
- ❌ L100-107: `handleCopyPlain` 同上 — R#4 **未修复**

**D2 异常处理:**
- ✅ L15-16: 模板 `@keydown.esc` 显式处理
- ✅ L132-141: `handleKeydown` 函数 + `props.visible` guard
- ✅ L142-150: `onMounted`/`onUnmounted` 对称 add/remove listener

**D3 日志:** N/A (UI 组件)
**D4 Fail-fast:**
- ❌ L91-98, 100-107: silent no-op 路径

**D5 测试友好性:**
- ⚠️ L82-86: 仍用 `document.querySelector` 跨组件（INFO）

**D6 调试友好性:**
- ❌ 用户点击"复制"若 message 不在 DOM 无任何反馈
- ✅ L132: handleKeydown 有详细注释

**结论:** R#2 ✅，R#4 ❌。

---

### `src-electron/runtime/src/tree-message-handler.ts`

**D1 错误处理:** ✅ 多处 catch 块结构化
**D2 异常处理:** ✅ L23-25, 47-50, 62-65: 三处 fail-fast
**D3 日志:** ✅ L39: `console.error('[tree-data] auto-restore failed:', restoreErr)`
**D4 Fail-fast:** ✅ 顶层 + 分支级双层 guard；⚠️ L23 response type 不一致（LOW #3）
**D5 测试友好性:** ✅ 无回归
**D6 调试友好性:** ⚠️ 错误信息不含 sessionId（INFO #9）

**结论:** R#3 完全修复，附带 2 个 LOW/INFO 建议。

---

### `src-electron/runtime/src/server.ts`

**D1 错误处理:** ✅ L297-304, 306-316: 完整 try/catch
**D2 异常处理:** ✅ L296-297, 311-312: 显式 catch + 错误传播
**D3 日志:**
- ✅ L295: `console.warn` 升级（v1 R#9 顺手修）
- ✅ L302, 313: `console.error` 记录 sendMessage 失败

**D4 Fail-fast:** ✅
**D5 测试友好性:** N/A
**D6 调试友好性:** ⚠️ L302, 313 缺 `msg.id` 和 `sid` 上下文（INFO #10）

**结论:** R#5 完全修复，附带 1 个 INFO 建议。

---

### `src-electron/renderer/src/components/chat/BranchIndicator.vue`

**D1-D6:** ✅ prop 化（`branchTabs?: BranchTab[]` 默认 `[]`），删除硬编码 `return []` 和 `useTreeStore()` 冗余调用

**结论:** 无回归，与 v1 相比显著改善（v1 R#7 LOW 已通过 BLR M#3 路径修复）。

---

### `src-electron/renderer/src/components/chat/MessageBubble.vue`

**D1-D6:**
- ✅ `data-timestamp` 属性添加（支撑 batch 复制）
- ✅ `branchTabs` / `selectable` / `selected` props 透传
- ✅ `renderVersion` 改 `ref(0)`，watch 闭包独立（v1 BLR L#8）
- ✅ batch 模式下 checkbox 渲染 + `@click.stop` 防误触
- ✅ batchInfoMap 计算属性恢复（commit `30c4ced` lint 清理）
- ⚠️ L434 多一个空行（小瑕疵，不影响功能）

**结论:** 无新问题。

---

### `src-electron/renderer/src/components/panel/ChatPanel.vue`

**D1 错误处理:**
- ❌ L393-395: `copyBatchAs` `if (elements.length === 0) return` 静默 no-op（LOW #2）
- ⚠️ L386: `document.querySelector` 跨组件查 DOM（v1 同类 LOW #7）

**D2 异常处理:** ✅ 无显式 catch
**D3 日志:** N/A
**D4 Fail-fast:** ⚠️ `forceScrollToBottom` smooth scroll 副作用（LOW #5）
**D5 测试友好性:** ⚠️ 重复实现 DOM 查询（LOW #7）
**D6 调试友好性:** ⚠️ 用户无反馈

**结论:** 新增 1 个 LOW（#2 copyBatchAs silent no-op）与 R#4 同类，2 个 LOW/INFO 副作用。

---

### `src-electron/renderer/src/components/layout/AppSidebar.vue`

**D1-D6:**
- ✅ `useLayoutStore` 替换硬编码 `const isFullscreen = ref(false)`
- ✅ `v-if="!isCollapsed"` 控制挂载
- ✅ `SidebarHeader` + `SidebarCollapseHandle` 渲染
- ✅ `useSidebarStore` 引入
- N/A: 渲染逻辑无错误路径

**结论:** 无回归。`isFullscreen` 首屏竞态在 App.vue（LOW #4）已记录。

---

### `src-electron/renderer/src/App.vue`

**D1-D6:**
- ✅ `:class="{ 'app-container--sidebar-collapsed': sidebarStore.collapsed }"` 响应式
- ✅ `layoutStore.setFullscreen(isFullscreen)` 同步
- ⚠️ L347-348: IPC 回调首屏竞态（LOW #4）

**结论:** 无新问题，1 个 LOW 竞态。

---

### `src-electron/renderer/src/stores/layout.ts` (新建)

**D1-D6:** ✅ 标准 Pinia setup store，类型清晰，注释说明职责边界（与 useSidebarStore 区分）

**结论:** 新建文件，健壮性良好。

---

### `src-electron/renderer/src/components/chat/InputToolbar.vue`

**D1-D6:** 仅 CSS 类变更（streaming 时 stop 按钮 `bg-danger text-white`），无逻辑变化

**结论:** 无回归。

---

### `src-electron/renderer/src/style.css`

**D1-D6:** 新增 transition + collapsed modifier class，CSS-only 变更

**结论:** 无回归。

---

## 严重度统计

| 严重度 | 数量 | 占比 | 变化 |
|--------|------|------|------|
| MUST_FIX | 1 | 9% | 4 ↓ |
| LOW | 6 | 55% | 持平 |
| INFO | 4 | 36% | 持平 |
| **总计** | **11** | **100%** | 5 ↓ |

## 结论

**verdict: FAIL** — 1 个 MUST_FIX（R#4）未修复，必须再次复审。

**关键发现：**

1. **R#4 遗漏**：v1 标记的 `MessageActionMenu.handleCopy/handleCopyPlain` 静默 no-op 在 v2 中**完全未修改**。修复摘要的 11 项 fix 列表中**未包含此项**——5 个 BLR MUST + 2 个 BLR LOW + 3 个 Robustness MUST = 10 个 fix，但 Robustness R#4 不在 11 项中。dev subagent 把 R#4 误归为 BLR M#2 (BatchSelectBar)，但 R#4 是**完全独立的**与 copy 操作相关的 MUST_FIX。

2. **同类问题复制**：v2 新增的 `ChatPanel.copyBatchAs` 又复刻了 R#4 模式（`if (elements.length === 0) return`），LOW 严重度。这意味着 dev subagent 未从 v1 review 中提炼出"silent no-op 必须给用户反馈"这一通用原则。

3. **R#1, R#2, R#3, R#5 质量优良**：
   - R#1: `console.error` 保留 stack trace + 真实错误信息
   - R#2: tabindex + document listener + onUnmounted cleanup 三重防护
   - R#3: 顶层 + 分支级 fail-fast，覆盖 sid/targetEntryId/entryId
   - R#5: try/catch + message.error + console.error 三件套，v1 R#9 顺手修

**修复策略：**
1. **必须修复 R#4** — `MessageActionMenu.handleCopy/handleCopyPlain` 的 `if (el) { ... }` 改为 `if (!el) { emit('toast:show', {...}); emit('close'); return }`
2. 建议一并修复 LOW #2（`ChatPanel.copyBatchAs` 同类问题）
3. 其余 LOW/INFO 留待 v3 polish 阶段

**与其他审查的交叉验证：**

| 审查 | v2 关注点 | 状态 |
|------|----------|------|
| BLR v2 | BatchSelectBar 实际挂载、Esc 关闭、Sidebar 折叠 | 待对照（独立 review） |
| TS-Taste v2 | 类型 + 死代码 + 风格 | 待对照（独立 review） |
| Standards v2 | 命名 + 文件结构 | 待对照（独立 review） |

---

*Robustness Review v2 — chat-area-round1 — 2026-06-05 17:50*
