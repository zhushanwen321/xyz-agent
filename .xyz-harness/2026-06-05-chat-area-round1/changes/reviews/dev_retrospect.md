---
phase: dev
verdict: pass
absorbed: false
topic: "2026-06-05-chat-area-round1"
harness_issues:
  - "BLR v1 发现 6 个 MUST_FIX，主要原因是子代理按 task 产出了组件但未完成跨组件集成（BatchSelectBar 未挂载、Sidebar 未引入 AppSidebar、BranchIndicator 数据硬编码 []）。这是 subagent-driven-development 模式的结构性问题——子代理只能看到自己的 task context，无法感知跨 group 的集成需求。"
  - "Integration Review 发现 3 个 MUST_FIX，其中 toast:show event-bus 未消费是跨层集成遗漏，markdown 源码丢失是 DOM textContent 不可逆转换问题。子代理在实现时缺乏端到端路径验证。"
  - "Robustness v1 的 R#4 (MessageActionMenu 静默 no-op) 在 MUST_FIX 修复轮中被遗漏，直到 Robustness v2 才被捕获。修复子代理的 11 项 fix 列表不包含此项。"
---

# Phase 3 Retrospect — Chat Area 第一轮优化 (Dev)

## 1. Phase Execution Review

### Summary

Phase 3 (Dev) 将 plan.md 的 24 个 Tasks（6 个 Execution Groups）实现为可运行代码，通过 5 步专项审查（BLR → Standards → Taste → Robustness → Integration）后最终通过。

**关键数字：**
- 24 个 Tasks / 6 个 Groups 全部实现
- 610 个测试全绿（506 runtime + 104 renderer）
- 0 lint errors / 0 typecheck errors
- 5 步审查经历 3 轮修复：BLR v1→v2, Robustness v1→v2→v3, Integration v1→v2
- 总计 ~47 个 git commits（含 24 feat + 13 fix + 10 docs）

### Problems Encountered

1. **跨 Group 集成断裂（BLR v1 MUST_FIX × 6）**
   - 现象：6 个子代理各自完成 FG1-FG6 的 Tasks，但组件之间的集成（BatchSelectBar 挂载到 ChatPanel、SidebarCollapseHandle 引入 AppSidebar、BranchIndicator 数据流接通、AppSidebar fullscreen ref 接通）全部缺失
   - 根因：subagent-driven-development 模式下，每个子代理只看到自己的 task context。Group 描述中说"在 ChatPanel 中渲染 BatchSelectBar"，但 ChatPanel 属于 FG1 的子代理 B，而 BatchSelectBar 属于子代理 A。两个子代理之间没有协调机制
   - 解决：修复子代理统一完成所有集成（ChatPanel + AppSidebar + MessageBubble 改造）
   - 教训：plan.md 应将"集成 task"（如"将组件 A 挂载到父组件 B"）显式列为独立 Task，而非隐含在 Group 描述中

2. **Toast event-bus 无消费者（Integration v1 MUST_FIX #1）**
   - 现象：clipboard.ts 和 MessageActionMenu 通过 event-bus emit `toast:show`，但 App.vue 没有注册监听器。所有复制操作的成功/失败反馈对用户不可见
   - 根因：clipboard.ts 是 FG1 子代理创建的，event-bus 模式参考了项目中已有的模式，但 App.vue 的监听器注册是"全局基础设施"层，不属于任何 FG 的 scope
   - 解决：在 App.vue 的 onMounted 中注册 `toast:show` 监听器
   - 教训：event-bus 是隐式依赖，plan 应在 Interface Contracts 中标注"需要消费者注册"

3. **Markdown 源码在 DOM 中丢失（Integration v1 MUST_FIX #3）**
   - 现象：collectMessageContent 从 `body.textContent` 读取正文，但 DOM 中只有 v-html 渲染后的 HTML，markdown 格式已不可逆丢失
   - 根因：子代理实现 collectMessageContent 时，未考虑到 Vue 的 v-html 会将 markdown 转为 HTML。textContent 只能取到纯文本
   - 解决：在 MessageBubble 的 `.msg__body` 添加 `data-markdown-source` 属性，collectMessageContent 优先读取
   - 教训：涉及 DOM → 文本 的转换时，应考虑渲染管线的有损性。Plan 应标注"复制需要原始 markdown，不能从 DOM textContent 读取"

