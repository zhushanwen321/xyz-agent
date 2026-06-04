# 代码品味审查报告 — Resources/插件文件

**分支**: `main...feat-integration-pi-extension`
**范围**: `resources/`、`src-electron/resources/`
**审查日期**: 2026-06-04

## 概要

本次 diff 涉及 52 个文件，净删除 ~10,900 行（`src-electron/resources/pi/` 下 6 个 extension 整体移至 `resources/` 目录）。
**实际修改的活代码仅 3 个文件、+11/-3 行**。

---

## 问题清单

### 1. MUST_FIX — `bridge/index.ts:57,72` — `throw e` 在事件回调中会中断后续事件处理

**文件**: `resources/pi/agent/extensions/bridge/index.ts`
**行号**: 57, 72

```typescript
// 事件转发回调
api.on(evt, async (data: any) => {
  try {
    // ...
  } catch (e) {
    console.error('[bridge] event forward error:', e)
    throw e  // ← 新增
  }
})
```

`throw e` 将异常向上传播到 pi 的事件调度器。pi 内部对 extension 事件回调的错误处理行为未文档化——如果 pi 不 catch，未处理的 rejection 可能导致整个 extension 崩溃或后续事件回调被跳过。原始代码只 `console.error` 不 re-throw 是**有意为之**的容错设计（单个事件转发失败不应影响后续事件）。

同理 `append_entry` 回调（行 72）的 `throw e` 也存在同样问题。

**修复方向**: 移除两处 `throw e`，恢复原始的静默容错行为。如果确实需要上游感知，应使用 `api.emit('bridge:error', e)` 或类似机制，而不是直接 throw。

---

### 2. MUST_FIX — `bridge/index.ts:1-3` — 模块级全局状态在多次 activate 间无重置

**文件**: `resources/pi/agent/extensions/bridge/index.ts`
**行号**: 1-3

```typescript
let bridgeState: 'Disconnected' | 'Syncing' | 'Ready' = 'Disconnected'
let syncAttempts = 0
const MAX_SYNC_ATTEMPTS = 30
```

`syncAttempts` 在函数体开头只 `bridgeState = 'Disconnected'` 但没有 `syncAttempts = 0`。如果 pi 对同一 extension 调用多次 `activate`（热重载场景），`syncAttempts` 可能从上次的残留值继续递增，导致 sync 循环立即超出上限。

**修复方向**: 在 `activate` 函数体开头添加 `syncAttempts = 0`。

---

### 3. LOW — `bridge/index.ts:38-40` — sync 失败后 `return` 无实际效果

**文件**: `resources/pi/agent/extensions/bridge/index.ts`
**行号**: 38-40

```typescript
} catch (e) {
  console.debug('[bridge] sync attempt failed, retrying:', e)
  return  // ← 这行无意义：setInterval 回调中 return 仅退出当前调用
}
```

`return` 在 `setInterval` 回调内仅退出本次执行，下次 interval 仍会触发。原始代码的 `/* retry */` 注释虽然无声但语义更准确。新增 `return` 给读者造成"重试被中止"的错觉。

**修复方向**: 移除 `return`，改回 `/* retry */` 注释或添加注释 `// next interval will retry`。

---

### 4. LOW — `bridge/index.ts` — 缺少 `deactivate` 生命周期

**文件**: `resources/pi/agent/extensions/bridge/index.ts`

该 extension 只 export 了 `activate`，没有 `deactivate`。`setInterval(syncInterval)` 在 extension 停用后不会被清除，持续向可能已销毁的 UI 发请求。

`EVENTS` 的 `api.on` 注册的事件监听器也没有在 deactivate 时取消。

**修复方向**: export `deactivate` 函数，清除 `syncInterval` 并 unregister 所有事件监听器（pi 可能会自动处理，但显式清理更安全）。

---

### 5. LOW — `statusline/index.ts:70` — `throw err` 与 bridge 相同的问题

**文件**: `resources/plugins/statusline/index.ts`
**行号**: 70

```typescript
} catch (err) {
  console.error('[statusline] Error handling statusSetUpdate:', err)
  throw err
}
```

与 bridge 的问题相同：`throw err` 在 `onPiEvent` 回调中的行为取决于 plugin-service 的错误处理策略。如果 plugin-service 不 catch，可能导致 hook 链中断或整个 statusline plugin 停止工作。

**修复方向**: 移除 `throw err`。如果 hook 框架依赖 throw 来决定是否继续执行链，需要确认 plugin-service 的 hook 执行语义后再决定。

---

### 6. INFO — `goal-tool.ts:31` — `JSON_INDENT` 常量提取合理

**文件**: `resources/plugins/goal/src/goal-tool.ts`
**行号**: 31

```typescript
const JSON_INDENT = 2
```

从 magic number `2` 提取为命名常量。语义清晰，方向正确。但此常量仅使用一次（行 173），且 `JSON.stringify` 的第三个参数 `2` 是业界通用的 pretty-print indent，可读性已经足够。属于风格偏好，不构成问题。

---

### 7. INFO — `src-electron/resources/` 整体迁移

`src-electron/resources/pi/` 下的 6 个 extension（goal、hooks、shared、subagent、todo、usage-tracker、workflow）被整体删除。这些代码看起来已迁移到 `resources/` 目录（bridge 保留在 `resources/pi/`，goal/statusline/todo 迁移到 `resources/plugins/`）。

**观察**:
- 删除量巨大（~10,900 行），但全是文件删除，无新增逻辑
- `resources/plugins/goal/src/goal-tool.ts` 的 import 路径 `../../../../src-electron/runtime/src/services/plugin-service/plugin-types.js` 暗示 goal plugin 仍依赖主项目的类型定义，目录迁移后这个相对路径是否正确需要确认

---

## 总结

| 优先级 | 数量 | 关键问题 |
|--------|------|----------|
| MUST_FIX | 2 | bridge 的 `throw e` 破坏事件回调容错性；`syncAttempts` 未在 activate 中重置 |
| LOW | 3 | sync catch 中无意义的 `return`；缺少 deactivate 生命周期；statusline 的 throw err |
| INFO | 2 | JSON_INDENT 常量提取；目录迁移观察 |

**核心风险**: 3 处新增的 `throw e/err` 是本次 diff 最危险的改动。事件回调中 re-throw 的行为取决于宿主（pi/plugin-service）的错误处理策略，而原始代码故意静默吞错。建议全部移除或改为显式错误上报。
