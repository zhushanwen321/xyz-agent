---
review:
  type: code_review
  round: 2
  timestamp: "2026-05-28T18:00:00"
  target: "src-electron/runtime/src/services/plugin-service/"
  verdict: fail
  summary: "第 2 轮审查完成，8 条 MUST_FIX 中 5 条已修复，3 条未修复：issue #3（inferActivationEvents 不完整）、#5（崩溃自动重建）、#7（Activator 崩溃状态未更新）"
  based_on: "business_logic_review_v1.md 的 8 条 MUST_FIX，逐一验证源代码"

statistics:
  total_issues: 8
  must_fix: 3
  must_fix_resolved: 5
  low: 0
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "plugin-activator.ts / plugin-host.ts"
    title: "ActivatorHost assignWorker 返回类型不兼容"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "plugin-host.ts worker.on('message') handler"
    title: "Worker 生命周期消息（activated/deactivated）被 PluginHost 静默丢弃"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: MUST_FIX
    location: "plugin-registry.ts:113-128 inferActivationEvents()"
    title: "activationEvents 自动推断仅处理 slashCommands，遗漏 tools/hooks/panels/statusBarItems"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "plugin-service.ts registerRpcMethods()"
    title: "Workspace 存储 RPC 方法（plugin.storage.workspace.*）未注册"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 5
    severity: MUST_FIX
    location: "plugin-host.ts handleWorkerCrash()"
    title: "Trusted Worker 崩溃后自动重建未实现"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: MUST_FIX
    location: "plugin-service.ts setCrashCallback lambda"
    title: "崩溃通知 payload 字段名和结构不匹配 protocol.ts 定义的 PluginCrashedPayload"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 7
    severity: MUST_FIX
    location: "plugin-service.ts setCrashCallback lambda"
    title: "Worker 崩溃后 Activator 插件状态未更新（getState() 返回值仍被丢弃）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: MUST_FIX
    location: "plugin-service.ts mapStateForProtocol()"
    title: "PluginDescriptor.status UPPER_CASE 与协议 PluginInfo.status lower_case 不匹配"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
---

# 业务逻辑审查 v2

## 审查说明

- **审查时间**: 2026-05-28 18:00
- **审查类型**: 修复验证（Round 2，逐条回溯 Round 1 的 8 条 MUST_FIX）
- **审查依据**: business_logic_review_v1.md（8 条 MUST_FIX）+ 当前源代码
- **方法**: 逐条对比 v1 发现项与当前源代码

---

## V1→V2 修复验证

### Issue #1（assignWorker 返回类型不兼容）— ✅ 已修复

**v1 发现问题**:
- `ActivatorHost` 接口中 `assignWorker` 声明返回 `Promise<string>`
- `PluginHost.assignWorker` 实际返回 `WorkerHandle`（对象）
- `plugin-service.ts` 通过 `as unknown as ActivatorHost` 强转跳过了类型检查
- 结果：`activatePlugin()` 中 `workerInstances.get(workerId)` 用对象查 Map<string, Worker> → 找不到

**当前代码验证**:

`plugin-activator.ts` — `PluginHost` 接口定义:
```typescript
export interface PluginHost {
  assignWorker(pluginId: string, trustLevel: 'trusted' | 'sandbox'): Promise<string>
  loadPlugin(workerId: string, pluginPath: string): Promise<void>
  terminateWorker(workerId: string): Promise<void>
  getWorkerHandle(pluginId: string): { workerId: string; postMessage(message: unknown): void } | undefined
}
```

`plugin-host.ts` — `PluginHost` 类实现:
```typescript
export class PluginHost implements ActivatorHost {
  async assignWorker(pluginId: string, trustLevel: 'trusted' | 'sandbox'): Promise<string> {
    ...
    return this.createWorker(workerId, 'sandbox', pluginId).workerId  // 返回 string
  }
}
```

`plugin-service.ts` — 不再使用 `as unknown as`:
```typescript
this.host = new PluginHost(this.rpcServer)
...
await this.activator.handleEvent({ type: 'onStartupFinished' }, this.host)
```

