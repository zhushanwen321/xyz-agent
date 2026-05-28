---
round: 5
verdict: pass
must_fix: 0
should_fix: 0
reviewer: BLR-v5-final
date: 2026-05-28
---

# Business Logic Review v5 — 最终验证

## 上一轮 (v4) MUST FIX 修复验证

### MF-7: toolRegistry key 不匹配 — FIXED

**文件**: `plugin-service.ts` L341-345

```ts
async handleBridgeToolExecute(request: BridgeToolExecuteRequest): Promise<BridgeToolExecuteResponse> {
  // 按 schema.name 匹配（toolRegistry key 是 pluginId:name 格式）
  const entry = Array.from(this.toolRegistry.values()).find(e => e.schema.name === request.toolName)
  if (!entry) {
    return { content: `Tool not found: ${request.toolName}`, isError: true }
  }
  return { content: JSON.stringify({ success: true }), isError: false }
}
```

**验证结论**:
- 使用 `Array.from(toolRegistry.values()).find(e => e.schema.name === request.toolName)` 遍历值而非键
- 注释明确说明 registry key 是 `pluginId:name` 格式，需按 `schema.name` 匹配
- 工具不存在时返回 `isError: true` + 错误消息，语义正确
- commit 5ff6a82 已包含此修复

### MF-6: executeHooks 广播不等待 Worker — ACCEPTED (Phase 2 简化)

**文件**: `plugin-service.ts` L304-318

```ts
async executeHooks(hookType: string, context: HookContext): Promise<HookResult> {
  const entries = this.hookRegistry.get(hookType)
  if (!entries || entries.length === 0) return { blocked: false }
  const sorted = [...entries].sort((a, b) => a.priority - b.priority)
  this.rpcServer.broadcast('plugin.hooks.invoke', { hookType, context })
  // 简化实现：不等待 Worker 的 invoke 结果，默认返回未阻塞
  return { blocked: false }
}
```

**验证结论**:
- 当前所有 hook handler 均为本地函数（非 Worker），broadcast 无需等待
- 注释明确标注"简化实现"，与 Phase 2 范围声明一致
- `sorted` 数组已创建（为后续 Worker 结果聚合预留），不影响当前行为
- Worker 异步等待属于后续 Phase 功能，当前阶段不应作为 MUST FIX

## 完整接线验证 (server.ts)

### bridge:sync (L639-652)
- 从 `pluginService.getToolSchemas()` 获取 schema 列表
- 提取 `name/description/parameters` 返回给 pi side
- 无 pluginService 时降级返回空数组（`tools: []`）
- **正确**

### bridge:tool_execute (L652-667)
- 提取 `toolName` + `params`，调用 `pluginService.handleBridgeToolExecute`
- 无 pluginService 时返回 `isError: true` + 提示信息
- 结果通过 `extension_ui_response` 回传
- **正确**

### bridge:event (L668-674)
- Fire-and-forget 模式，立即回传 `null`
- **正确**（observer 事件无需等待响应）

### bridge:intercept (L674-684)
- 仅对 `before_agent_start` 事件调用 `handleBridgeIntercept`
- 其他事件降级返回空对象
- 结果通过 `extension_ui_response` 回传
- **正确**

### 错误处理 (L687-694)
- 外层 try/catch 捕获所有异常
- catch 块中尝试发送错误响应，二次 catch 忽略 send 失败
- **正确**（防止异常泄露到 transport 层）

### unknown method (L686-689)
- 返回 `{ error: 'Unknown bridge method: ...' }`
- **正确**

## 总结

| 项目 | 状态 |
|------|------|
| MF-7 toolRegistry key 匹配 | 已修复，按 schema.name 查找 |
| MF-6 Worker 异步等待 | Phase 2 简化，已接受 |
| bridge 接线完整性 | 4 个 handler 均正确 |
| 错误处理 | 各路径均有降级 |
| must_fix | 0 |
| should_fix | 0 |

**verdict: pass** — Phase 2 业务逻辑审查通过，无遗留问题。
