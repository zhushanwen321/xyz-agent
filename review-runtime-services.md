# Runtime Services 代码审查报告

**审查范围**: `packages/runtime/src/services/` 目录下 11 个文件
**分支**: fix-046-problems (对比 origin/main)
**审查时间**: 2026-06-12

---

## 发现汇总

| 严重程度 | 数量 |
|---------|------|
| BLOCKER | 1 |
| WARNING | 4 |
| SUGGESTION | 3 |

---

## BLOCKER

### 1. plugin-rpc-setup.ts — `findActiveSession` 缓存命中时未返回缓存值

**文件**: `packages/runtime/src/services/plugin-service/plugin-rpc-setup.ts`
**行号**: L37-L42

**描述**: `findActiveSession()` 的缓存命中分支（TTL 未过期时）只有一个注释，**没有任何 return 语句**。缓存命中时代码会 fallthrough 到下面的「Cache miss」路径，重新执行完整的 `listPersistedSessions()` 扫描——缓存完全无效。

```typescript
if (_activeSessionCache && (now - _activeSessionCache.ts) < ACTIVE_SESSION_CACHE_TTL_MS) {
    // Return cached active session — find it in the full list
    // This avoids a full scanPiSessions() + readGitInfo() per call
    // ⚠️ 缺少 return！直接 fallthrough 到下面的完整扫描
}
```

**影响**: 每次 plugin RPC 调用 `getModel`/`setModel`/`getThinkingLevel`/`setThinkingLevel` 都会触发完整 session 列表扫描 + 每个活跃 session 的 `readGitInfo` 调用（虽然有 git-info 级别缓存，但 `listPersistedSessions` 本身有磁盘 I/O）。在高频 RPC 调用场景下（如插件轮询 model 状态）会产生不必要的开销。

**建议修复**:

```typescript
function findActiveSession(deps: IPluginServiceDeps): { id: string; thinkingLevel?: string; modelId?: string } | undefined {
  if (!deps.sessionService) return undefined
  const now = Date.now()
  if (_activeSessionCache && (now - _activeSessionCache.ts) < ACTIVE_SESSION_CACHE_TTL_MS) {
    // Cache hit — re-lookup from full list to get fresh modelId/thinkingLevel
    const groups = deps.sessionService.listPersistedSessions()
    const cached = groups.flatMap(g => g.sessions).find(s => s.id === _activeSessionCache.sessionId)
    if (cached) return cached
    // cached session gone (deleted/expired) — fall through to rescan
  }
  // Cache miss or expired
  const groups = deps.sessionService.listPersistedSessions()
  const active = groups.flatMap(g => g.sessions).find(s => s.status === 'active')
  // ...
}
```

或者更简洁：缓存命中时直接用 sessionId 从 sessionService 获取，而不是全量扫描。

---

## WARNING

### 2. session-data-store.ts — `getCache()`/`getDirty()`/`getSizeTracker()` 暴露可变内部状态

**文件**: `packages/runtime/src/services/plugin-service/session-data-store.ts`
**行号**: L41-L51

**描述**: `SessionDataStore` 封装了三张 Map，但通过 getter 直接返回可变引用。`session-data-api` RPC handler 可以绕过 `SessionDataStore` 直接对 Map 做 set/delete 操作，这和「封装散落 Map」的重构目标矛盾。如果未来要在 `SessionDataStore` 里加 size 上限校验或 dirty 标记拦截，所有直接操作 Map 的外部代码都不会经过拦截。

当前 NOTE 注释说明了这一点（"如需加校验拦截，需将操作收拢到 mutation 方法中"），但这只是推迟了问题。

**建议**: 当前阶段可以接受（注释已标注 tradeoff），但应在 TODO / tracking issue 中记录，避免遗忘。

### 3. config-service.ts — `loadAppConfig` 只保留 `toolPermissions`，丢弃其他字段

**文件**: `packages/runtime/src/services/config-service.ts`
**行号**: L185-L193

**描述**: `loadAppConfig()` 从 `config.json` 读取后，只提取 `toolPermissions` 字段，其他字段被丢弃。`saveAppConfig()` 写回时也只写 `{ toolPermissions }` 对象。这意味着如果未来 `config.json` 新增其他配置字段（如 `theme`、`language`），`updateToolPermissions` 会静默丢失这些字段。

当前不是 bug（只有 `toolPermissions` 一个字段），但属于数据丢失隐患。

**建议**: `loadAppConfig` 应返回完整对象，`saveAppConfig` 应合并写入而非覆盖：

```typescript
private static loadAppConfig(): Record<string, unknown> {
  // ... 读取完整对象
}

private static saveAppConfig(config: Record<string, unknown>): void {
  // 保留未知字段
}
```

