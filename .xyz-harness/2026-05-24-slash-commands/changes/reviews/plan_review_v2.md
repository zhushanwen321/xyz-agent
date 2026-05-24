---
review:
  type: plan_review
  round: 2
  timestamp: "2026-05-24T11:00:00"
  target: ".xyz-harness/2026-05-24-slash-commands/plan.md"
  verdict: pass
  summary: "计划评审完成，第2轮通过，0条MUST FIX"

statistics:
  total_issues: 5
  must_fix: 0
  must_fix_resolved: 2
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 2 Step 4 / src-electron/runtime/src/event-adapter.ts"
    title: "IEventAdapter 接口不支持 navigate-result 拦截回调注册"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 6 Step 3"
    title: "navigate 后使用 session.switch 重新加载消息不正确"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: LOW
    location: "plan.md:BG1 Execution Group"
    title: "BG1 文件数标注不准确（标注14文件，实际10个唯一文件）"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: LOW
    location: "plan.md:Task 2 Step 2 (navigateTree 实现)"
    title: "navigateTree 中 Promise.race 与 EventAdapter 回调的协作机制未完全说明"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 5
    severity: INFO
    location: "e2e-test-plan.md:Scenario 3"
    title: "navigate 超时场景的 E2E 验证方式不明确"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v2（增量审查）

## 评审记录
- 评审时间：2026-05-24 11:00
- 评审类型：计划评审（增量审查）
- 评审对象：plan.md（基于 v1 评审的修复验证）
- 审查模式：增量审查 — 仅验证 v1 的 2 条 MUST FIX，扫描回归

---

## MUST FIX #1 修复验证：EventAdapter navigate-result 拦截回调注册

### 原问题

IEventAdapter/EventAdapter 没有回调注册接口，`translate()` 处理的所有结果都通过 `this.send()` 发送到 WS，没有出口让 SessionService 劫持 navigate-result 消息。如果按原 plan 实施，`navigate()` 会永久 pending。

### 修复内容

plan.md Task 2 Step 4 补充了完整的 intercept 机制：

| 维度 | 修复前 | 修复后 |
|------|--------|--------|
| 机制描述 | "结果由 EventAdapter 拦截后通过回调解析"（一句话带过） | 7 步详细机制 + 时序安全说明 |
| EventAdapter 字段 | 无 | `private navigateResolve: ((result: unknown) => void) \| null` |
| 注册方法 | 无 | `setNavigateResolver(fn)` |
| 注入时机 | 未说明 | navigateTree 调用 `client.prompt()` 之前 |
| 检测逻辑 | 未说明 | `translate()` 处理 `text_delta` 时检查是否以 `{"__xyz_type":"navigate-result"` 开头 |
| 匹配后行为 | 未说明 | 调用 resolve + 清除 resolver + **吞掉消息**（不翻译为 WS message） |
| 不匹配行为 | 未说明 | 正常翻译为 `message.text_delta` |
| 超时保护 | 未说明 | resolve 被清除，后续到达的消息被忽略 |
| 时序安全 | 未说明 | setNavigateResolver 每次覆盖上一次，超时兜底，无竞态 |

### 验证判断

**时序安全分析**：resolve 通过 `setNavigateResolver` 注入后，在 `translate()` 内被调用。`translate()` 由 RPC 事件流驱动，发生在 `client.prompt()` 之后。时序链为：

```
setNavigateResolver(resolve) → client.prompt() → pi 处理 → extension 发送 __xyz_type →
RPC 事件 → translate() → 检测到 navigate-result → resolve() → navigatePromise resolves
```

`setNavigateResolver` 先于 `prompt` 执行，不存在竞态。单次 navigate 仅触发一次，后续超时清理。**时序安全有保障。**

**残留风险**：plan 未说明 SessionService 如何获取 EventAdapter 实例（依赖注入路径）。这是实现细节，可在编码阶段通过 server.ts 协调（server 同时持有 EventAdapter 和 SessionService）。Issue #4 已标注为 LOW 且在本轮已解决（Step 4 描述足够详细，不必再要求 plan 规定 DI 路径）。

**判定：✅ 已修复**

---

## MUST FIX #2 修复验证：navigate 后消息刷新方式

### 原问题

navigate 在同一 session 内移动 leaf 指针，不创建新 session。使用 `session.switch` 会触发 session 切换副作用（新连接、上下文刷新），与 navigate 语义矛盾。

### 修复内容

plan.md Task 6 Step 3 完整重写：

| 维度 | 修复前 | 修复后 |
|------|--------|--------|
| 刷新方式 | `session.switch` | `session.history`（对应 pi 的 `get_messages`） |
| 刷新流程 | 未详述 | 5 步：清空消息 → session.history → 设置 editorText → 刷新 tree |
| 语义说明 | 无 | 明确注释：navigate 不创建新 session，session.switch 用于切换不同 session |

### 验证判断

**语义正确性**：`session.history` 从 pi 获取当前 session 的消息列表，navigate 后 leafId 指针已移动，`get_messages` 自然返回从 root 到新 leaf 的消息列表。无需且不应创建新 session 或建立新 WS 连接。

**流程完整性**：清空 → 重新加载 → 设置 editorText → 刷新 tree，四个步骤完整覆盖了 navigate 后的 UI 更新需求。

**判定：✅ 已修复**

---

## 回归检查

### #1 修复是否引入新风险

| 风险 | 评估 |
|------|------|
| `setNavigateResolver` 覆盖导致前一次 resolve 丢失 | 同一 session 的 navigate 操作天然串行（用户点击一次，等待结果后才能点下一次）。超时 5s 已提供兜底。无实际风险。 |
| `__xyz_type` JSON 跨多个 `text_delta` 分割 | pi extension 的 `ctx.sendMessage(jsonStr)` 发送完整 JSON，RPC 流中作为单条消息送达。Task 1 验证脚本会确认实际格式。已在 Step 4 末尾标注依赖关系。 |
| resolve 被调用后未清除，导致后续 WS 消息被吞 | Step 4 明确写"调用 navigateResolve(parsedResult) + **清除 resolver**"。已处理。 |

### #2 修复是否引入新风险

| 风险 | 评估 |
|------|------|
| `session.history` 在 navigate 后的返回值 | pi 的 `get_messages` 基于当前 leafId 返回消息列表，navigate 后 leafId 已更新，返回值自然正确。 |
| editorText 设置时机与输入框状态冲突 | 编辑态覆盖而非追加，单一输入框无并发冲突。 |

### 新增问题

无。

---

## 结论

**通过。**

v1 的 2 条 MUST FIX 均已修复：
- **MUST FIX #1**：EventAdapter 新增了完整的 `setNavigateResolver` + `navigateResolve` 拦截机制，含时序安全说明和超时保护
- **MUST FIX #2**：navigate 后使用 `session.history` 替代 `session.switch`，语义正确，流程完整

未发现回归或新增 MUST FIX。Issue #5（超时场景验证）为 INFO，在 e2e-test-plan.md，不阻塞。

### Summary

计划评审完成，第2轮通过，0条MUST FIX。EventAdapter navigate-result 拦截机制已补充完整（setNavigateResolver + translate 拦截 + 时序安全），navigate 后消息刷新已修正为 session.history，回归检查无新增风险。
