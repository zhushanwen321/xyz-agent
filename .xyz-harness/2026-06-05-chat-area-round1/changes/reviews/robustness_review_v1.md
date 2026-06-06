---
verdict: fail
must_fix: 5
review_metrics:
  files_reviewed: 11
  dimensions_checked: 6
  issues_found: 16
  must_fix_count: 5
  low_count: 8
  info_count: 3
  duration_estimate: "18"
---

# Robustness Review v1 — chat-area-round1

## 审查记录

- 审查时间：2026-06-05 17:15
- 审查员：Robustness Reviewer (skill: `xyz-harness-robustness-reviewer`)
- 审查范围：`git diff 9fce3cb..HEAD` — 30 commits, 11 个重点文件
- 审查方法：D1-D6 六维度逐文件扫描 → 跨维度合并 → 严重度判定
- 配套审查：BLR (MUST_FIX: 6)、Standards (PASS)、TS-Taste (PASS)
- 测试辅助：3 个新 vitest 文件、1 个新集成测试（tree-message-handler）

## 维度评分概览

| 维度 | 检查项数 | 通过 | 问题 | 评分 | 说明 |
|------|---------|------|------|------|------|
| D1 错误处理 | 18 | 12 | 6 | 6.5/10 | 多处"silent no-op"路径，错误信息不可见 |
| D2 异常处理 | 11 | 7 | 4 | 6.0/10 | 1 处空 catch 块 + 1 处承诺未实现的 Escape |
| D3 日志 | 12 | 8 | 4 | 7.0/10 | 日志级别不当 1 处 + 错误未记录 3 处 |
| D4 Fail-fast | 14 | 10 | 4 | 7.0/10 | 2 处关键参数未校验 + 1 处 silent no-op |
| D5 测试友好性 | 9 | 7 | 2 | 7.5/10 | `BranchIndicator` 硬编码 return [] 阻塞测试 |
| D6 调试友好性 | 13 | 9 | 4 | 7.0/10 | 客户端错误信息无 sessionId 上下文 |

**总评分：6.8 / 10** — 健壮性基本可接受，但存在若干空 catch 块 + silent no-op 路径，生产环境故障排查困难。

## 维度发现汇总

### D1 错误处理（6 issues, score 6.5/10）

| 问题 | 位置 | 严重度 |
|------|------|--------|
| `clipboard.ts` catch 块吞掉原始错误，仅返回 Toast | `clipboard.ts:19-22` | MUST_FIX |
| `MessageActionMenu` 找不到 messageEl 时静默 no-op | `MessageActionMenu.vue:101-104, 107-110` | MUST_FIX |
| `message.steer` / `message.follow_up` 路径 sendMessage 失败时无客户端反馈 | `server.ts:293-301` | MUST_FIX |
| `renameSession` 在 session 不存在且磁盘扫描失败时**静默成功** | `session-service.ts:146-160` | LOW |
| `BranchIndicator.branchTabs` 硬编码 `return []` (实际是 silent fallthrough) | `BranchIndicator.vue:43-51` | LOW |
| `tree-service.ts` catch 块返回 error 但不记录日志 | `tree-service.ts:155, 192` | LOW |

### D2 异常处理（4 issues, score 6.0/10）

| 问题 | 位置 | 严重度 |
|------|------|--------|
| `clipboard.ts:19` 空 catch `} catch {` 无日志无注释 | `clipboard.ts:19` | MUST_FIX |
| `MessageActionMenu.vue:126-132` 注释 "Close on Escape" 但**无 keydown 监听器** | `MessageActionMenu.vue:126-132` | MUST_FIX |
| `server.ts:293` 注释 `steer: abort best-effort` 但仅用 `console.log` 记录异常 | `server.ts:293` | LOW |
| `tree-message-handler` 各 case 内的 catch 只处理 "not found"，其他异常会 rethrow 触发外层兜底（未验证） | `tree-message-handler.ts:45-91` | INFO |

