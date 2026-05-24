---
phase: plan
verdict: pass
---

# Phase 2 (Plan) Retrospect

## 1. Phase Execution Review

### Summary

基于 spec.md 产出了完整的实现计划：6 个 Task、2 个 Execution Group（BG1 后端 4 tasks、FG1 前端 2 tasks）、4 个 Wave。复杂度评估为 L1（单文件 plan，不拆子文档）。同时产出了 e2e-test-plan.md（6 个场景）和 test_cases_template.json（13 条用例）。

关键决策：
1. **L1 而非 L2** — 虽然涉及前后端，但数据流简单（sidecar 读 JSONL → WS 推送前端），无跨域协调、无新存储引擎、无特殊非功能需求。6 个维度全部 L1。
2. **EventAdapter resolver 注入模式** — navigate-result 拦截通过 `setNavigateResolver(resolve)` 将 SessionService 的 Promise resolve 函数注入 EventAdapter，避免了 EventAdapter 职责膨胀。
3. **session.history 而非 session.switch** — navigate 后在同一 session 内刷新消息，用 `session.history`（对应 pi get_messages）而非 `session.switch`（用于跨 session 切换）。

### Problems Encountered

1. **plan.md 缺少 YAML frontmatter** — Gate check 因此失败一次。写 plan 时注意力在内容上，忽略了模板要求的 `--- verdict: pass ---` 头部。低级错误，修复耗时 1 轮。

2. **EventAdapter 回调机制设计 gap** — 第一轮 plan review 发现 MUST FIX：plan 描述了"拦截 navigate-result"但没有说明 EventAdapter 如何把结果传回 SessionService。原始描述"通过回调注册"过于模糊。修复时补充了完整的 `setNavigateResolver(resolve)` 注入机制 + 时序安全分析。

3. **navigate 后误用 session.switch** — Task 6 Step 3 原始写法用 `session.switch` 重新加载消息，但 navigate 不创建新 session，switch 语义是切换不同 session。review 准确捕获了这个问题。

4. **文件数标注错误** — BG1 标注 "14 个文件（8 create + 6 modify）"，实际是 10 个（3 create + 7 modify）。review 标为 LOW，已修复。

### What Would You Do Differently

1. **先写 YAML frontmatter 再写内容** — 两次 phase 都因为 frontmatter 问题多了一轮交互。应该养成先写模板框架再填内容的习惯。

2. **EventAdapter 集成方案应在 spec 阶段更明确** — spec 的 FR3 Step 7 描述了"结果拦截"但没有定义具体的回调注册机制。如果在 spec 阶段就明确 resolver 注入模式，plan review 就不会有 MUST FIX。

3. **并行扫描效率可以更高** — 用了 2 个 subagent 分别扫描 sidecar 和前端层，但其实可以用 1 个 subagent 完成所有扫描。扫描结果用于写 plan 时已经在我上下文中，不需要分两批。

### Key Risks for Later Phases

1. **EventAdapter 获取方式未在 plan 中明确** — SessionService 如何拿到 EventAdapter 实例来调用 `setNavigateResolver()`？这取决于 session-pool 的 DI 实现。dev 阶段需要先确认 session-pool 如何组装 SessionService + EventAdapter。

2. **verify-navigate-rpc.cjs 需要真实 pi 进程** — 验证脚本需要连接运行中的 pi 进程。如果 pi 进程配置有问题（provider 缺失等），验证脚本会先失败，阻塞后续 Task。

3. **TreeNode flatNodes 算法的性能** — 大 session（100+ entries）时扁平化渲染可能有性能问题。plan 中提到"虚拟滚动列表"但没有具体化，dev 阶段需要决定是否引入虚拟滚动。

## 2. Harness Usability Review

### Flow Friction

- **两次 subagent 扫描 + 主 agent 读文件** — 获取代码上下文用了 3 次工具调用（2 个 subagent + 直接 read protocol.ts）。信息有重叠（两个 subagent 都提到了 WS 路由模式）。可以合并为一次扫描。

- **plan review 高效** — 两轮 review 各发现有价值的问题。第一轮 2 MUST FIX + 2 LOW + 1 INFO，修复后第二轮直接通过。

### Gate Quality

- **Gate 失败原因准确** — YAML frontmatter 缺失是真实问题，不是误报。
- **Review 质量持续高** — 与 Phase 1 的 spec review 一样，plan review 也准确定位了架构级 gap（EventAdapter 回调机制）和语义错误（session.switch）。

### Prompt Clarity

- **L1/L2 判断标准清晰** — 5 个维度评估表让判断有据可依。本次 6 维度全部 L1，结论明确。
- **Execution Groups 模板详细** — subagent 配置表、执行流、文件列表的结构化模板让 plan 写作有章可循。
- **Spec Metrics Traceability 章节** — 强制追踪 spec→plan 的指标传递，避免 AC 被静默忽略。这个机制在本次 plan 中有效运作。

### Automation Gaps

- **Gate check 脚本仍然不可用** — 与 Phase 1 相同，`check_gate.py` 不存在。手动验证 gate 条件。
- **YAML frontmatter 验证可以自动化** — 缺少 frontmatter 导致 gate 失败，这可以在写文件时自动检查（pre-write hook）。

### Time Sinks

1. **代码上下文扫描**（2 个 subagent + 直接读文件）— 占本轮上下文的约 40%。如果项目有预构建的代码知识库，可以大幅减少。
2. **plan.md 写作本身**（约 19KB）— 单文件 L1 plan 已经很长。如果项目更复杂需要 L2 拆分，写作时间会翻倍。
