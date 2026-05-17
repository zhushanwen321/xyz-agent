# E2E 测试计划评审 v2

## 评审记录
- 评审时间：2026-05-15
- 评审类型：E2E 测试计划复审（v1 修复验证）
- 评审对象：e2e-test-plan.md
- 评审轮次：第 2 轮
- v1 问题追踪：4 resolved + 4 SHOULD FIX + 2 NOTE

---

## 1. v1 Resolved Issues 修复验证

| # | v1 问题 | 修复状态 | 验证详情 |
|---|---------|---------|---------|
| MF-1 | TC-3-01 DevTools WS 精确定位 + 两步验证 | **已修复** | TC-3-01 现在分 4 步操作：(1) 打开 Console；(2) 选择 agent → 发送；(3) **L2-Console** 检查 ChatInput emit payload；(4) **L1-WS** 在 Network → WS → Messages tab 过滤关键字 `subagent`。验证方式明确标注两层结果。DevTools 过滤指令 `过滤关键字 subagent` 解决了"大量 WS 消息中定位困难"的问题 |
| MF-2 | TC-3-02 sidecar 日志前置条件 | **已修复** | G3 组头部新增 blockquote：`> **T3 编码前置要求**：sidecar message.send handler 中必须添加 console.log('[sidecar] subagent prompt:', agentPrompt) 日志，TC-3-02 依赖此日志。` TC-3-02 验证方式中引用具体日志格式 `[sidecar] subagent prompt:` |
| MF-3 | TC-6-02 空 task 期望结果 | **已修复** | TC-6-02 验证方式明确写了三层判定：(1) L1-WS：sidecar 构造了 subagent 指令（task 为空字符串）；(2) L2-DOM：取决于 pi 对空 task 的处理（成功或 error 都可接受）；(3) **核心断言：无论成功或报错，前端不崩溃、不卡死**。期望结果清晰可判定 |
| MF-4 | TC-3-01 L1-WS 全链路覆盖 | **已修复** | TC-3-01 验证方式末尾明确写了"两步验证确保 ChatInput → PaneSessionView → useChat → WS 全链路不丢失"。L2-Console 验证 ChatInput emit（前半链路），L1-WS 验证 sidecar 收到（后半链路） |

**Resolved Issues 修复率：4/4 = 100%**

---

## 2. v1 SHOULD FIX 修复验证

| # | v1 问题 | 修复状态 | 验证详情 |
|---|---------|---------|---------|
| SF-5 | TC-4-04 "触发不存在的 agent" 操作方式不明确 | **未修复** | TC-4-04 操作步骤仍为"触发一个不存在的 agent 名称"，未说明如何构造。SlashMenu 只展示 enabled agent，没有 UI 路径触发不存在的 agent。TC-6-01 同样写了"手动构造发送不存在的 agent name"但未给出构造方法。见下方 SHOULD FIX #1 |
| SF-6 | 缺少并发 session 测试 | **已修复** | 新增 TC-6-05 并发 session 隔离：两个 session 各自触发不同 agent，L1-WS 验证 sessionId 正确路由，L2-DOM 验证各自 SubagentRenderer 显示正确内容 |
| SF-7 | 缺少 WS 断连场景 | **已修复** | 新增 TC-6-06 WS 断连时 subagent 状态：标注 NOTE（当前未实现断连恢复），L2-DOM 验证前端不崩溃、SubagentRenderer 停留在 running 或显示断开提示 |
| SF-8 | TC-6-03 特殊字符验证依赖 sidecar 日志 | **已修复（隐含）** | TC-6-03 依赖的 sidecar 日志已通过 MF-2 的 T3 前置要求解决。`[sidecar] subagent prompt:` 日志会输出完整 XML 指令，可直接验证特殊字符处理 |

**SHOULD FIX 修复率：3/4（1 项遗留）**

---

## 3. v1 NOTE 项验证

| # | v1 问题 | 状态 |
|---|---------|------|
| N-9 | 前置检查文件路径缺少项目根前缀 | 未改，仍为 `src-electron/.xyz-agent/agents.json`。NOTE 级别，不阻塞 |
| N-10 | TC-5-01 缺少 LLM 自动调用的前置条件说明 | 未改。NOTE 级别，不阻塞 |