### D3 日志（4 issues, score 7.0/10）

| 问题 | 位置 | 严重度 |
|------|------|--------|
| `clipboard.ts:19-22` catch 块内**无任何日志** | `clipboard.ts:19-22` | (MUST_FIX 上记) |
| `tree-service.ts:155, 192` catch 块将 error 存入 result 但不写日志 | `tree-service.ts:155, 192` | LOW |
| `server.ts:293` 用 `console.log` 而非 `console.warn` 记录可恢复异常 | `server.ts:293` | LOW |
| `MessageActionMenu.vue:101-110` silent no-op 路径无 log | `MessageActionMenu.vue:101-110` | (MUST_FIX 上记) |

### D4 Fail-fast（4 issues, score 7.0/10）

| 问题 | 位置 | 严重度 |
|------|------|--------|
| `tree-message-handler.ts:14-15` `payload.sessionId as string` 无校验；缺失时下游 `getSummary` 抛 TypeError | `tree-message-handler.ts:14-15` | MUST_FIX |
| `tree-message-handler.ts:57` `payload.entryId as string` 无校验；缺失时 `forkFromEntry` 抛 TypeError | `tree-message-handler.ts:57` | LOW |
| `MessageActionMenu.vue:101-110` silent no-op（用户点击 复制 无任何反馈） | `MessageActionMenu.vue:101-110` | (MUST_FIX 上记) |
| `collectMessageContent.ts:37` `messageEl: HTMLElement` 类型标注，调用方传 null 直接 throw | `collectMessageContent.ts:37` | LOW |

### D5 测试友好性（2 issues, score 7.5/10）

| 问题 | 位置 | 严重度 |
|------|------|--------|
| `tree-service.ts:149, 184` `labelSuffix` 参数标注为 `// eslint-disable-next-line @typescript-eslint/no-unused-vars` 但**实际功能上无作用**；调用方误以为参与命名逻辑 | `tree-service.ts:149, 184` | LOW |
| `BranchIndicator.branchTabs` 硬编码 `return []` 阻塞端到端测试 | `BranchIndicator.vue:43-51` | (LOW 上记) |
| `MessageActionMenu.vue:94-97` 通过 `document.querySelector` 查找元素，绕过 Vue 组件树 | `MessageActionMenu.vue:94-97` | INFO |

### D6 调试友好性（4 issues, score 7.0/10）

| 问题 | 位置 | 严重度 |
|------|------|--------|
| `server.ts:293-301` `message.steer` 失败时，客户端**收不到任何 message.error** | `server.ts:293-301` | (MUST_FIX 上记) |
| `tree-message-handler.ts` 错误信息如 `'Session not active'` 不含 sessionId | `tree-message-handler.ts:38, 51, 67, 90` | INFO |
| `clipboard.ts:19-22` 用户看到 Toast 但开发者看不到 stack trace | `clipboard.ts:19-22` | (MUST_FIX 上记) |
| `MessageActionMenu.vue:101-110` 静默 no-op 路径无 log | `MessageActionMenu.vue:101-110` | (MUST_FIX 上记) |

## 问题清单（合并同位置）