**验证结论**:
1. `PluginHost` 直接 `implements` `plugin-activator.ts` 导出的 `PluginHost`（即原 `ActivatorHost`）接口 ✓
2. `assignWorker` 返回 `Promise<string>` ✓
3. `PluginActivator.activatePlugin()` 中 `host.assignWorker()` 返回值作为 string 传给 `host.loadPlugin()` ✓
4. `plugin-service.ts` 不再使用 `as unknown as` 强转 ✓

**状态: 已修复**

---

### Issue #2（Worker 生命周期消息路由丢失）— ✅ 已修复

**v1 发现问题**:
- `PluginHost.createWorker()` 的 `worker.on('message')` 只处理 `rpc`、`fatal_error`、`error`
- Bootstrap 发送的 `{ type: 'activated', pluginId }` 被静默丢弃
- `PluginActivator.sendAndWaitReply()` 永远收不到确认信号，30 秒超时

**当前代码验证**:

`plugin-host.ts` — `worker.on('message')` 处理器:
```typescript
worker.on('message', (msg: unknown) => {
  const m = msg as Record<string, unknown>
  if (m.type === 'rpc') {
    this.rpcServer.dispatch(workerId, m as unknown as RpcRequest)
  } else if (m.type === 'fatal_error') {
    this.handleWorkerCrash(workerId, String(m.error ?? 'unknown'))
  } else if (
    m.type === 'activated' ||
    m.type === 'deactivated' ||
    m.type === 'error'
  ) {
    // 生命周期回复：转发给 Activator
    this.onReply?.(msg)
  }
})
```

`plugin-service.ts` — `setReplyCallback` 注册:
```typescript
this.host.setReplyCallback((msg) => {
  this.activator.handleWorkerReply(msg as WorkerToHostMessage)
})
```

**验证结论**:
1. `PluginHost` 新增了 `setReplyCallback(cb)` 方法和 `onReply` 字段 ✓
2. `activated` / `deactivated` / `error` 消息通过 `onReply` 回调转发 ✓
3. `PluginActivator.handleWorkerReply()` 根据消息类型 `resolve(true/false)` ✓
4. 完整链路：Worker → `worker.on('message')` → `onReply` → `PluginActivator.handleWorkerReply` → `pending.resolve()` ✓

**状态: 已修复**

---

### Issue #3（inferActivationEvents 不完整）— ❌ 未修复

**v1 发现问题**:
- `inferActivationEvents()` 只处理 `contributes.slashCommands`
- `code-reviewer` 插件通过 `contributes.tools` 声明的 `onToolCall:reviewCode` 不会被推断
- 修复方向：扩展推断逻辑到 tools、hooks、panels、statusBarItems

**当前代码验证**:

`plugin-registry.ts`:
```typescript
private inferActivationEvents(
    declared: string[],
    contributes?: PluginContributes,
): string[] {
    const events = [...declared]
    if (contributes?.slashCommands) {
      for (const cmd of contributes.slashCommands) {
        const event = `onSlashCommand:${cmd.name}`
        if (!events.includes(event)) events.push(event)
      }
    }
    return events
}
```

**验证结论**:
1. 仍只处理 `slashCommands`，未处理 `tools`、`hooks`、`panels`、`statusBarItems` ✗
2. `PluginContributes` 类型已定义 `tools`、`hooks`、`panels`、`statusBarItems` 字段（v1 时已存在），但 `inferActivationEvents` 函数体未扩展 ✗

**未修复原因猜测**: 遗漏。建议在 `slashCommands` 分支后加入：
```typescript
if (contributes?.tools) {
  for (const tool of contributes.tools) {
    const event = `onToolCall:${tool.name}`
    if (!events.includes(event)) events.push(event)
  }
}
if (contributes?.hooks) {
  for (const hook of contributes.hooks) {
    const event = `onHook:${hook}`
    if (!events.includes(event)) events.push(event)
  }
}
if (contributes?.panels?.length || contributes?.statusBarItems?.length) {
  if (!events.includes('onStartupFinished')) events.push('onStartupFinished')
}
```

**状态: 未修复**

---

### Issue #4（Workspace storage RPC 方法缺失）— ✅ 已修复

