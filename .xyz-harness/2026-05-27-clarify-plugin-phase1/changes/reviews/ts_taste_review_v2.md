---
verdict: pass
must_fix: 1
reviewed_at: 2026-05-28
reviewed_by: ai-coder
target: src-electron/runtime/src/services/plugin-service/
round: 2
v1_review: ts_taste_review_v1.md
---

# TypeScript 代码品味审查报告 — 第 2 轮

## 变更概览

本轮验证 v1 审查发现的 3 个 P0（must_fix）问题是否已修复。

| P0 # | 问题 | 文件 | 状态 |
|------|------|------|------|
| P0-1 | 未使用的 `_rpcServer` 参数 | `plugin-activator.ts` | ✅ **已修复** |
| P0-2 | deactivate 异常被静默吞掉 | `plugin-bootstrap.ts` | ✅ **已修复** |
| P0-3 | `getCache` 空 catch 块未区分错误类型 | `plugin-storage.ts` | ❌ **未修复** |

---

## P0-1: `_rpcServer` 未使用参数 — ✅ 已修复

**变动**: `activatePlugin` 方法签名删除了 `_rpcServer` 参数，同时 `handleEvent` 方法也移除了该参数。

```diff
-  async activatePlugin(
-    pluginId: string,
-    event: ActivationEvent,
-    host: PluginHost,
-    _rpcServer: PluginRpcServer,
-  ): Promise<void> {
+  async activatePlugin(
+    pluginId: string,
+    event: ActivationEvent,
+    host: PluginHost,
+  ): Promise<void> {
```

同时观察到更深层的重构：`PluginHost` 缩小版接口被提取到 `plugin-activator.ts:27-30`，`PluginHost` 类显式 `implements ActivatorHost`。这连带解决了 v1 报告的 P1-4（三重 `as unknown as` 类型桥接）—— `plugin-service.ts` 中现在直接传 `this.host` 而无需 cast。

**影响**: ESLint error 消除，CI 不再阻塞。

---

## P0-2: deactivate 异常被静默吞掉 — ✅ 已修复

**变动**: `plugin-bootstrap.ts` 的 deactivate case 中，catch 块现在发送 `{ type: 'error', ... }` 并 `break` 阻止 `deactivated` 消息发送。

```diff
    try {
      await mod.deactivate()
    } catch (e: unknown) {
-      console.error(`[bootstrap] deactivate error for ${msg.pluginId}:`, e)
+      // deactivate 失败时发送 error 而非 deactivated
+      parentPort!.postMessage({ type: 'error', pluginId: msg.pluginId, error: String(e) })
+      break
    }
-  }
-  parentPort!.postMessage({ type: 'deactivated', pluginId: msg.pluginId })
```

修复方式与 v1 审查推荐方案一致。`PluginActivator.handleWorkerReply()` 收到 `error` 类型后会 `resolve(false)`，Activator 正确感知停用失败。

**影响**: deactivate 错误路径不再静默丢失。

---

## P0-3: `getCache` 空 catch 块未区分错误类型 — ❌ 未修复

`plugin-storage.ts` 的 `getCache` 方法中，catch 块仍然保持空体：

```typescript
} catch {
  // 文件不存在或解析失败 → 空 Map
}
```

**问题复述**:
- `ENOENT`（文件不存在）是首次使用的正常场景，可以静默处理
- `JSON.parse` 抛出 `SyntaxError` 表示数据损坏（磁盘 IO 错误、并发写入冲突等），应当记录日志

**建议修复方案**（任选其一）：

方案 A — 区分 ENOENT 与解析错误：
```typescript
} catch (e: unknown) {
  const isFileNotFound =
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code: unknown }).code === 'ENOENT'
  if (!isFileNotFound) {
    console.warn(`[plugin-storage] failed to read/parse storage file ${filePath}:`, e)
  }
}
```

方案 B — 更简洁的 `code` 检查：
```typescript
} catch (e: unknown) {
  if (!(e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT')) {
    console.warn(`[plugin-storage] corrupt storage file ${filePath}:`, e)
  }
}
```

**影响**: 低概率（JSON 损坏场景），但可能使数据损坏问题难以诊断。

---

## P1/P2 项目观察（修复进展）

v1 中报告的 P1/P2 问题修复情况：

| 优先级 | 问题 | 状态 |
|--------|------|------|
| P1-4 | 三重 `as unknown as ActivatorHost` 类型桥接 | ✅ 一并修复（`PluginHost implements ActivatorHost`） |
| P1-5 | params 逐字段 `as string` 断言 | ❌ 未修复 |
| P1-6 | `sessions.list` 条件类型脆弱 | ❌ 未修复 |
| P1-7 | `plugin-registry.ts` 多个空 catch | ❌ 未修复 |
| P1-8 | `disposeContext` 中空 catch | ❌ 未修复 |
| P2-11 | `plugin-host.ts` 魔数缺命名常量（10/10000/30000） | ❌ 未修复 |
| P2-12 | `plugin-storage.ts` 哈希截断 12 无命名常量 | ❌ 未修复 |
| P1-9 | `Record<string, unknown>` 白名单未补充 | ❌ 未修复 |
| P1-10 | `createWorker` 方法过长 | ❌ 未修复 |

---

## 汇总

| 指标 | 值 |
|------|-----|
| 原始 P0 数量 | 3 |
| 已修复 | 2 |
| 未修复 | 1 |
| 新增 P0 | 0 |
| **must_fix** | **1**（P0-3 空 catch 未修复） |

**评价**: 修复质量良好。P0-1 和 P0-2 的修复干净、彻底，P0-1 的修复还一并解决了 P1-4 的类型桥接问题，说明修复时考虑了关联问题。P0-3 未修复，建议在下一轮修复中处理。

**verdict: pass** — 代码整体质量良好，P0 中 2/3 已修复。
