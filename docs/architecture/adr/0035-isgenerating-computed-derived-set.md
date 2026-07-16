# ADR 0035：isGenerating 改用 computed 派生 Set

- 状态：Accepted
- 日期：2026-07-16

## 背景

chat store 的 `isGenerating(sessionId)` 当前是 O(n) 派生函数：

```ts
function isGenerating(sessionId: string): boolean {
  const list = messages.value.get(sessionId)
  if (!list) return false
  return list.some((m) => m.status === 'streaming')  // O(n) 遍历
}
```

它被多处消费：侧栏 `deriveStatus`（每个 session 项）、Panel/Composer/Turn 的单 session computed。侧栏 `statusOf` 又每次新建 computed（缓存失效），导致侧栏每次渲染 O(N×M)——对话越长、session 越多，列表越卡。

## 决策

新增 `streamingSessionIds` computed 派生 Set，`isGenerating` 改用它：

```ts
const streamingSessionIds = computed(() => {
  const ids = new Set<string>()
  for (const [sid, msgs] of messages.value) {
    if (msgs.some((m) => m.status === 'streaming')) ids.add(sid)
  }
  return ids
})

function isGenerating(sessionId: string): boolean {
  return streamingSessionIds.value.has(sessionId)  // O(1)
}
```

不变式 `isGenerating(sid) ≡ ∃ m ∈ messages[sid], m.status === 'streaming'` 保持——派生逻辑完全相同，只是从"每次调用扫描"变成"messages 变化时扫描一次并缓存"。

## 替代方案

- **手动维护 Set（命令式 add/delete）**：经全量追踪发现 13+ 处写入点 + 3 个危险边界点（`truncateFrom` / `disposeSession` / `hydrate`+`setMessages`），这些不改 message status 却能改变 isGenerating 结果。手动维护极易漏维护某处，导致 Set 与实际状态撕裂。
- **维持 O(n) 派生函数**：单次查询成本随对话长度线性增长，治标不治本。

## 后果

- 正面：`isGenerating` 单次查询 O(1)。配合 statusOf 缓存化，侧栏渲染从 O(N×M) 降到 O(变化 session 数 × M)。
- 正面：computed 派生是单一真相源，物理不可撕裂——任何写入路径（含未来新增）自动覆盖。与原设计"从 message 派生"理念一致，只是加了缓存层。
- 正面：消除"每个消费点重复扫描"的浪费——messages 变化时一次扫描，服务所有 isGenerating 查询。
- 负面：messages 变化时全量扫所有 session（O(总消息数)）。但这个开销本来就有（响应式系统要重新求值），且从"每个消费点各扫一遍"变成"全局扫一次"，净收益为正。
- 依赖 ADR 0034：shallowRef 下 messages 的 Map.set 仍触发 computed 重算（理论兼容，需测试验证）。