**v1 发现问题**:
- `registerRpcMethods()` 只注册了 `plugin.storage.global.*`（4 个方法）
- 未注册 `plugin.storage.workspace.*`
- `context.api.storage.workspace.set('key', value)` 返回 `METHOD_NOT_FOUND`

**当前代码验证**:

`plugin-service.ts`:
```typescript
// Storage RPC methods — workspace scope
this.rpcServer.registerMethod('plugin.storage.workspace.get', async (params) => {
  return this.storage.get(params.pluginId as string, params.key as string, 'workspace')
})
this.rpcServer.registerMethod('plugin.storage.workspace.set', async (params) => {
  await this.storage.set(params.pluginId as string, params.key as string, params.value, 'workspace')
})
this.rpcServer.registerMethod('plugin.storage.workspace.delete', async (params) => {
  await this.storage.delete(params.pluginId as string, params.key as string, 'workspace')
})
this.rpcServer.registerMethod('plugin.storage.workspace.keys', async (params) => {
  return this.storage.keys(params.pluginId as string, 'workspace')
})
```

**验证结论**:
1. `plugin.storage.workspace.*` 四个方法（get/set/delete/keys）已全部注册 ✓
2. 各方法调用 `PluginStorage` 对应方法时传入了 `'workspace'` scope 参数 ✓
3. `PluginStorage.getFilePath()` 中 workspace 路径的 hash 逻辑 v1 中已实现 ✓
4. Worker 侧 bootstrap 已创建 `workspaceState` proxy（v1 代码已存在）✓

**状态: 已修复**

---

### Issue #5（Trusted Worker 崩溃自动重建）— ❌ 未修复

**v1 发现问题**:
- `handleWorkerCrash()` 只做了 crashed 标记和通知
- spec FR-3 要求 trusted Worker → 自动重建新 Worker，重新加载所有 trusted 插件
- 当前没有任何重建逻辑

**当前代码验证**:

`plugin-host.ts`:
```typescript
private handleWorkerCrash(workerId: string, error: string): void {
    const handle = this.workers.get(workerId)
    if (!handle || handle.status === 'crashed' || handle.status === 'terminated') return

    handle.status = 'crashed'
    const pluginIds = [...handle.pluginIds]
    this.rpcServer.unregisterWorker(workerId)

    // TODO (Phase 2): 如果是 trusted Worker，标记为需要重建，
    // 等待下次 assignWorker 时自动重新创建。
    // Phase 1 先不实现重建逻辑，仅清理状态。
    if (handle.trustLevel === 'trusted') {
      this.workerInstances.delete(workerId)
      this.workers.delete(workerId)
    }

    this.onCrash?.(workerId, pluginIds, error)
}
```

**验证结论**:
1. 相比 v1 的改进：trusted Worker crash 后从 maps 中删除 handle ✗（仅清理，非自动重建）
2. 自动重建 Worker 的逻辑完全未实现 ✗
3. 即使 maps 已清理，PluginActivator 仍认为插件为 `'ACTIVE'`（issue #7 未修复），下次激活不会触发 assignWorker ✗
4. TODO 注释明确说 Phase 2 实现，**不是** Phase 1 的修复 ✗

**状态: 未修复**

---

### Issue #6（崩溃通知 payload 格式不匹配）— ✅ 已修复

**v1 发现问题**:
```typescript
// 旧代码：
this.broker.broadcast({
  type: 'plugin:crashed',
  payload: { _workerId, pluginIds, error }  // 字段名和类型都不匹配
})
// protocol.ts 定义：
// PluginCrashedPayload = { pluginId: string; workerId: string; error: string }
```

**当前代码验证**:

`plugin-service.ts`:
```typescript
this.host.setCrashCallback((workerId, pluginIds, error) => {
  for (const pluginId of pluginIds) {
    this.broker.broadcast({
      type: 'plugin:crashed',
      id: `crash_${pluginId}_${Date.now()}`,
      payload: { pluginId, workerId, error },
    })
  }
})
```