| # | 严重度 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|------|------|------|------|---------|
| 1 | **MUST_FIX** | D1, D2, D3, D6 | `clipboard.ts:19-22` 空 catch 块吞掉原始错误，既无日志也无 context 保留；用户看到 Toast 但开发者无法定位原因（clipboard 权限？API 不存在？） | `src-electron/renderer/src/lib/clipboard.ts` | 19 | 改为 `} catch (e) { console.error('[clipboard] writeText failed:', e); ... }`；考虑向上抛出并由调用方决定 UI |
| 2 | **MUST_FIX** | D2, D4 | `MessageActionMenu.vue:126` 注释承诺 "Close on Escape" 但 watch 仅 `nextTick(() => menuRef.value?.focus())`，**无任何 keydown 监听**。`menuRef` 也未设 `tabindex`/`@keydown` 属性，`<Teleport>` 内的 div 接收不到 keyboard focus | `src-electron/renderer/src/components/chat/MessageActionMenu.vue` | 126-132 | 1) 模板 `<div ref="menuRef" tabindex="-1" @keydown.esc="$emit('close')">`；2) 或在 `onMounted` 中 `document.addEventListener('keydown', ...)` + `onUnmounted` 中清理 |
| 3 | **MUST_FIX** | D4, D6 | `tree-message-handler.ts:14-15` `payload.sessionId as string` 无校验；如果 `msg.payload` 缺失或格式错，`sid === undefined` 会在 L57 进入 `forkFromEntry(undefined, ...)` → 抛 `'Session undefined not found'` 错误。延迟爆炸到 server.ts 外层 | `src-electron/runtime/src/tree-message-handler.ts` | 14-15, 79-80 | 入口处加 `if (!sid) return this.ctx.send(ws, { type: 'session.tree-fork-result', id: msg.id, payload: { success: false, error: 'sessionId required' } })`；或抛 `BadRequestError` |
| 4 | **MUST_FIX** | D1, D3, D4, D6 | `MessageActionMenu.vue:101-110` 当 `getMessageEl()` 返回 `null`（message 已卸载、用户快速操作、entryId 不在 DOM），`handleCopy`/`handleCopyPlain` 静默 `if (el) { ... }` 后 emit('close')。用户点击 复制 完全无反馈（无 Toast、无日志） | `src-electron/renderer/src/components/chat/MessageActionMenu.vue` | 101-110 | `if (!el) { emit('toast:show', { type: 'danger', title: '无法复制', description: '消息已不在视图中' }); emit('close'); return }` |
| 5 | **MUST_FIX** | D1, D6 | `server.ts:292-307` `message.steer` 和 `message.follow_up` 路径在 `await this.sessionService.sendMessage(...)` 失败时**没有任何错误反馈**给客户端。`message.send` 路径在 L287-289 有 try/catch；新增的两条消息类型漏掉 | `src-electron/runtime/src/server.ts` | 292-307 | 在 `message.steer` / `message.follow_up` 内部对 `sendMessage` 加 try/catch，失败时 `this.send(ws, { type: 'message.error', id: msg.id, payload: { sessionId, message: errMsg } })` |
| 6 | LOW | D1, D4 | `session-service.ts:146-160` `renameSession`：当 `sessions.get` 失败且 `findScannedSession` 也失败时，函数**静默 return**，调用方无感知。Clone 路径（`tree-message-handler.ts:79-82`）依赖此函数 | `src-electron/runtime/src/services/session-service.ts` | 146-160 | 函数签名加 `: Promise<void>` 抛错语义；找不到时 `throw new Error(\`Session ${sessionId} not found for rename\`)`，由调用方在 `tree-message-handler` 捕获后回传 `success: false` |
| 7 | LOW | D1, D5 | `BranchIndicator.vue:43-51` `branchTabs` 硬编码 `return []`；多分支时 dropdown 永远空（即便 store 端数据齐全） | `src-electron/renderer/src/components/chat/BranchIndicator.vue` | 43-51 | 改为接受 `branchTabs` prop（由 `useTreeStore.getActivePath(entryId)?.branchTabs` 传入）；或在 `setup()` 内 `useTreeStore` 真的查询 |
| 8 | LOW | D3, D6 | `tree-service.ts:155, 192` `forkFromEntry`/`cloneSession` catch 块将 `e.message` 存入 `result.error` 返回，但**不写 console.error**，导致错误仅在客户端 Toast 出现而服务端日志无声 | `src-electron/runtime/src/services/tree-service.ts` | 155, 192 | 加 `console.error('[tree-service] forkFromEntry failed:', e)` 在 catch 块 |
| 9 | LOW | D5 | `tree-service.ts:149, 184` `labelSuffix` 参数用 `// eslint-disable-next-line @typescript-eslint/no-unused-vars -- labelSuffix reserved for caller coordination` 注释保留但**实际未使用**。调用方（`tree-message-handler`）完全靠自己拼接 `originalLabel + '-fork'`，tree-service 端接受误导性参数 | `src-electron/runtime/src/services/tree-service.ts` | 149, 184 | 两种选择：A) 删除参数并清理 caller；B) 真正使用 `labelSuffix` 在 tree-service 端生成 label（`return { success: true, newSessionId, label: originalLabel + labelSuffix }`），移除 tree-message-handler 的拼接 |
| 10 | LOW | D3 | `server.ts:293` steer 路径 abort 失败用 `console.log` 而非 `console.warn`。`console.log` 容易被 `LOG_LEVEL=info` 过滤掉 | `src-electron/runtime/src/server.ts` | 293 | 改为 `console.warn(...)`；或在注释中说明此为可恢复情况 |
| 11 | LOW | D4 | `tree-message-handler.ts:57` `payload.entryId as string` 无校验；缺失时 `forkFromEntry(sid, undefined)` 抛 TypeError | `src-electron/runtime/src/tree-message-handler.ts` | 57 | `if (!entryId) return this.ctx.send(ws, { type: 'session.tree-fork-result', id: msg.id, payload: { success: false, error: 'entryId required' } })` |
| 12 | LOW | D4 | `collectMessageContent.ts:37` 无 `messageEl == null` 入口校验；调用方传 `null` 直接 throw on `querySelectorAll` | `src-electron/renderer/src/lib/collectMessageContent.ts` | 37 | 入口加 `if (!messageEl) return ''`；或在 JSDoc 中明确 "throws when messageEl is null" |
| 13 | INFO | D5 | `MessageActionMenu.vue:94-97` 通过 `document.querySelector` 跨组件查 DOM（`[data-entry-id="..."]`），绕过 Vue 组件树，难以单测 | `src-electron/renderer/src/components/chat/MessageActionMenu.vue` | 94-97 | 接受 `targetEl: HTMLElement` 作为 prop，由父组件通过 `ref` 注入；或暴露 `getMessageEl` composable |
| 14 | INFO | D2 | `tree-message-handler.ts:45-91` 各 case catch 块只识别 "not found" 错误，其他错误 rethrow。需验证 `server.ts` 外层有 try/catch 兜底（路径在 `SidecarServer.handleSessionMessage` 之外的 `handle` 方法） | `src-electron/runtime/src/tree-message-handler.ts` | 45-91 | 验证 `server.ts` 的 `handle` 方法有 final try/catch 转换为 `handler_error` 消息；如无则补全 |
| 15 | INFO | D6 | `tree-message-handler.ts:38, 51, 67, 90` 错误信息如 `'Session not active'` 不含 sessionId；客户端 toast 难以定位 | `src-electron/runtime/src/tree-message-handler.ts` | 38, 51, 67, 90 | 改为 `\`Session ${sid} not active\`` |

