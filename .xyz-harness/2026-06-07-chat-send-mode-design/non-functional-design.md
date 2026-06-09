---
verdict: pass
---

# Non-Functional Design — Chat Send Mode & Queue Display

## 1. 稳定性

steer/follow_up 改用 pi 原生 RPC 命令后，去掉了 abort+resend 的竞争条件。原实现中 abort 是异步的，sendMessage 可能在 abort 完成前到达 pi，导致不可预测行为。原生 steer/follow_up 由 pi 内部队列管理，无需前端协调时序。风险点：rpc-client 新增的 steer/followUp 方法需处理 session 不活跃的异常场景，通过 session-service 层的 client 空检查兜底。

## 2. 数据一致性

QueueState 数据来源单一（pi 的 `queue_update` 事件），前端只读不写。前端不维护独立的队列缓存，避免与 pi 端状态不一致。Message.sendMode 和 isInterrupted 字段在消息创建/完成时写入，之后不可变，不存在并发修改风险。container query 基于 CSS 的 `container-type: inline-size`，浏览器原生保证响应式状态与实际宽度一致。

## 3. 性能

Queue Component 最多渲染 5 条消息，超出部分仅显示 "+N 更多" 文字。queue_update 事件频率由 pi 控制（消息入队/出队时触发），不是高频事件。Global Loading Bar 使用 CSS transform 动画（GPU 加速），不触发布局重排。container query 在现代浏览器中性能开销可忽略（Chrome 105+、Safari 16+）。

## 4. 业务安全

Send Chip 和 Interrupted Marker 是纯展示组件，不影响消息发送逻辑。Mode Switcher 只改变发送参数，不修改历史消息。Queue Component 只读，不提供删除/修改队列消息的能力（pi RPC 不支持），消除了误操作风险。

## 5. 数据安全

sendMode 和 isInterrupted 存储在内存中的 Pinia store，不持久化到磁盘。队列数据来源于 pi 进程的实时推送，刷新后自然清空。无敏感信息泄露风险——消息内容预览已在 pi 端和消息流中可见，队列只是同一数据的另一种展示。
