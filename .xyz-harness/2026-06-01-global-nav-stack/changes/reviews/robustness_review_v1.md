---
verdict: fail
must_fix: 2
review_metrics:
  files_reviewed: 5
  dimensions_checked: 6
  issues_found: 8
  must_fix_count: 2
  low_count: 6
  info_count: 0
  duration_estimate: "15"
---

# Robustness Review v1

## 审查记录
- 审查时间：2026-06-01 15:30
- 审查文件数：5
- 审查维度：D1-D6（全量）

## 维度评分概览

| 维度 | 检查项数 | 通过 | 问题 | 评分 |
|------|---------|------|------|------|
| D1 错误处理 | 8 | 5 | 3 | 6/10 |
| D2 异常处理 | 6 | 4 | 2 | 6/10 |
| D3 日志 | 5 | 3 | 2 | 5/10 |
| D4 Fail-fast | 6 | 4 | 2 | 7/10 |
| D5 测试友好性 | 5 | 4 | 1 | 7/10 |
| D6 调试友好性 | 5 | 4 | 1 | 8/10 |

## 问题清单

| # | 严重度 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|------|------|------|------|---------|
| 1 | MUST_FIX | D1,D2,D3,D6 | WS 断连存在两套重复 watcher，导致重复 toast 且第二个 watcher 无清理 | App.vue | L91-113, L276-305 | 删除其中一套 watcher，保留 onMounted 内的版本（有 dismissToast 恢复逻辑更完整），在 onUnmounted 中捕获返回的 stop 函数并清理 |
| 2 | MUST_FIX | D1,D2 | `initConnection()` 未 try/catch，失败后整个 onMounted 静默中断，后续事件注册全部跳过 | App.vue | L177-178 | 包裹 try/catch，catch 中通过 toast 告知用户连接初始化失败，并保留后续非连接依赖的 setup 逻辑 |
| 3 | LOW | D1 | `onConfirmRename` 乐观更新 store 后调用 `renameSession`，若后者失败无回滚 | AppSidebar.vue | L47-55 | 将乐观更新放在 `renameSession` 成功回调中，或在 catch 中恢复旧 label |
| 4 | LOW | D4 | `openSettings` 始终 push，不判断当前是否已在 settings 页，会产生重复 nav 条目 | AppHeader.vue | L100-102 | 加入 toggle 判断（与 App.vue L251-255 快捷键处理一致）|
| 5 | LOW | D4 | `push()` 不校验 entry 结构完整性（如 ChatEntry 缺少 sessionId） | navigation.ts | L35-49 | 添加运行时类型守卫或开发模式 assert |
| 6 | LOW | D3 | navigation store 的关键状态变更（push/back/forward）无任何日志，调试困难 | navigation.ts | 全文件 | 在 dev 模式添加 `console.debug('[nav]')` 日志 |
| 7 | LOW | D5 | App.vue `onMounted` 含 80+ 行初始化逻辑，依赖 7 个 store + IPC + event bus，难以单元测试 | App.vue | L177-320 | 拆分为独立 composable（如 `useAppLifecycle`），将初始化逻辑从组件中抽离 |
| 8 | LOW | D4 | `onConfirmRename` 不校验 `newName` 是否为空字符串 | AppSidebar.vue | L47 | 入口处检查 `!newName.trim()` 则提前 return |

## 逐文件详情

### navigation.ts

**D1 错误处理:**
- ✅ 纯状态操作，无 IO/网络调用，无 try/catch 需求
- ✅ `currentEntry` computed 正确处理 pointer 越界（< 0 或 >= length）
- ⚠️ L35: `push()` 不校验 entry 内容（见 #5）

**D2 异常处理:**
- ✅ 无异常抛出路径，符合纯 store 定位

**D3 日志:**
- ⚠️ 全文件无日志（见 #6）

**D4 Fail-fast:**
- ✅ `MAX_ENTRIES` 防止内存无限增长，驱逐逻辑正确
- ✅ `back()`/`forward()` 通过 `canGoBack`/`canGoForward` 守卫
- ⚠️ `push()` 缺少入口校验（见 #5）

**D5 测试友好性:**
- ✅ 纯 Pinia store，无外部依赖，高度可测
- ✅ 函数均为纯操作，输入→状态变更，便于断言

**D6 调试友好性:**
- ✅ `entries`/`pointer` 均为 ref，可通过 Vue DevTools 观察
- ⚠️ 无 `console.debug` 输出状态变化（见 #6）

---

### AppSidebar.vue

**D1 错误处理:**
- ✅ `handleSessionClick` 顺序调用 `switchSession` → `openSessionSmart` → `navStore.push`，逻辑清晰
- ⚠️ L47-55: 乐观更新无回滚（见 #3）

**D2 异常处理:**
- ✅ `onDelete`/`onStartRename`/`onCancelRename` 为简单同步操作
- ⚠️ L54: `renameSession` 可能是异步操作，未被 await 也无 catch（见 #3）

**D3 日志:**
- ✅ 无关键路径遗漏（组件内无 IO 操作）

**D4 Fail-fast:**
- ✅ `dirname()` 处理空字符串边界（`parts[parts.length - 1] || cwd`）
- ⚠️ L47: `newName` 无空值校验（见 #8）

**D5 测试友好性:**
- ⚠️ 依赖 4 个 store（session, panel, nav, session composable），需完整 mock 矩阵
- 可接受范围，组件级测试可通过 `mount + global.plugins` 解决

**D6 调试友好性:**
- ✅ 模板逻辑清晰，事件绑定语义化

