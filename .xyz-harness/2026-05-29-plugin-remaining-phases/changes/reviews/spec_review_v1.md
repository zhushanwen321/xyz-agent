---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-29T18:00:00"
  target: ".xyz-harness/2026-05-29-plugin-remaining-phases/spec.md"
  verdict: fail
  summary: "Spec 评审完成，第1轮，4条 MUST FIX，需修改后重审"

statistics:
  total_issues: 8
  must_fix: 4
  low: 4
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md → AC-1"
    title: "AC-1 'listSessions() 返回非空数组' 无条件成立不可测试"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "spec.md → FR-4 描述 + Constraint #4"
    title: "FR-4 UI 弹窗组件策略自相矛盾：'复用' vs '复用或新建'"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "spec.md → FR-3 + AC-3"
    title: "getModel/setModel 数据源优先级未定义，AC-3 语义断裂"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "spec.md → FR-7"
    title: "'最多重试 3 次' 作用域未定义（per-Worker/per-process/per-plugin）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "spec.md → FR-2"
    title: "SessionData 持久化未指定文件损坏恢复行为"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "spec.md → AC-1"
    title: "'RPC 往返延迟 < 50ms' 是性能目标，不适合作为功能 AC"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "spec.md → Constraint #9"
    title: "'不修改已通过的测试' 边界模糊，hook 改动可能波及已有测试 setup"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: LOW
    location: "spec.md → 优先级分档"
    title: "未说明部分交付条件——仅完成第一档是否可接受"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-05-29 18:00
- 评审类型：计划评审（spec 完整性）
- 评审对象：`.xyz-harness/2026-05-29-plugin-remaining-phases/spec.md`

## 六元素完整性检查

| 元素 | 存在 | 质量评价 |
|------|------|---------|
| Background | ✅ | 清晰描述了现状（stub 问题）和目标（端到端可用），一段话能说清楚 |
| Functional Requirements | ✅ | 10 项 FR，分三档优先级，每项有现状/要求/依赖/涉及文件 |
| Acceptance Criteria | ✅ | 10 项 AC 与 FR 一一对应（见下方矩阵） |
| Constraints | ✅ | 9 项约束，多数可执行 |
| 业务用例 | ✅ | 5 个 UC，覆盖核心场景 |
| Complexity Assessment | ✅ | 每项 FR 有复杂度/改动量/风险点，表格清晰 |

**结论：六个必要元素齐全。**

## FR ↔ AC 对应矩阵

| FR | AC | 对应 | 一致性评价 |
|----|----|----|-----------|
| FR-1 Session API | AC-1 | ✅ | 有语义问题（见 Issue #1） |
| FR-2 SessionData 持久化 | AC-2 | ✅ | 一致，4 项标准均可测试 |
| FR-3 Agent API | AC-3 | ✅ | 有语义断裂（见 Issue #3） |
| FR-4 UI 弹窗 | AC-4 | ✅ | 设计决策未定（见 Issue #2） |
| FR-5 Permission 推送 | AC-5 | ✅ | 一致，清晰可测 |
| FR-6 findFiles | AC-6 | ✅ | 一致，简洁 |
| FR-7 Crash 重建 | AC-7 | ✅ | 作用域缺失（见 Issue #4） |
| FR-8 Hook 桥接 | AC-8 | ✅ | 一致，4 项拦截能力都有对应 AC |
| FR-9 SDK 类型包 | AC-9 | ✅ | 一致 |
| FR-10 样例插件 | AC-10 | ✅ | 一致，5 项验证点覆盖完整生命周期 |

## [AMBIGUOUS] 标记检查

Spec 中无 `[AMBIGUOUS]` 或 `[待决议]` 标记。但审查发现 4 处实质性歧义（见 MUST FIX 列表），这些歧义未显式标记，更危险——执行者可能按不同理解实现。

## CLAUDE.md 架构合规检查

