# 主题 3：chat store 深模块化（重构 4 + 收尾 6）

## 重构 4：B6 *Impl 消除

### 现状

`core/domain/chat/store.ts` 935 行，6 个 *Impl 全保留，注释原样写「留在模块作用域以控制 setup 函数行数（max-lines-per-function）」——正是 B6 要消除的反模式：

| # | 方法名 | 定义行 | 调用点 | 职责 |
|---|---|---|---|---|
| 1 | disposeSessionImpl | 108 | 868 | 清理 session 全部 per-session 状态 |
| 2 | evictVirtualKeyImpl | 155 | 503 | 删单个虚拟 key 的 messages |
| 3 | appendSystemNoticeImpl | 163 | 858 | 追加 system 提示行 |
| 4 | applySubagentStreamDeltaImpl | 193 | 895 | subagent streaming delta |
| 5 | finalizeSubagentStreamImpl | 230 | 896 | subagent streaming 收口 |
| 6 | finalizeMessagesImpl | 318 | 703 | finalizeSession 的 message 终态映射 |

### 步骤 1：流式状态机深模块化

`applySubagentStreamDeltaImpl`(193) + `finalizeSubagentStreamImpl`(230) + `finalizeMessagesImpl`(318) 三者都是「messages ref 的 streaming→终态 mutate」，内聚为 `core/domain/chat/streaming-state-machine.ts`。

形态：factory 函数（持有 messages ref）或 class。

store.ts 持有 messages ref 并委托。

### 步骤 2：小函数内联

- `disposeSessionImpl`(108)：并入 store action `disposeSession`（deleteSession 编排的一部分，行数可控可内联；若仍超 max-lines，抽 class 而非 *Impl 函数）
- `evictVirtualKeyImpl`(155) + `appendSystemNoticeImpl`(163)：各 < 15 行，直接内联回 store action（本是简单委托，无需模块级函数）

### 目标

- `grep -c "Impl" store.ts` = 0
- store.ts < 600 行
- streaming-state-machine.ts 独立深模块，有独立测试

### 收益

消除「为绕 max-lines-per-function 拆的模块级 *Impl 函数」反模式；流式状态机内聚，可独立测试。

### 成本/风险

中（流式状态机深模块化 + 3 个小函数内联）。风险低（renderer store.ts 是 31 行薄 shim，*Impl 重构对消费方零 churn）。

### 与 useChat 的关系

正交。§13.3 是 store 内函数拆分（*Impl → 深模块），§11.1 是 composable 内 Map 范式（已接受 ADR-0049 例外，不重做）。建议同批做（范式一致性），但可独立推进。

---

## 收尾 6：envelope 下沉（§10.1，立即可做）

### 问题

`core/coordination/route-inbound.ts:257-280` 的 `msg.id` 分支内联 envelope 展开（~24 行）：

```ts
if (msg.id && ports.pending.has(msg.id)) {
  if (msg.type === 'error') {
    // envelope 展开：code 提取 + details.detail → Error 对象（~24 行内联）
    ports.pending.reject(msg.id, enrichedError)
  } else {
    ports.pending.resolve(msg.id, msg.payload)
  }
  return
}
```

pending.ts（`renderer/api/pending.ts`）是纯 resolve/reject/rejectAll/has 注册表，零 envelope。

### 修复

1. pending 层新增 `resolveEnvelope(msg)` 函数（接受原始 msg，内部做 code 提取 + details.detail 展开）
2. TransportPorts.pending 接口加 `resolveEnvelope(msg)` 方法
3. route-inbound 的 `msg.id` 分支改为：`ports.pending.resolveEnvelope(msg); return`
4. route-inbound 主体只剩 `ROUTE_TABLE.find` + FALLBACK

### 验收

```bash
grep -n "details.detail\|envelope" packages/core/src/coordination/route-inbound.ts  # 应为 0（除注释）
grep -n "resolveEnvelope" packages/renderer/src/api/pending.ts  # 应有命中
```

### 性质

独立低风险（~24 行搬迁 + TransportPorts 加方法 + pending.ts 加函数），有 `route-inbound.test.ts` 13.8KB 测试覆盖。不阻塞任何模块，可任意 wave 做。

---

## 主题 3 验收

- chat store *Impl 清零，streaming-state-machine 独立
- envelope 下沉 pending 层，route-inbound 纯路由