## 逐文件详情

### `src-electron/renderer/src/lib/clipboard.ts` (39 lines)

**D1 错误处理:**
- ✅ L17-23: try/catch 包裹 `navigator.clipboard.writeText()`
- ❌ L19-22: catch 块吞掉原始错误，无 log 无 context

**D2 异常处理:**
- ❌ L19: `} catch {` 空 catch 块（无日志、无注释说明）

**D3 日志:**
- ❌ L19-22: 整个 catch 路径无任何日志

**D4 Fail-fast:**
- ⚠️ L17: 无 `text` 参数 null 校验

**D5 测试友好性:**
- ✅ 测试存在且使用 `vi.stubGlobal` mock

**D6 调试友好性:**
- ⚠️ 用户看到 Toast 但开发者看不到 stack trace

---

### `src-electron/renderer/src/lib/collectMessageContent.ts` (65 lines)

**D1 错误处理:**
- ✅ 纯函数，无 I/O

**D2 异常处理:**
- ✅ 无显式 try/catch；fail-fast 通过 throw

**D3 日志:**
- N/A (pure function)

**D4 Fail-fast:**
- ⚠️ L37: `messageEl: HTMLElement` 类型标注但运行时不校验 null

**D5 测试友好性:**
- ✅ 9 个测试覆盖主路径