---

### SettingsView.vue

**D1 错误处理:**
- ✅ Escape 键处理检查 modal 存在后才 `navStore.back()`，避免误关闭

**D2 异常处理:**
- ✅ 无异常风险路径

**D3 日志:**
- ✅ 纯 UI 组件，无日志需求

**D4 Fail-fast:**
- ✅ `watch` 使用 `immediate: true` 确保初始 tab 同步
- ✅ `onMounted`/`onUnmounted` 正确配对注册/移除 keydown listener

**D5 测试友好性:**
- ✅ Tab 切换逻辑简单，可直接通过 `activeTab.value` 断言

**D6 调试友好性:**
- ✅ Tab 配置为 `const` 数组，可静态分析

---

### App.vue

**D1 错误处理:**
- ✅ `createSession()` 检查 `window.electronAPI?.pickDirectory` 可用性
- ✅ `createSession()` 正确处理 `result.canceled`
- ✅ `handleGlobalError` 过滤无 `sessionId` 的错误才弹 toast
- ✅ WS 断连 toast 有 10s 延迟避免短暂断连闪屏
- ❌ L91-113 vs L276-305: 两套 WS 断连 watcher（见 #1）
- ❌ L178: `initConnection()` 无 try/catch（见 #2）

**D2 异常处理:**
- ❌ L178: `await initConnection()` 抛出后，整个 async onMounted 中断，后续 IPC 注册、事件监听全部跳过，但无任何错误报告（见 #2）

**D3 日志:**
- ✅ L148: `console.warn('[createSession] pickDirectory API not available')` 降级日志
- ❌ 两套 watcher 的 toast 创建无差异标识，难以区分来源

**D4 Fail-fast:**
- ✅ `handleKeydown` 仅在 meta/ctrl 修饰键时处理
- ✅ WS 状态断连后才启动延迟 toast，连接恢复后清理
- ✅ `isCreatingFromSidebar` flag 防止非 sidebar 创建的 session 被误切

**D5 测试友好性:**
- ⚠️ `onMounted` 80+ 行，含 WS watcher、IPC 注册、event bus 订阅、URL 参数解析（见 #7）

**D6 调试友好性:**
- ✅ Toast 消息包含具体描述（如"Runtime 启动失败"、Extension 超时提示）
- ✅ `onUnmounted` 清理路径完整：event bus off、IPC cleanup、keydown 移除、watcher stop、timer 清理

---

### AppHeader.vue

**D1 错误处理:**
- ✅ `focusedNotifs` computed 处理无 `sessionId` 的情况（返回 `{ done: 0, alert: 0 }`）
- ✅ `toggleTheme` 处理 system 主题判断

**D2 异常处理:**
- ✅ 无异常风险路径（纯 UI 操作）

**D3 日志:**
- ✅ 纯 UI 组件，无日志需求

**D4 Fail-fast:**
- ⚠️ L100-102: `openSettings` 不做 toggle 判断（见 #4）

**D5 测试友好性:**
- ✅ 函数短小、职责单一
- ⚠️ 依赖 5 个 store，但都是标准 Pinia mock

**D6 调试友好性:**
- ✅ `viewModeTitle` computed 提供上下文相关的 tooltip

## MUST_FIX 详情

### #1: WS 断连 watcher 重复 + 资源泄漏

**位置**: App.vue L91-113（setup 阶段）和 L276-305（onMounted 内）

**问题**:
1. `getWsState()` 被调用两次，创建两个独立 watch，状态变更时**两个 callback 都会执行**，产生两条断连 toast
2. L276-305 的 watcher 返回值（stop 函数）未被捕获，**无法在 onUnmounted 中清理**，造成 watcher 泄漏
3. 两套逻辑功能重叠但实现不同：第一套仅清理 timer，第二套有 dismissToast 恢复逻辑

**建议**: 删除 L91-113 的 watcher，仅保留 onMounted 内的版本（更完整），并在 `let` 声明处捕获 watch 返回的 stop 函数，加入 onUnmounted 清理。

### #2: initConnection 无错误处理

**位置**: App.vue L177-178

**问题**:
```typescript
onMounted(async () => {
  await initConnection()
  // ... 后续 150 行初始化逻辑
})
```
若 `initConnection()` 抛出（如 sidecar 进程启动失败、端口冲突），整个 async onMounted 中断。后果：
- 所有 IPC listener 未注册（`onWindowListUpdated`、`onShortcut`、`onRuntimeError`）
- event bus 监听未注册（`extension.ui_timed_out`、`error`）
- WS 状态 watcher 未注册
- 键盘事件未绑定
- 用户看到的 UI 无任何反馈——窗口打开但完全无响应

**建议**:
```typescript
onMounted(async () => {
  try {
    await initConnection()
  } catch (err) {
    // 通过 toast 告知用户
    const id = crypto.randomUUID()
    toasts.value.push({ id, type: 'danger', title: 'Runtime 连接失败', description: String(err) })
    setTimeout(() => dismissToast(id), TOAST_LONG_DURATION_MS)
  }
  // 后续非连接依赖的 setup 应继续执行（如键盘绑定、URL 参数解析）
  // 连接依赖的 setup 放入条件分支
})
```

## 结论

**需修改**。2 条 MUST_FIX 均在 App.vue 中：
1. WS 断连 watcher 重复导致生产环境重复 toast + watcher 泄漏
2. `initConnection` 无错误处理导致连接失败时整个应用静默无响应

修复后重新审查。