4. **Robustness R#4 遗漏**
   - 现象：v1 review 标记 5 个 MUST_FIX，修复子代理只修了其中 4 个（R#4 MessageActionMenu silent no-op 被遗漏）
   - 根因：修复子代理的 task prompt 列出了"11 个 MUST_FIX"，但 R#4 被误归类为与 BLR M#2 相关（实际独立）
   - 解决：Robustness v2 捕获后，直接修复（添加 event-bus toast + console.warn）
   - 教训：修复子代理的 task prompt 应逐条列出所有 MUST_FIX 的文件名和行号，不依赖子代理自行交叉比对

### What Would I Do Differently

- **增加"集成 Task"**：plan.md 应为每个跨组件集成（组件挂载、store 接入、event-bus 消费者注册）创建显式 Task，而非隐含在 Group 描述中
- **端到端路径验证**：每个 Group 完成后，应做 UC 路径推演（类似 BLR 的模拟数据路径），验证"用户能看到 Toast 吗？数据从哪来？事件谁消费？"
- **子代理修复 prompt 精确化**：修复 prompt 应精确到"文件名:行号:描述"三要素，不使用归类合并

### Key Risks for Later Phases

- **BatchSelectBar 0 选中时隐藏**（BLR v2 LOW #1）：spec 字面说"实时显示 N 条消息"，当前 0 条时 bar 不显示。功能正确但不完全符合 spec 措辞
- **activeCommand 路径未走 sendMode**（BLR v1 LOW #9）：skill/agent 命令在流式时无法 Steer/Queue
- **Alt 键全局监听粒度**（BLR v1 LOW #10）：Alt+Tab 切换后 isAltPressed 可能残留 true
- **Clone 路径 renameSession 静默成功**（BLR v1 INFO #11）：pi 未落盘时 rename 失败但不报错

## 2. Harness Usability Review

### Flow Friction

- **修复轮次过多**：BLR v1→v2 (1 round), Robustness v1→v2→v3 (2 rounds), Integration v1→v2 (1 round)。总计 4 个修复 round-trip，每次都需要 dispatch 子代理 + 等待 + 提交
- **子代理超时设置无效**：尝试设置 `async: true` 时发现 `timeoutMs` 只适用于前景运行。需要权衡并行性和超时控制
- **Stale 子代理通知**：2 次收到 "needs attention" 通知，但子代理实际已完成。造成不必要的 status 查询

### Gate Quality

- **Gate 对 review YAML schema 的校验精确**：能正确识别 v2 review 缺少 top-level `must_fix` 字段
- **Gate 对 `all_passing` 类型检查严格**：要求布尔值而非字符串
- **5 步专项审查比单步 code_review 有效**：BLR 发现了跨组件集成问题，Robustness 发现了错误处理缺失，Integration 发现了端到端数据流问题——这些问题单步审查很难全部覆盖

### Prompt Clarity

- **subagent-driven-development 的"禁码铁律"**：主 agent 不写实现代码的规则清晰，但"集成代码"（如 ChatPanel 中 import BatchSelectBar）是否算"实现代码"存在灰色地带。当前选择让修复子代理统一处理集成，符合规则精神
- **前端子代理不走 TDD**：xyz-harness-frontend-dev 的三阶段开发流程（骨架→功能→美化）不适合自动化验证。测试是在功能阶段完成后补充的

### Automation Gaps

- **缺少"跨组件集成自动检查"**：plan 写完后，没有自动化检查"组件 A 是否在父组件 B 中被 import"
- **缺少"端到端路径模拟"**：没有工具能模拟 UC 路径（如"用户点击复制 → Toast 出现"）验证所有环节是否贯通
- **修复子代理的 task prompt 需要精确到行号**：当前是人工从 review 文件中提取，应自动化

### Time Sinks

- **11 个 MUST_FIX 的修复和重新审查**：BLR 6 + Robustness 5 + Integration 3 = 14 个 MUST_FIX（去重后 11 个），需要 3 个修复子代理 + 3 个重新审查子代理
- **YAML frontmatter 调试**：2 次 gate FAIL（v1 review 嵌套 schema + plan review v2 top-level 字段），每次需要修复 + 重新提交
- **BranchIndicator 类型错误修复**：`defineProps<{}>()()` 双括号 → eslint-disable 对 TS6133 无效 → 多次尝试才找到正确方案

## Overall Verdict

**pass** — Phase 3 完成全部 24 个 Tasks 实现、610 个测试全绿、5 步专项审查全部通过。主要教训是 subagent-driven-development 模式下需要更精确的集成 Task 定义和端到端路径验证。