### 4. session-service.ts — `sendSubagentMessage` 和 `sendMessage` 大量重复代码

**文件**: `packages/runtime/src/services/session-service.ts`
**行号**: L250-L297 (sendSubagentMessage) vs L217-L248 (sendMessage)

**描述**: `sendSubagentMessage` 几乎完全复制了 `sendMessage` 的逻辑：ensureActive → hook → 更新 session 状态 → prompt → 错误处理。唯一的差异是 prompt 内容多了 marker 前缀。文件顶部的 TODO 已标注计划提取 MessageService，但当前两个方法的重复代码如果需要修改（比如错误处理逻辑变更），容易只改一处漏改另一处。

**建议**: 提取一个 `sendPrompt(sessionId, content, hookContent?)` 内部方法，`sendMessage` 和 `sendSubagentMessage` 都委托给它。`hookContent` 参数允许 hook 审核原始内容而非 marker。

### 5. git-info.ts — `pruneGitInfoCache` 在遍历 Map 时调用 delete

**文件**: `packages/runtime/src/services/git-info.ts`
**行号**: L29-L33

**描述**: `pruneGitInfoCache()` 在 `for (const key of gitInfoCache.keys())` 循环中直接调用 `gitInfoCache.delete(key)`。JavaScript 的 Map 规范允许在 `keys()` 迭代器遍历中删除当前元素（不会跳过或重复），所以这不是 bug，但有些代码审查工具/lint 会标记这种行为。

更重要的是，每次 `listAll()` 都会调用 `pruneGitCache(result)`，而 `listAll()` 在 WS 连接、session 创建/删除/重命名、进程退出时都会触发。如果 session 数量很多（500+），每次都遍历整个 gitInfoCache 检查 TTL 效率不高。

**建议**: 可以改为增量清理（只清理不在 existingCwds 中的 key），TTL 检查移到 `readGitInfo` 的 cache hit 路径中（当前已有，但 prune 又重复做了一次）。低优先级。

---

## SUGGESTION

### 6. model-service.ts — `nextPushId` 用 `Date.now()` 在高频场景下可能碰撞

**文件**: `packages/runtime/src/services/model-service.ts`
**行号**: L24

**描述**: `push_${Date.now()}` 在同一毫秒内多次调用会生成相同 ID。虽然 `switchModel` 不太可能被高频调用（用户操作驱动），但作为 push message ID 应该保证唯一性。

**建议**: 构造函数接受 `pushIdFactory` 参数（已有）并传入 `crypto.randomUUID()`，或改用递增计数器。

### 7. tree-service.ts — `cloneSession`/`forkFromEntry` 返回 `sessionFile` 但调用方可能未使用

**文件**: `packages/runtime/src/services/tree-service.ts`
**行号**: L178-L182, L202-L206

**描述**: clone 和 fork 现在返回 `sessionFile` 字段（新增），用于上层 `rebindAfterFork` 时避免活跃 session 被重复扫描。这是正确的改进。但如果调用方不使用这个字段（如旧的 fork 调用路径），`sessionFile` 会被忽略。

**建议**: 确认所有调用 `cloneSession`/`forkFromEntry` 的地方都正确传递了 `sessionFile` 到 `rebindAfterFork`。

### 8. config-service.ts — `updateToolPermissions` 每次都先读再写整个文件

**文件**: `packages/runtime/src/services/config-service.ts`
**行号**: L203-L206

**描述**: `updateToolPermissions(permissions)` 每次调用都：读 config.json → 替换 toolPermissions → 写回 config.json。如果短时间内多次调用（如批量更新权限），会产生冗余 I/O。

**建议**: 低优先级。可以加内存缓存 + dirty 标记，或让调用方批量传入。当前调用频率不高，不是性能瓶颈。

---

## 总体评价

变更整体质量良好：

1. **SessionDataStore 抽取**：将散落在 PluginService 中的三张 Map + flush 逻辑收拢到独立类，职责更清晰
2. **ensureActive 提取**：消除了 sendMessage/session.switch/compact 中的重复 restore 逻辑
3. **git-info 缓存**：解决了每次 listPersistedSessions 时对每个 session 执行 `execSync` 的性能问题，TTL + LRU 容量限制合理
4. **ModelService 统一入口**：switchModel/setThinkingLevel 的持久化 + 广播逻辑集中化，plugin RPC 和 WS handler 走同一路径
5. **tree-service navigate 验证**：增加了 pi extension 静默失败的检测（cancelled 检查）
6. **clone/fork 返回 sessionFile**：解决了 rebindAfterFork 后活跃 session 被重复扫描的问题

**唯一的 BLOCKER** 是 `findActiveSession` 的缓存逻辑完全无效（缺少 return），建议优先修复。
