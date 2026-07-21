# Plan Review · fix-sidebar-subagent-workflow-scroll

## 审查范围

plan 规模小（3 Wave，4 处源码改动 + 3 处测试改动），主 agent 自审三维度。

## FR 覆盖映射

| FR | 覆盖 Wave | 说明 |
|----|----------|------|
| FR-1 三个组件列表超长可滚动 | W1 | SubagentList/WorkflowList/WorkflowDetail 根 div 加 h-full |
| FR-2 Sidebar 子视图区防御性溢出隐藏 | W1 | Sidebar.vue 子视图区容器加 overflow-hidden |
| FR-3 不破坏现有布局 | （隐式）| 无独立 change——由 test 阶段跑现有测试（四态渲染用例）验证不回归 |

CW 的「FR-3 未覆盖」warning 是合理设计但本例属 false positive：FR-3 是「不回归」约束，本质由现有测试在 test 阶段守护，不需要独立的 wave change。AC-5（四态渲染不回归）同理。

## AC 验收路径映射

| AC | 验证 Wave | 验证方式 |
|----|----------|---------|
| AC-1 SubagentList 根 div 含 h-full | W2 | 结构断言 |
| AC-2 WorkflowList 根 div 含 h-full | W2 | 结构断言 |
| AC-3 WorkflowDetail 根 div 含 h-full | W3 | 结构断言 |
| AC-4 Sidebar 子视图区含 overflow-hidden | W3 | 源码/组件断言 |
| AC-5 四态渲染不回归 | test 阶段 | 现有 SubagentList/WorkflowList spec 的四态用例 + sidebar-layout 现有用例 |

## 三维度审查

### coverage（覆盖度）
- FR-1/FR-2 显式覆盖，FR-3 隐式覆盖（见上表）
- AC 1-4 有直接验证路径，AC-5 由现有测试守护
- 无遗漏

### architecture（架构合理性）
- W1（根因修复，4 文件）+ W2/W3（测试）拆分合理：修复与测试分离，测试 dependsOn 修复
- W2/W3 彼此独立（测不同组件），无循环依赖
- W3 把 WorkflowDetail 测试和 Sidebar 断言放一起，是因为 sidebar-layout.test.ts 已同时引用两者，避免新建测试文件
- changes 文件级改动清晰，无混杂

### feasibility（可行性）
- 每个 change 都给出了具体 class 字符串（`flex h-full min-h-0 flex-col`、`mt-1 min-h-0 flex-1 overflow-hidden`），可执行
- 测试用例 happy-dom 兼容（结构断言不依赖 layout 引擎）
- 无未识别外部依赖

## 发现的问题

无 must-fix / should-fix issue。

## 审查结论

plan 就绪，进 tdd_plan。FR-3 的 warning 为 false positive（不回归约束由 test 阶段守护，无需独立 change）。
