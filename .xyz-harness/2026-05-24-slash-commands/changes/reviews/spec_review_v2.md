---
review:
  type: spec_review
  round: 2
  timestamp: "2026-05-24T23:00:00"
  target: ".xyz-harness/2026-05-24-slash-commands/spec.md"
  verdict: pass
  summary: "计划评审完成，第2轮通过，0条MUST FIX"

statistics:
  total_issues: 6
  must_fix: 0
  must_fix_resolved: 4
  low: 1
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR1/FR2/FR3/FR4"
    title: "缺少 WS 消息协议规格表"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: MUST_FIX
    location: "spec.md:FR3"
    title: "Extension sendMessage 结果拦截机制未定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: MUST_FIX
    location: "spec.md:FR6/FR3"
    title: "Extension 加载失败无检测和回退机制"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 4
    severity: MUST_FIX
    location: "spec.md:FR3"
    title: "sendMessage 异步结果缺少超时处理"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 5
    severity: LOW
    location: "spec.md:通用"
    title: "未覆盖 VITE_MOCK 模式的 mock 数据"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "spec.md:Complexity Assessment"
    title: "风险点已识别但未转化为 AC 或需求约束"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
---

# 计划评审 v2（增量审查）

## 评审记录

- 评审时间：2026-05-24 23:00
- 评审类型：计划评审（增量审查 — 验证 4 条 MUST FIX 修复）
- 评审对象：`.xyz-harness/2026-05-24-slash-commands/spec.md`
- 模式：增量审查 — 仅验证 MUST FIX 修复 + 检查回归

---

## 1. MUST FIX 修复验证

### [FIXED] MUST FIX #1: WS 消息协议规格表

**验证结论：✅ 已修复**

spec 新增了 **"WS 消息协议"** 独立章节，包含：

| 检查项 | 状态 |
|--------|------|
| 消息方向（sidecar→前端 / 前端→sidecar） | ✅ 清晰标注 |
| 消息类型（`session.tree-data` / `session.tree-navigate` / `session.tree-navigate-result` / `session.tree-fork` / `session.tree-fork-result`） | ✅ 5 种消息全部覆盖 |
| Payload schema（字段名、类型） | ✅ 每个消息都明确列出了 payload 字段和类型 |
| 可选/必选标记（`?:`） | ✅ `newLeafId?`、`editorText?`、`error?`、`newSessionId?` 正确标注 |
| TreeNode 类型定义 | ✅ 完整定义了 `id`、`parentId`、`type`（含所有合法值）、`role`、`text`、`label?`、`timestamp`、`children` |

**修复质量评估**：没有遗漏的消息类型，payload schema 与 FR 调用链完全对应。TreeNode.type 的合法值列表（`'message' | 'branch_summary' | 'label' | ...`）完整准确。

---

### [FIXED] MUST FIX #2: Extension sendMessage 结果拦截机制

**验证结论：✅ 已修复**

FR3 的调用链步骤 6-8 明确定义了拦截机制：

- **步骤 6**：RPC 事件流发出 `message_start/content_block_delta/message_end` → sidecar 的 EventAdapter 拦截
- **步骤 7**：**结果拦截** — sidecar 在 EventAdapter 中检测 message 内容是否以 `{"__xyz_type":"navigate-result"` 开头。如果是，路由到 tree 处理逻辑而非 chat store，**不插入聊天记录**
- **步骤 8**：sidecar 解析结果后通过 WS `session.tree-navigate-result` 通知前端

同时也引用了 **CLAUDE.md 规则 #5**（pi 适配层不信任外部格式）—— `sendCommand` 必须检查 `success` 字段。

**修复质量评估**：拦截位置（EventAdapter）、拦截条件（`__xyz_type` 前缀匹配）、拦截后处理（不插入 chat store）三个要素都明确。但有一个需要实施阶段注意的潜在细节：navigate 使用 `summarize: false`，pi 的 `sendMessage()` 在此模式下会输出 `input_json` content block 而非 `text` block——这意味着 content 是以结构化 JSON 对象而非文本形式到达的。spec 的拦截条件是文本前缀匹配，如果 verify 脚本发现实际格式是结构化对象而非文本，则需要调整拦截逻辑。这一点已被 spec 的"先验证再编码"要求覆盖（FR3 末尾已加入独立验证脚本）。

---

### [FIXED] MUST FIX #3: Extension 加载失败检测和回退

**验证结论：✅ 已修复**

FR6 末尾新增了 **"Extension 可用性检测"** 小节，详细定义了三级防御：

| 层级 | 检测点 | 行为 |
|------|--------|------|
| sidecar 启动 | `get_commands` RPC 检查命令列表包含 `xyz-navigate`（source: "extension"） | 不存在时输出 error log + 通知前端 |
| 前端收到不可用状态 | 检测 WS 消息中的不可用标记 | 不显示 Navigate 按钮 |
| 非活跃状态 | 用户尝试操作时 | 显示灰色不可点击状态或"Extension 未加载"提示 |