**D6 调试友好性:**
- ✅ Markdown 格式保留 `[Thinking: ...]` `[Tool: name ✓ path]` 标记

---

### `src-electron/renderer/src/components/chat/MessageActionMenu.vue` (168 lines)

**D1 错误处理:**
- ❌ L101-110: `if (el)` 静默 no-op，无 Toast
- ✅ L86-89: `if (!props.anchorRect) return {}` 优雅降级

**D2 异常处理:**
- ❌ L126-132: 注释 "Close on Escape" 但无 keydown 监听

**D3 日志:**
- ❌ L101-110: 静默 no-op 无 log

**D4 Fail-fast:**
- ❌ L101-110: silent no-op 失败模式

**D5 测试友好性:**
- ⚠️ L94-97: `document.querySelector` 跨组件查 DOM

**D6 调试友好性:**
- ❌ L101-110: 无错误反馈

---

### `src-electron/renderer/src/components/chat/BranchIndicator.vue` (191 lines)

**D1 错误处理:**
- ❌ L43-51: `branchTabs` 硬编码 `return []`，silent fail

**D2 异常处理:**
- N/A

**D3 日志:**
- N/A

**D4 Fail-fast:**
- ⚠️ L43-51: silent fallthrough 阻塞多分支导航

**D5 测试友好性:**
- ❌ `branchTabs` 硬编码阻塞测试

**D6 调试友好性:**
- ⚠️ 用户点击 pill 看到 dropdown 为空

---

### `src-electron/renderer/src/components/chat/UtilityRail.vue` (35 lines)

所有维度：纯展示组件，无副作用。✅ 通过

---

### `src-electron/renderer/src/components/sidebar/SidebarCollapseHandle.vue` (40 lines)

所有维度：触发 store.toggle()，无错误路径。✅ 通过

---

### `src-electron/renderer/src/stores/sidebar.ts` (16 lines)

所有维度：Pinia store，标准模式。✅ 通过

---

### `src-electron/runtime/src/tree-message-handler.ts` (100 lines, 改动部分)

**D1 错误处理:**
- ✅ L36: `console.error('[tree-data] auto-restore failed:', restoreErr)` 完整记录
- ✅ L38, 51, 67, 90: `'Session not active'` 优雅错误回传
- ❌ L14-15: `payload.sessionId as string` 无校验
- ❌ L57: `payload.entryId as string` 无校验

**D2 异常处理:**
- ✅ L30-43: 嵌套 try/catch 区分 "not found" 与其他错误
- ⚠️ L45-91: 只识别 "not found" 错误，其他 rethrow；需验证外层兜底

**D3 日志:**
- ✅ L36: 有 console.error

**D4 Fail-fast:**
- ❌ L14-15, 57: 无入口校验

**D5 测试友好性:**
- ✅ 测试存在（5 个用例覆盖 fork/clone label 命名）

**D6 调试友好性:**
- ⚠️ 错误信息不含 sessionId

---

### `src-electron/runtime/src/services/session-service.ts` (改动部分)

**D1 错误处理:**
- ✅ L443-444: `rebindAfterFork` fail-fast 抛错
- ❌ L146-160: `renameSession` 静默 no-op

**D2 异常处理:**
- ✅ L443-444, 460: 抛错包含 sessionId 上下文

**D3 日志:**
- N/A (调用方负责)

**D4 Fail-fast:**
- ✅ L443-444: 立即失败
- ❌ L146-160: renameSession silent no-op

**D5 测试友好性:**
- ✅ 改动经由 tree-message-handler 测试覆盖

**D6 调试友好性:**
- ✅ L443-444, 460 错误信息含 sessionId

---