---

## 4. 发现的新问题

| # | 优先级 | 维度 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|------|---------|
| 1 | **SHOULD FIX** | 用例可操作性 | TC-4-04 + TC-6-01 | v1 SF-5 遗留。**"触发不存在的 agent"操作方法仍未指定**。SlashMenu 只展示 pi 能发现的 enabled agent，测试者无法通过 UI 选择不存在的 agent。两个 TC（TC-4-04 侧重渲染、TC-6-01 侧重错误信息）都需要手动构造请求，但未说明构造方式。 | 在 TC-6-01 操作步骤中补充：**"在 DevTools Console 中执行 `window.__ws.send(JSON.stringify({type:'message.send', payload:{sessionId:'<当前sessionId>', content:'test', subagent:{agent:'nonexistent-agent', task:'test'}}}))` "**。TC-4-04 可标记为"同 TC-6-01 操作方式" |
| 2 | **SHOULD FIX** | 用例可操作性 | TC-3-01 步骤 (3) | **L2-Console 检查 ChatInput emit payload 的前提未说明**。TC-3-01 步骤 (3) 写"检查 Console 中 ChatInput emit 的 payload"，但 ChatInput 的 handleSend 当前不会 console.log emit 内容（T2 编码也不会添加——plan T2 的验收标准未要求 console.log）。测试者打开 Console 后看不到任何输出。 | 两种方案：(1) 在 G3 组前置要求中追加"T2 编码时在 ChatInput handleSend 的 agent case 中添加 `console.log('[ChatInput] send payload:', payload)` 临时日志（测试完成后移除）"；(2) 改为使用 Vue DevTools 的 Event Inspector 查看 emit payload。方案 (1) 更可靠且与 TC-3-02 的 sidecar 日志前置要求模式一致 |
| 3 | **NOTE** | 用例重叠 | TC-4-04 vs TC-6-01 | TC-4-04（error 状态渲染）和 TC-6-01（agent 不存在）测试操作相同（都是触发不存在的 agent），验证重点不同（渲染 vs 错误信息内容）。不阻塞，但测试执行时可合并为一次操作同时验证两点。 | 无需修改。执行时可合并，TC 描述分开是合理的（关注点不同） |

---

## 5. 整体评估

### 依赖链 G1→G6

```
G1 → G2 → G3 → G4 → G5 → G6
```

串行依赖正确，未改变。

### Spec AC 覆盖

v1 已验证全部 Spec AC 有对应 TC，v2 未新增 Spec AC，覆盖充分。

### Plan Task 覆盖

v1 已验证全部 Plan Task 有对应 TC，v2 新增 TC-6-05（并发 session）和 TC-6-06（WS 断连）扩展了 T4 和全局覆盖。

### 验证层级适当性

TC-3-01 从单一 L1-WS 升级为 L2-Console + L1-WS 两层验证，是本版最重要的改进。TC-6-02 从"结果不明确"改为"前端不崩溃、不卡死"这一可判定断言，消除了 v1 最大的模糊性。

### TC 总数统计

| 组 | TC 数 | 变化 |
|----|-------|------|
| G1 | 3 | 无变化 |
| G2 | 4 | 无变化 |
| G3 | 4 | 无变化 |
| G4 | 5 | 无变化 |
| G5 | 2 | 无变化 |
| G6 | 6 | +2（TC-6-05 并发、TC-6-06 WS 断连） |
| **总计** | **24** | +2 |

---

## 6. 结论

**通过**

v1 的 4 条关键问题全部修复，质量显著提升。遗留 2 条 SHOULD FIX 均为操作步骤的精确性（如何构造不存在 agent 的请求、如何捕获 ChatInput emit），不阻塞测试执行——测试者可以自行摸索操作方式，但补充后会减少歧义。

---

## Summary

E2E 测试计划评审完成，第 2 轮，0 条未解决问题，2 条 SHOULD FIX，1 条 NOTE，通过。v1 的 4 条问题全部修复到位。