AC6 也增加了对应验收条件：
- sidecar 启动后通过 `get_commands` RPC 检查 `xyz-navigate` 是否在命令列表中
- `xyz-navigate` 不存在时 sidecar 输出 error log，前端不显示 Navigate 按钮
- Extension 不影响 pi 的其他功能

**修复质量评估**：检测时机（启动后）、检测手段（get_commands）、回退行为（前端隐藏按钮）三层完整。未见遗漏。

---

### [FIXED] MUST FIX #4: sendMessage 异步结果缺少超时处理

**验证结论：✅ 已修复**

FR3 的调用链后追加了 **"超时处理"** 小节：

- 超时阈值：**5s**
- 超时行为：取消 pending → 前端显示错误提示 "Navigate 超时"
- AC3 增加对应验收条件：**"navigate 超时（5s）时前端显示超时提示，UI 不卡死"**

AC3 新增条目：
> - navigate 超时（5s）时前端显示超时提示，UI 不卡死

**修复质量评估**：超时阈值明确（5s）、超时行为清晰、AC 已补充。需要实施阶段注意"取消 pending"的具体实现——pi RPC 协议目前没有"取消进行中的 prompt"的机制，sidecar 只能丢弃迟到的结果而非真正取消 pi 端的执行。建议实施阶段在 sidecar 层记录 request timestamp，超时后忽略任何晚到的 navigate 结果，同时确保不残留 listener 导致内存泄漏。

---

## 2. v1 LOW/INFO 状态变化

### Issue #5 (LOW): VITE_MOCK 模式未覆盖

**状态：仍 open**

spec 仍未提及 VITE_MOCK 模式的 mock 数据。这是已知预存问题，不影响当前需求的正确性，保持 LOW。

### Issue #6 (INFO): 风险点未转化为 AC

**状态：已解决** ✅

- 风险点 #2（sendMessage 到达时间不确定）→ 已转化为 AC3 的 navigate 超时条款
- 风险点 #3（Navigate 后前端刷新）→ FR3 末尾明确定义了刷新顺序：重新获取树数据 → 清空聊天面板 → get_messages 重新渲染 → 更新 leaf 指针

---

## 3. 新引入问题检查

### 回归检查

修复是否引入新问题？

| 区域 | 检查结果 |
|------|---------|
| WS 协议表与 FR 的一致性 | ✅ 完全一致，协议消息与 FR 调用链一一对应 |
| 超时与正常流程的冲突 | ✅ 超时仅是 sidecar 侧丢弃结果，不影响正常 navigate 流程 |
| Extension 可用性检查与正常检测 | ✅ get_commands 是只读操作，无副作用 |
| 拦截机制与正常消息流 | ✅ 拦截条件是 `__xyz_type` 特征标识，正常消息不含此标识 |

**未发现回归问题。**

### 新 MUST FIX

**未发现新的 MUST FIX 问题。**

### 新 LOW/INFO

无新增 LOW/INFO 问题。Issue #5（VITE_MOCK）是唯一的未解决 LOW，与本次修订无关。

---

## 4. 最终一致性确认

### spec 一致性

- FR1-FR6 全部有对应的 WS 消息协议条目
- AC1-AC6 全部有对应的 FR 定义
- CLAUDE.md 规则 #4（先验证再编码）已在 FR3 中体现
- CLAUDE.md 规则 #5（适配层不信任外部格式）已在 FR3/Fork 调用链中体现
- CLAUDE.md 规则 #6（Session 隔离）在所有 WS 消息中体现
- "不在范围"列表与 FR 定义没有矛盾

### 数据流故障点覆盖率

| 故障点 | v1 状态 | v2 状态 |
|--------|---------|---------|
| WS 连接断开 | ❌ 未覆盖 | ❌ 未覆盖（项目级已有 WS 重连，不属本 spec） |
| Extension 未加载 | ❌ 未覆盖 | ✅ 已覆盖（FR6 可用性检测） |
| sendMessage 不返回 | ❌ 未覆盖 | ✅ 已覆盖（5s 超时） |
| RPC 事件流拦截 | ❌ 未覆盖 | ✅ 已覆盖（FR3 拦截机制） |
| JSONL 并发写导致不完整行 | ❌ 未覆盖 | ✅ 已覆盖（FR1 try-catch） |
| Fork 失败 | ❌ 未覆盖 | ✅ 已覆盖（AC4 + 协议表 error 字段） |

---

## 结论

**通过。** 4 条 MUST FIX 均已充分修复：

1. ✅ WS 消息协议规格表已补充（5 种消息 + TreeNode 类型定义）
2. ✅ Extension `sendMessage` 结果拦截机制已定义（EventAdapter + `__xyz_type` 前缀检测）
3. ✅ Extension 加载失败检测和回退已补充（get_commands + 前端灰色状态）
4. ✅ 超时处理已加入 FR3（5s 超时 + AC3 超时验收条件）

唯一遗留的 Issue #5（VITE_MOCK）是 LOW 优先级，不影响 spec 完整性和 plan 启动。

## Summary

计划评审完成，第2轮通过，0条MUST FIX