**验证结论**:
1. 每个 pluginId 独立发送一条广播，payload 包含 `{ pluginId, workerId, error }` ✓
2. `pluginId` 字段名与 `PluginCrashedPayload` 定义的 `pluginId: string` 一致 ✓
3. `workerId` 字段名与 `PluginCrashedPayload` 定义的 `workerId: string` 一致 ✓
4. `error` 字段名与 `PluginCrashedPayload` 定义的 `error: string` 一致 ✓
5. 广播消息增加了 `id` 字段，便于前端去重 ✓
6. 不再使用 `_workerId` 下划线前缀和 `pluginIds` 数组 ✓

**状态: 已修复**

---

### Issue #7（Activator 插件状态未更新）— ❌ 未修复

**v1 发现问题**:
- crash callback 中 `this.activator.getState(pluginId)` 被调用但返回值被丢弃
- 崩溃后 `Activator.pluginStates` 仍标记插件为 `'ACTIVE'`
- 后续 `handleEvent()` 跳过这些插件（`state === 'ACTIVE' → filter out`）

**当前代码验证**:

`plugin-service.ts`:
```typescript
this.host.setCrashCallback((workerId, pluginIds, error) => {
  for (const pluginId of pluginIds) {
    void this.activator.getState(pluginId)  // ← 返回值仍被丢弃！
  }
  for (const pluginId of pluginIds) {
    this.broker.broadcast({
      type: 'plugin:crashed',
      id: `crash_${pluginId}_${Date.now()}`,
      payload: { pluginId, workerId, error },
    })
  }
})
```

同时检查 `PluginActivator` 类是否有 `markCrashed` 或等效方法：

`plugin-activator.ts` — 检查所有 public 方法:
- `registerDescriptors` ✓
- `handleEvent` ✓
- `activatePlugin` ✓
- `deactivatePlugin` ✓
- `deactivateAll` ✓
- `getActivePlugins` ✓
- `getState` ✓
- `handleWorkerReply` ✓
- **没有 `markCrashed`** ✗
- **没有任何修改 pluginStates 的公开方法（除了 registerDescriptors 间接设置）** ✗

**验证结论**:
1. `this.activator.getState(pluginId)` 返回值仍被丢弃 ✗
2. `PluginActivator` 没有 `markCrashed` 方法 ✗
3. 没有其他方式更新崩溃插件的状态 ✗
4. 崩溃后 pluginStates 仍为 `'ACTIVE'` → 后续 `handleEvent()` 跳过该插件 ✗
5. 即使 trusted Worker 重建（issue #5 理论上），activator 也不会尝试重新激活 ✗

**状态: 未修复**

---

### Issue #8（PluginDescriptor.status 值协议对齐）— ✅ 已修复

**v1 发现问题**:
- `PluginDescriptor.status` 值为 UPPER_CASE（`'UNLOADED'`、`'ACTIVE'`、`'CRASHED'`）
- 共享协议 `PluginInfo.status` 定义 lower_case 值（`'discovered'`、`'active'`、`'crashed'`）
- 前端收到 `status: "UNLOADED"` 与其类型定义不匹配

**当前代码验证**:

`plugin-service.ts` — 新增 `mapStateForProtocol` 转换方法:
```typescript
private mapStateForProtocol(state: string): string {
    switch (state) {
      case 'ACTIVE': return 'active'
      case 'CRASHED': return 'crashed'
      case 'LOADING':
      case 'UNLOADED':
        return 'discovered'
      default:
        return 'inactive'
    }
}
```

在 `getDiscoveredPlugins()` 中使用:
```typescript
return this.registry.getAllDescriptors().map(p => ({
    ...p,
    status: this.mapStateForProtocol(p.status) as PluginDescriptor['status'],
}))
```

在 `broadcastPluginList()` 中也使用:
```typescript
const rawPlugins = this.getDiscoveredPlugins()
const plugins = rawPlugins.map(p => ({
    ...p,
    status: this.mapStateForProtocol(p.status),
}))
```

