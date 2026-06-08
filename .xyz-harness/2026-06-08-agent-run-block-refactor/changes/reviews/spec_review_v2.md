---
review:
  type: spec_review
  round: 2
  timestamp: "2026-06-08T14:00:00"
  target: ".xyz-harness/2026-06-08-agent-run-block-refactor/spec.md"
  verdict: pass
  must_fix: 0
  summary: "spec 评审第2轮，v1 的 4 条 MUST_FIX 全部已修复，无新引入的 MUST_FIX 问题，可以通过"
statistics:
  total_issues: 4
  must_fix: 0
  low: 1
  info: 0
issues:
  - id: 1
    severity: null
    location: "spec.md:FR-1 + Constraints§6"
    title: "AgentRunBlock 与 compactStreaming/现有组件的关系矛盾"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: null
    location: "spec.md:FR-1 (footer)"
    title: "footer '步骤数'和'文件修改数'定义缺失"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: null
    location: "spec.md:FR-2 + FR-4"
    title: "edit 被归入合并工具与 spec 目标矛盾"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 4
    severity: null
    location: "spec.md:FR-5"
    title: "streaming 状态判断使用 collapsed 字段语义错误"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 5
    severity: LOW
    location: "spec.md:FR-4 section 类型命名"
    title: "section 类型列表中 'write' 命名过于具体"
    status: open
    raised_in_round: 2
    resolved_in_round: null
  - id: 6
    severity: null
    location: "spec.md:AC-5"
    title: "测试用例符号映射未显式定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 7
    severity: null
    location: "spec.md:FR-3"
    title: "全部展开/折叠交互细节缺失"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 8
    severity: null
    location: "spec.md:FR-4"
    title: "isMergeBlock 中 toolCalls 线性查找可优化为 Map"
    status: closed
    raised_in_round: 1
    resolved_in_round: 1
---

# Spec 评审 v2

## 评审记录
- 评审时间：2026-06-08 14:00
- 评审类型：spec 修复验证（第2轮）
- 评审对象：`.xyz-harness/2026-06-08-agent-run-block-refactor/spec.md`

## v1 MUST_FIX 修复验证

### #1 AgentRunBlock 与 compactStreaming 模式关系 ✅ 已修复

FR-1 开头新增 **"仅在 `compactStreaming=true` 时激活"** 明确限定。紧接列出三个渲染分支（compact+complete / compact+streaming / 非 compact），并说明 AgentRunBlock "替代现有的 CompactSummaryBar 和 CompactStreamingBubble 两个组件"。与 Constraints§6 完全一致。

### #2 Footer 字段定义 ✅ 已修复

FR-1 新增 "Footer 字段定义" 子节，三个字段均有可量化定义：
- 步骤数 = MergeBlock 数量 + 独立 ContentBlock 数量（不含 text block）
- 总耗时 = 当前时间（streaming）或 message.timestamp 到 complete 的间隔
- 文件修改数 = toolCalls 中 toolName 在 standaloneTools 集合内的总数

AC-1 中 footer 的验收标准现在可量化验证。

### #3 edit 分类矛盾 ✅ 已修复

采用方案 (a)+ 增强：移除硬编码的 BUILTIN_MERGE_TOOLS，改为 `standaloneTools` 用户可配置设置。默认值 `['write', 'edit']`，edit 默认独立展示。FR-2.1 新增 Settings 页面配置 UI。Footer 文件修改数与 standaloneTools 联动。FR-4 的 `isMergeBlock` 重写为接受 `standaloneTools` 参数的动态判断。核心目标"只关心修改了哪些文件"可完整实现。

### #4 streaming 判断语义 ✅ 已修复

FR-5 改为：`endTime === undefined` 表示仍在 thinking，附注"endTime 是业务时间戳，语义明确"。不再引用 collapsed 字段。

## v1 LOW/INFO 问题验证

### #5 (v1 LOW) 符号映射 ✅ 已修复

AC-5 开头新增符号表：`T=thinking, tc=toolCall(合并类), S=standalone tool, O=text`，并声明默认 standaloneTools=['write','edit']。

### #6 (v1 LOW) 全部展开/折叠 ✅ 已修复

FR-3 补充："点击 chip 条左侧的'过程'标签（延续现有 CompactSummaryBar 的 toggle-all 交互）"。

### #7 (v1 INFO) toolCalls 线性查找 — 维持原判

Spec 层面伪代码，实现时优化。

## 新发现问题

### #5 (本轮 LOW) section 类型 'write' 命名过于具体

**位置**: FR-4 第 89-92 行

**描述**: 分组结果的 section 类型列表为 `merge | text | write | customTool`。但 standaloneTools 现在是用户可配置的，edit（及其他被选中的工具）也可能独立渲染为 section。`write` 这个类型名暗示只覆盖 write 工具，不够通用。

**建议**: 实现阶段将 `write` 类型改为 `standalone`（泛指所有在 standaloneTools 中的工具），spec 层面不影响正确性，plan 阶段可自行处理。

## spec 完整性逐项检查

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 目标明确 | ✅ | "折叠 Agent 操作过程"目标清晰，standaloneTools 可配置设计使目标可达成 |
| 范围合理 | ✅ | 约束 7 条均明确，不改共享类型/WS 协议/useChat，影响面可控 |
| 验收标准可量化 | ✅ | 8 条 AC 均有明确判断标准，AC-5 含 4 组分组测试用例 |
| 与现有代码一致性 | ✅ | compactStreaming 双路径衔接清晰，endTime 语义正确 |
| [待决议] 项 | ✅ | 无未决设计问题 |

## 结论

v1 的 4 条 MUST_FIX 全部修复到位。新引入 1 条 LOW 级别的命名建议（section 类型 `write` → `standalone`），不影响正确性，可在实现阶段处理。**spec 可以通过，进入 plan 阶段。**