### `src-electron/runtime/src/services/tree-service.ts` (改动部分)

**D1 错误处理:**
- ⚠️ L155, 192: 错误返回 result.error 但无 console.error

**D2 异常处理:**
- ⚠️ catch 块丢失堆栈（仅保留 message）

**D3 日志:**
- ❌ L155, 192: 错误未记录日志

**D4 Fail-fast:**
- ✅ L150, 185: 入口处 `if (!client) throw`

**D5 测试友好性:**
- ❌ L149, 184: `labelSuffix` 参数误导性保留

**D6 调试友好性:**
- ⚠️ 错误信息仅 `e.message`，无客户端/entryId 上下文

---

### `src-electron/shared/src/protocol.ts` (改动部分)

所有维度：纯类型定义。✅ 通过

---

## 相关文件 (未在重点列表中但相关)

### `src-electron/runtime/src/server.ts` (L292-307, 新增 message.steer/follow_up 处理)

**D1 错误处理:**
- ❌ L292-307: `message.steer` / `message.follow_up` 路径 sendMessage 失败无客户端反馈

**D3 日志:**
- ⚠️ L293: `console.log` 而非 `console.warn` 记录 abort 失败

### `src-electron/renderer/src/components/chat/ChatInput.vue` (L141-156 Alt key 监听)

不在本 review 重点列表内，仅附注 BLR #10：Alt key 全局 keydown/keyup 监听，焦点切换时状态可能错位（LOW 严重度）

## 严重度统计

| 严重度 | 数量 | 占比 |
|--------|------|------|
| MUST_FIX | 5 | 31% |
| LOW | 8 | 50% |
| INFO | 3 | 19% |
| **总计** | **16** | **100%** |

## 结论

**verdict: FAIL** — 必须修复 5 个 MUST_FIX 后方可通过本轮审查。

5 个 MUST_FIX 中：
- **#1 (clipboard.ts 空 catch)** — 静默吞掉 `navigator.clipboard.writeText` 异常，生产环境无法排查权限或 API 不可用问题
- **#2 (MessageActionMenu 缺 Esc 关闭)** — 注释承诺未实现，违反"承诺性 API"原则
- **#3 (tree-message-handler payload 校验)** — 延迟爆炸风险，TypeError 抛到外层后客户端只看到 generic handler_error
- **#4 (MessageActionMenu 静默 no-op)** — 用户点击 复制 无任何反馈，且与 BLR M#1 关联
- **#5 (server.ts message.steer/follow_up 错误无反馈)** — 协议层新增消息类型遗漏错误处理，与 BLR UC-7 路径对齐

修复策略：
1. 优先修复 **#1、#5**（错误吞掉/丢失 — 生产阻塞）
2. 修复 **#2、#4**（MessageActionMenu 完整化 — 配合 BLR 修复）
3. 修复 **#3**（防御性参数校验 — fail-fast 落实）

修复后建议复审。

---

## 与其他审查的交叉验证

| 审查 | MUST_FIX 编号 | 交叉确认 |
|------|--------------|---------|
| BLR M#1 (Esc 关闭) | 本 R#2 | ✅ 同一问题，BLR 从功能路径发现，本 review 从异常处理维度确认 |
| BLR M#2 (BatchSelectBar 未挂载) | N/A | BLR 范畴，非健壮性问题 |
| BLR M#3 (BranchTabs 硬编码) | 本 R#7 (LOW) | BLR 标注为 MUST；本 review 标记为 LOW，因 BLR 已捕获主路径问题 |
| BLR M#6 (isFullscreen ref 硬编码) | N/A | 非健壮性问题 |
| TS-Taste Issue 1 (BranchIndicator 死代码) | 本 R#7 | 同一问题，TS-Taste 标 LOW，BLR 标 MUST；本 review 同意 BLR 升 MUST 但本维度标记 LOW（与 tree-service 配合使用时可临时工作） |

---

*Robustness Review v1 — chat-area-round1 — 2026-06-05 17:15*