**验证结论**:
1. `mapStateForProtocol()` 将内部 UPPER_CASE 状态转换为协议 lower_case 值 ✓
2. `getDiscoveredPlugins()` 和 `broadcastPluginList()` 都使用该转换 ✓
3. 前端正确收到 `'discovered'`、`'active'`、`'crashed'` 等 lower_case 值 ✓
4. 内部 `PluginState` 类型（UPPER_CASE）未修改，保持向后兼容 ✓
5. 注意：`getDiscoveredPlugins()` 中调用了两次 `mapStateForProtocol`（一次在 `getDiscoveredPlugins()` 内，一次在 `broadcastPluginList()` 内），但由于转换是幂等的，不影响结果 ✓

**状态: 已修复**

---

## 未修复项分析

### 剩余 3 条 MUST_FIX 及其影响

| ID | 严重度 | 文件 | 问题 | 影响 UC |
|----|--------|------|------|---------|
| #3 | MUST_FIX | plugin-registry.ts:113-128 | inferActivationEvents 仅处理 slashCommands，遗漏 tools/hooks/panels/statusBarItems | UC-3 |
| #5 | MUST_FIX | plugin-host.ts: handleWorkerCrash | Trusted Worker 崩溃后未自动重建 | UC-6 (FR-3) |
| #7 | MUST_FIX | plugin-service.ts: crash callback | Activator 插件状态在崩溃后未更新为 CRASHED，仍标记为 ACTIVE | UC-6 |

**#3 的影响**：
- 插件通过 `contributes.tools` 声明工具时，`onToolCall:<toolName>` 不会自动加入 activationEvents
- 需要插件开发者手动声明 `"activationEvents": ["onToolCall:reviewCode"]` 才能懒激活
- 对声明了 `contributes.hooks` 或 `contributes.panels` 的插件同理
- 临时绕过：插件手动声明 activationEvents 数组可正常工作
- **严重度评估**：功能不完整，但不阻塞已明确声明 activationEvents 的插件

**#5 的影响**：
- Trusted Worker 崩溃后不自动重建
- 当前行为：清除 maps + 通知前端，不做恢复
- 违反 spec FR-3 "trusted Worker → 自动重建"
- 但 Phase 1 scope 中自动重建可能被规划为 Phase 2（代码中 TODO 注释也指出 Phase 2）
- **严重度评估**：依赖 Phase scope 定义。如果 Phase 1 需要满足 FR-3，则必须修复

**#7 的影响**：
- 崩溃后插件状态卡在 `'ACTIVE'`，后续不会再尝试激活
- 这是 #5 的前置条件——即使自动重建 Worker，activator 也不会重新激活插件
- **严重度评估**：必须与 #5 协同修复，否则重建 Worker 后 activator 跳过该插件

### #7 修复建议

在 `PluginActivator` 中新增方法：

```typescript
/** 标记插件为崩溃状态。由 PluginService crash callback 调用。 */
markCrashed(pluginId: string): void {
  const state = this.pluginStates.get(pluginId)
  if (state === 'ACTIVE' || state === 'ACTIVATING') {
    this.pluginStates.set(pluginId, 'CRASHED')
    this.disposeContext(pluginId)
  }
}
```

并在 `plugin-service.ts` 的 crash callback 中调用：
```typescript
for (const pluginId of pluginIds) {
  this.activator.markCrashed(pluginId)
}
```

---

## 结论

**评审结论: 不通过，8 条 MUST_FIX 中仍有 3 条未修复**

| 优先级 | ID | 状态 | 摘要 |
|--------|----|------|------|
| P1 | #3 | ❌ 未修复 | inferActivationEvents 仅处理 slashCommands |
| P1 | #5 | ❌ 未修复 | Trusted Worker 崩溃自动重建未实现（标记为 Phase 2） |
| P1 | #7 | ❌ 未修复 | Activator 崩溃状态未更新，值仍被丢弃 |

**5 条已修复的确认**：
- #1: assignWorker 返回类型 — PluginHost 直接实现 ActivatorHost 接口，返回 string ✓
- #2: 生命周期消息路由 — onReply callback 桥接 PluginHost → PluginActivator ✓
- #4: workspace storage RPC — 4 个 workspace.* 方法已注册 ✓
- #6: 崩溃通知 payload — 每个 pluginId 独立发送 { pluginId, workerId, error } ✓
- #8: status 协议对齐 — mapStateForProtocol 转换函数到位 ✓