| 检查项 | 结果 | 说明 |
|--------|------|------|
| Session 隔离 #7（消息必须带 sessionId） | ✅ | FR-4 WS 协议包含 sessionId；FR-5 permission 是全局事件，不涉及特定 session，合理豁免 |
| WS 命名约定 #11（Client→Server 点号，Server→Client 冒号） | ✅ | `plugin:uiRequest` / `plugin.uiResponse` 符合约定 |
| emit 单 payload #1 | ✅ | FR-4 WS 协议使用 payload 对象 |
| pi 适配层 #5 | ⚠️ | FR-8 修改 session-service.ts 和 event-adapter.ts 插入 hook 调用。event-adapter 是适配层本身，修改合理；session-service 是业务层，插入 hook 调用是新增行为而非修改适配逻辑，可接受 |
| Plugin Service 唯一适配层 #11 | ✅ | 所有前端↔插件通信均走 WS → server.ts → PluginService |
| 数据目录隔离 #10 | ✅ | FR-2 使用 `~/.xyz-agent/plugins/` 路径，与 pi 数据目录隔离 |
| Hook 串行执行 #11 | ✅ | FR-8 未修改 hook 执行模型，保持串行 |
| sessionData 缓存策略 #11 | ✅ | FR-2 保持内存缓存 + 定时 flush 模式，仅补全 flush 实现 |

**无架构冲突。** FR-8 对 session-service.ts 的修改需注意不影响 pi 适配层的现有行为（新增调用而非修改逻辑流）。

## Constraint 可执行性检查

| # | 约束 | 可执行 | 备注 |
|---|------|--------|------|
| 1 | 不修改 ISessionService 接口签名 | ✅ | 构造函数注入已有引用，不改接口 |
| 2 | 不引入新 WS 库 | ✅ | 复用现有 ws-client + event-bus |
| 3 | SessionData 独立于 pi bridge | ✅ | 本地文件方案，无 pi 依赖 |
| 4 | UI 弹窗复用 ExtensionUIDialog 模式 | ⚠️ | 与 FR-4 描述矛盾（见 Issue #2） |
| 5 | Worker 重建仅限 trusted | ✅ | 明确 |
| 6 | Hook 拦截超时 5s | ✅ | 保持已有实现 |
| 7 | fast-glob 替代手写 | ✅ | 明确 |
| 8 | SDK 类型包独立 | ✅ | 放 packages/ |
| 9 | 不修改已通过的测试 | ⚠️ | 边界模糊（见 Issue #7） |

## 发现的问题

### MUST FIX

| # | 位置 | 描述 | 修改建议 |
|---|------|------|---------|
| 1 | AC-1 | **`listSessions() 返回非空数组` 无条件成立不可测试。** 当系统中无 session 时，返回空数组是正确行为。AC 作为验收标准，应描述「满足前提条件时的预期结果」，而非断言一个不总是成立的条件。同样，AC-3 的 `getModel() 返回非空字符串` 在无活跃 session 且无默认模型配置时也应返回合理值（如 `''` 或 fallback）。 | 改为有条件的断言，例如：`listSessions()` 返回 `SessionInfo[]`，当存在已持久化的 session 时数组非空，各元素包含完整的 session 元信息。AC-3 同理：当有活跃 session 时，`getModel()` 返回该 session 的模型 ID（非空字符串）。 |
| 2 | FR-4 + Constraint #4 | **UI 弹窗组件策略自相矛盾。** Constraint #4 写「复用 ExtensionUIDialog 模式」，FR-4 正文先写「复用 ExtensionUIDialog.vue 组件」，紧接着又写「复用或新建 PluginUIDialog」。「复用」和「新建」是两个完全不同的实现路径，影响文件结构、组件 props 设计、事件流。 | 二选一并删除另一个。建议：如果 ExtensionUIDialog 的 props/事件模型可直接适配 plugin 场景（不同 WS 通道但相同 UI 交互），则复用同一组件、在 usePlugin composable 中做数据适配；如果 UI 需求有差异，则新建 PluginUIDialog 并在 Constraint 中更新为「新建 PluginUIDialog，参考 ExtensionUIDialog 模式」。 |
| 3 | FR-3 + AC-3 | **getModel/setModel 数据源优先级未定义，AC 语义可能断裂。** FR-3 写 getModel 「从当前活跃 session 的 RpcClient 获取模型信息（**或**从 config 读取默认模型）」——「或」是 fallback 还是二选一？优先级未定义。同时 setModel 写到 `sessionService.switchModel(activeSessionId, ...)`。如果 getModel 读 config 而 setModel 写 session，则 AC-3 的 `setModel(...) 后 getModel() 返回新模型` 会失败。 | 明确数据源优先级，例如：`getModel()` 优先从活跃 session 读取，无活跃 session 时 fallback 到 config 默认值。同时说明 `setModel()` 是否同时更新 config。AC-3 需据此调整前提条件。 |
| 4 | FR-7 | **「最多重试 3 次」作用域未定义。** 是 per-Worker-instance（同一个 Worker 对象重建 3 次后放弃）？是 per-sidecar-process（整个 sidecar 生命周期内最多重建 3 次）？是 per-plugin（同一个 plugin 所在 Worker 累计 3 次）？不同答案导致完全不同的实现：per-process 意味着重启 sidecar 可重置计数器；per-plugin 意味着同一 Worker 上的不同插件共享额度。 | 明确作用域。建议 per-sidecar-process per-Worker-slot（每个 Worker 槽位在 sidecar 生命周期内最多重建 3 次），与「重启 sidecar 恢复」的用户预期一致。 |

