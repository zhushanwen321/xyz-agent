---
phase: dev
verdict: pass
absorbed: false
topic: "2026-06-08-agent-run-block-refactor"
harness_issues:
  - "5 步审查的 BLR 应该最先执行（它的 MF 会影响其他审查的判断），但实际是并行 dispatch。建议 BLR 独立先行，其他 4 步等 BLR pass 后再并行"
  - "taste review 的 must_fix 标准偏高——将 DRY 问题（如 3 处 resolver 函数重复、10 行模板重复）标为 must_fix，但提取组件的接口成本可能超过重复成本。建议 taste review 区分'功能正确性 must_fix'和'代码质量 should-fix'"
---

# Dev Phase Retrospect

## 1. Phase Execution Review

**Summary**: 实现了 AgentRunBlock 三层结构的 8 个 Task（T1-T8），包括 settings store 扩展、message-layout 分组重写、3 个新组件、AssistantContent/ChatPanel 集成、Settings UI。经过 5 步专项审查修复了 8 个 must-fix（BLR 3→0, taste 6→0, robustness 2→0, standards 0, integration 0），提取了 useLiveTimer composable 消除 timer 重复，用 EnrichedSection 预解析消除了模板中的双次 resolver 调用。

**Problems encountered**:
- AgentRunBlock 的 elapsedMs 计算有 bug（startTimes/endTimes 混用同一数组），BLR 发现
- 多个 text contentBlock 可能重复渲染（实际不会发生，但缺防护），BLR 发现
- timer 生命周期管理有泄漏风险（onMounted 启动但不 watch isStreaming 变化），robustness 发现
- spread 操作符在大数组下会栈溢出，robustness 发现

**What would you do differently**:
- elapsedMs 的 start/end 分离应该在首次编写时就做对，而不是等审查发现
- useLiveTimer composable 应该在写第一个 timer 时就抽象出来，而不是写完 3 个再重构
- StandaloneToolCard 的 isCustomTool prop 是过度设计——自定义工具和内置工具的卡片渲染完全相同，不该加区分

**Key risks**:
- compactStreaming=false 路径完全不受影响（integration review 确认），但需要在 dev 模式下手动验证
- Settings standaloneTools 变更会立即重排已渲染消息的 sections（通过 computed 链），大量 toolCalls 时可能有性能问题

## 2. Harness Usability Review

**Flow friction**: 5 步审查分两批（4 并行 + 1 串行），执行顺畅。每个审查 subagent 大约 60-90s 完成。修复后重跑审查需要手动 dispatch 新版本。

**Gate quality**: 审查质量整体不错。BLR 准确发现了 elapsedMs 计算错误。taste review 标准偏高但合理。

**Prompt clarity**: coding-workflow skill 的步骤指引清晰，5 步审查的分批策略明确。

**Automation gaps**: 审查修复后需要手动 dispatch 新版本 review subagent（v2/v3），不能自动重跑。如果 gate 能自动检测到文件变更并重跑对应的 review，效率会更高。

**Time sinks**: taste review 经历了 3 轮（v1→v2→v3），主要是因为 must_fix 标准偏高（DRY 问题标为 must_fix）。如果第一轮就区分功能正确性和代码质量，可以减少到 2 轮。
