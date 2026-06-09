---
phase: dev
verdict: pass
absorbed: false
topic: agent-run-block-refactor
---

# Dev Phase Retrospect

## 1. Phase Execution Review

**Summary**: 实现了 AgentRunBlock 三层结构的 8 个 Task（T1-T8），包括 settings store 扩展、message-layout 分组重写、3 个新组件、AssistantContent/ChatPanel 集成、Settings UI。经过 5 步专项审查修复了 8 个 must-fix（BLR 3→0, taste 6→0, robustness 2→0, standards 0, integration 0），提取了 useLiveTimer composable 消除 timer 重复，用 EnrichedSection 预解析消除了模板中的双次 resolver 调用。最终 gate check 因 YAML frontmatter 格式问题额外修复了 5 个 review 文件。

**Problems encountered**:
- AgentRunBlock 的 elapsedMs 计算有 bug（startTimes/endTimes 混用同一数组），BLR 发现
- 多个 text contentBlock 可能重复渲染（实际不会发生，但缺防护），BLR 发现
- timer 生命周期管理有泄漏风险（onMounted 启动但不 watch isStreaming 变化），robustness 发现
- spread 操作符在大数组下会栈溢出，robustness 发现
- gate check 阶段发现 5 个 review 文件缺少 YAML frontmatter 或格式错误（markdown 反引号/加粗干扰 YAML 解析），手动逐个修复

**What would you do differently**:
- elapsedMs 的 start/end 分离应该在首次编写时就做对，而不是等审查发现
- useLiveTimer composable 应该在写第一个 timer 时就抽象出来，而不是写完 3 个再重构
- StandaloneToolCard 的 isCustomTool prop 是过度设计——自定义工具和内置工具的卡片渲染完全相同，不该加区分
- review 文件的 YAML frontmatter 应该在 dispatch subagent 时作为硬性模板要求写入 task prompt

**Key risks**:
- compactStreaming=false 路径完全不受影响（integration review 确认），但需要在 dev 模式下手动验证
- Settings standaloneTools 变更会立即重排已渲染消息的 sections（通过 computed 链），大量 toolCalls 时可能有性能问题

## 2. Harness Usability Review

**Flow friction**: 5 步审查分两批（4 并行 + 1 串行），执行顺畅。每个审查 subagent 大约 60-90s 完成。修复后重跑审查需要手动 dispatch 新版本。gate check 阶段的 YAML 解析问题浪费了额外一轮修复。

**Gate quality**: 审查质量整体不错。BLR 准确发现了 elapsedMs 计算错误。taste review 标准偏高但合理。gate 的 YAML 解析器过于脆弱——遇到 markdown 内容中的反引号/加粗直接报错而不是跳过 YAML 块。

**Prompt clarity**: coding-workflow skill 的步骤指引清晰，5 步审查的分批策略明确。

**Automation gaps**: 审查修复后需要手动 dispatch 新版本 review subagent（v2/v3），不能自动重跑。subagent 产出的 review 文件经常缺少正确的 YAML frontmatter，但 gate 不提供"缺少 frontmatter"的具体提示，只报 YAML parse error。

**Time sinks**: taste review 经历了 3 轮（v1→v2→v3），主要是因为 must_fix 标准偏高（DRY 问题标为 must_fix）。gate check 阶段的 YAML frontmatter 修复是额外时间消耗（5 个文件）。
