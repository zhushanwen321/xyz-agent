---
verdict: pass
---

# ADR-0015：Event-bus 类型加固 — 方案 B（约束 ServerMessageType）

## 上下文

当前 event-bus（`src-electron/renderer/src/lib/event-bus.ts`）使用 `string type` + `(...args: any[])` handler 签名，没有任何编译时类型检查。随着 TUI→GUI 工作将 ServerMessageType 从 60+ 扩展到 70+，缺乏类型约束的事件分发增加了运行时风险。

## 决策

采用方案 B：将 `on()`/`emit()` 从 `string` 类型约束为 `ServerMessageType`，handler 签名统一为 `(msg: ServerMessage) => void`。

## 理由

- **迁移成本极低**：所有现有 handler 签名已是 `(msg: ServerMessage) => void`，只需改 type declaration，不需要改任何 handler body
- **编译时保护**：传入不存在的 event type 立即报错
- **渐进增强**：不改变 event-bus 的内部实现（仍然是 `Map<string, Set<EventHandler>>`），只约束公共 API 的签名
- **放弃方案 A**（`EventMap` 全类型映射）：需要为每个事件定义 payload 类型，约 70+ 条映射，与 `ServerMessage` 现有类型定义重复

## 后果

- 正面：编译器会在 emit() 时检查 event type 是否存在，防止拼写错误
- 负面：event-bus 丧失了传递任意类型参数的灵活性（但当前也不应该需要）
- 无兼容性问题：所有调用方无需修改代码

## 状态

Accepted