### LOW

| # | 位置 | 描述 | 修改建议 |
|---|------|------|---------|
| 5 | FR-2 | **未指定 session data 文件损坏时的恢复行为。** atomic write 防止了写入过程中的损坏，但无法防止磁盘错误、手动编辑错误等场景。启动恢复时遇到 malformed JSON 应如何处理——跳过并清空？报错？尝试恢复？ | 建议补充一条：启动恢复时遇到无法解析的文件，跳过该文件并 log warning，不阻塞其他 session 的恢复。这符合「插件数据非关键」的定位。 |
| 6 | AC-1 | **「RPC 往返延迟 < 50ms」是性能目标，不适合作为功能 AC。** 功能 AC 应描述行为的正确性。延迟依赖系统负载、进程调度等因素，在 CI 环境下不稳定，容易产生 flaky test。 | 移到 Complexity Assessment 的「非功能性要求」中，作为性能参考值而非验收标准。AC 只保留功能正确性断言。 |
| 7 | Constraint #9 | **「不修改已通过的测试」边界模糊。** FR-8 在 session-service.ts 中插入 hook 调用，可能改变 `sendMessage()` 的行为（消息被拦截/修改）。如果已有测试直接调用 `sendMessage()` 并验证结果，这些测试可能需要调整以 accommodate hook 的存在（如 mock hook executor）。 | 建议改为「不修改已有测试的断言和预期结果」，允许在 setup 中添加必要的 mock/stub（如 mock executeHooks 返回放行结果），使已有测试在 hook 插入后仍能通过。 |
| 8 | 优先级分档 | **未说明部分交付条件。** spec 分三档（必须/推荐/有限），但未明确：如果第一档完成后时间/预算不足，是否可以只交付第一档？第二档中哪些 FR 是独立的、可跳过的？ | 建议补充一句：「第一档（FR-1~5）是发布硬性要求，缺一不可。第二档中 FR-6~8 可独立交付，任一项可跳过不影响其他项。第三档为锦上添花，可推迟到下期。」 |

## 结论

需修改后重审。4 条 MUST FIX 均为 spec 描述的语义清晰度问题，不涉及架构方向变更。修复工作量预估：每条 2~5 行 spec 文本修改，合计不超过 30 分钟。

## Summary

Spec 评审完成，第1轮，4条 MUST FIX，需修改后重审。六个必要元素齐全，FR↔AC 一一对应，无 CLAUDE.md 架构冲突。核心问题集中在 AC 可测试性（Issue #1/#3）和设计决策未定（Issue #2/#4）。
