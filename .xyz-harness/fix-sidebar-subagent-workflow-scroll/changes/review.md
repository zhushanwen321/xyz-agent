# Code Review · fix-sidebar-subagent-workflow-scroll

## 审查范围

- commit 37c8fd0f (W1): 4 个组件源码改动（3 个根 div 加 h-full + Sidebar 子视图区加 overflow-hidden）
- commit 716ad162 (W2+W3): 3 个测试文件新增结构断言用例

改动规模：4 处 class 字符串修改 + 5 个新测试用例。主 agent 自审。

## Standards 组（代码符合规范吗）

| 维度 | 结论 |
|------|------|
| type-safety | 无类型改动，纯 class 字符串。无 any 引入 |
| error-handling | 无逻辑改动 |
| edge-case | 加载/错误/空态用固定 padding div，不受 h-full 影响。列表态才走 ScrollArea 分支，h-full 只在列表态生效 |
| test-coverage | 结构断言验证修复的 class，happy-dom 兼容（不依赖 layout 引擎）。测试能发现「根 div 缺 h-full」的回归——删掉 h-full 三个组件测试立即变红 |
| plan-completeness | W1 的 4 个 change 全落地，W2/W3 测试全落地 |
| 12 smell baseline | 无命中（改动极小，无重复/过度抽象等）|

仓库标准（AGENTS.md）遵循情况：
- 前端编码规范第 4 条（行数上限）：三个组件未超限
- taste-lint（ESLint）：npm run lint 通过，无违规
- pre-commit 全部检查通过（i18n CJK / 目录规范 / ws-client 检查等）

## Spec 组（代码忠实实现 spec 吗）

对照 spec FR/AC 逐条核验：

| spec 条目 | 实现位置 | 结论 |
|-----------|---------|------|
| FR-1 三个组件列表超长可滚动 | SubagentList/WorkflowList/WorkflowDetail 根 div 加 h-full | ✅ 三个组件都加了，根因修复 |
| FR-2 Sidebar 子视图区防御性溢出隐藏 | Sidebar.vue line 82 加 overflow-hidden | ✅ 防御层到位 |
| FR-3 不破坏现有布局 | 32 个测试全通过（27 现有 + 5 新增）| ✅ 无回归 |
| AC-1 SubagentList 根 div 含 h-full | U1 断言 | ✅ |
| AC-2 WorkflowList 根 div 含 h-full | U2 断言 | ✅ |
| AC-3 WorkflowDetail 根 div 含 h-full | U3 断言 | ✅ |
| AC-4 Sidebar 子视图区含 overflow-hidden | U4 源码正则断言 | ✅ |
| AC-5 四态渲染不回归 | 现有四态用例 + E1 整体跑 | ✅ |

无 scope creep（未加 spec 没要求的功能）。无实现错误。

## 测试质量自检

- 防线有效性：删掉任一组件的 h-full，对应测试立即变红（红灯校验已验证）
- 不是覆盖率填充：测试针对具体 bug（flex 高度链断裂），非 happy path 凑数
- 盲区：happy-dom 无法测真实滚动行为，这是环境限制（spec D2 决策已记录），结构断言是最佳可测策略

## 发现的问题

无 must-fix / should-fix issue。

## 总结

- Standards 组：0 个发现
- Spec 组：0 个发现

代码就绪，进 test。
