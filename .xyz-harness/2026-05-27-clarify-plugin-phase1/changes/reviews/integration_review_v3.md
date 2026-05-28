---
verdict: pass
must_fix: 0
---

# 集成审查 v3

- **审查时间**: 2026-05-28
- **审查类型**: 第3轮 — v2 遗留 3 条问题修复验证
- **结论**: 全部修复，通过

## 逐条验证

### ISSUE #4 — flush() 硬编码 'global' scope → ✅ 已修复

**v2 问题**: `flush(pluginId)` 只 flush global cache，workspace scope 的 debounced auto-flush 失效。

**当前代码** (`plugin-storage.ts:76-90`):
```typescript
async flush(pluginId: string): Promise<void> {
    // flush 所有 scope（global + workspace）
    for (const scope of ['global', 'workspace'] as const) {
      const cacheKey = `${pluginId}:${scope}`
      const cache = this.caches.get(cacheKey)
      if (!cache || !cache.dirty) continue
      if (cache.flushTimer) { clearTimeout(cache.flushTimer); cache.flushTimer = null }
      await this.writeToDisk(pluginId, scope, cache)
      cache.dirty = false
    }
}
```

**验证**: 遍历两个 scope，每个 dirty cache 独立持久化。`scheduleFlush` 回调调用 `flush(pluginId)` 时会正确 flush workspace scope。

### ISSUE #6 — panels/statusBarItems 推断缺失 → ✅ 已处理

**v2 问题**: `inferActivationEvents()` 未处理 `contributes.panels` 和 `contributes.statusBarItems`，声明了这些但无其他 activationEvents 的插件不会被懒激活。

**当前代码** (`plugin-registry.ts:130-132`):
```typescript
    // Phase 1 不为 panels/statusBarItems 推断 activation events（无对应事件类型）
    // panels/statusBarItems 的激活由 Phase 3+ 的 UI 扩展机制处理
    return events
```

**验证**: 代码未增加推断逻辑，但添加了注释说明这是 Phase 1 的有意范围限定（panels/statusBarItems 没有对应的 activationEvent 类型），由 Phase 3+ 处理。属于设计决策而非遗漏，且已文档化。

### ISSUE #7 — broadcastPluginList() 双映射回归 → ✅ 已修复

**v2 问题**: `broadcastPluginList()` 对 `getDiscoveredPlugins()` 返回的已映射状态再次调用 `mapStateForProtocol()`，导致所有广播 status 变为 'inactive'。

**当前代码** (`plugin-service.ts:166-173`):
```typescript
private broadcastPluginList(): void {
    const plugins = this.getDiscoveredPlugins()
    this.broker.broadcast({
      type: 'config.plugins',
      id: `plugins_${Date.now()}`,
      payload: { plugins },
    })
}
```

**验证**: 直接使用 `getDiscoveredPlugins()` 返回值，不再二次映射。`initialize()` 后广播和 `togglePlugin()` 后广播的 status 字段现在正确。

## 总结

| # | 问题 | v2 状态 | v3 状态 |
|---|------|---------|---------|
| 4 | flush() 硬编码 global | ⚠️ 部分修复 | ✅ 遍历两个 scope |
| 6 | panels/statusBarItems 推断 | ⚠️ 部分修复 | ✅ 有意省略 + 注释说明 |
| 7 | broadcastPluginList 双映射 | ❌ 新回归 | ✅ 删除二次映射 |

所有关键路径（懒激活 CR-1、Worker RPC 存储 CR-2、Workspace 隔离存储 CR-3、关闭流程 CR-4、崩溃处理 CR-5）均已通过。
