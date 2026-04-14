# Agent 提示词原则

基于 Claude Code 官方 Agent 提示词（Explore、Plan、General Purpose、Guide）与 xyz-agent 现有提示词的对比分析。

## 原则总览

| # | 原则 | 核心思想 |
|---|------|---------|
| 1 | 角色锚定 | 第一段定义"你是什么"和"你擅长什么" |
| 2 | 显式禁止清单 | 列举具体禁止动作，不用抽象词汇 |
| 3 | 结构化流程 | 复杂任务给出编号步骤序列 |
| 4 | 输出格式契约 | 规定输出结构，使结果可预测 |
| 5 | 效率指令 | 对性能敏感的 agent 直接说"快" |
| 6 | 反模式警告 | 指出常见错误，教模型"不要怎么做" |

Tool 相关原则见 [tool-description-guide.md](tool-description-guide.md)。

---

## 1. 角色锚定 — 明确身份和专长

Agent 第一段必须定义身份和能力边界。模糊的角色让模型在边界情况犹豫不定。

```
反例（xyz-agent Explore）：
"你负责探索代码库，收集信息并汇报发现。"

正例（Claude Code Explore）：
"You are a file search specialist for Claude Code, Anthropic's official CLI
for Claude. You excel at thoroughly navigating and exploring codebases."
```

**为什么重要**：精确的角色 + 专长列表让模型知道哪些请求属于自己。Claude Code 还会列出 "Your strengths:" 帮助模型理解自身能力边界。

**怎么写**：`"You are a {角色} for {项目}, {一句话能力总结}."` 后跟 3-5 条 strengths。

---

## 2. 显式禁止清单 — 列举具体禁止动作

"只读" 对模型来说语义模糊 —— 是否包括创建临时文件？使用重定向操作符？

```
反例（xyz-agent）：
"只读操作，不修改任何文件"

正例（Claude Code）：
"=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state"
```

**为什么重要**：模型的"只读"理解可能不包括临时文件和重定向。显式列举消除歧义，也阻止模型绕过约束的"创意"尝试。

**怎么写**：用醒目标题 + 编号清单。每条禁止项都用具体命令名举例。

---

## 3. 结构化流程 — 给出步骤序列

泛泛的"先阅读再规划"无法指导复杂任务。需要编号步骤。

```
反例（xyz-agent Plan）：
"只读操作，先充分阅读相关代码
识别需要修改的文件和函数
给出分步骤的实施计划"

正例（Claude Code Plan）：
"## Your Process
1. Understand Requirements: Focus on requirements and apply your perspective.
2. Explore Thoroughly: Read files, find patterns, trace code paths.
3. Design Solution: Create approach, consider trade-offs, follow existing patterns.
4. Detail the Plan: Step-by-step strategy, dependencies, potential challenges."
```

**为什么重要**：编号步骤让模型按序执行而非跳步。每步有具体指引，减少遗漏。

**怎么写**：`## {Agent} 流程` + 编号步骤 + 每步 1-2 句具体指引。

---

## 4. 输出格式契约 — 规定输出结构

要求 agent 以特定格式结束输出，使结果可被调用方程序化解析。

```
反例（xyz-agent Plan）：
"给出分步骤的实施计划，每步说明修改什么、为什么"

正例（Claude Code Plan）：
"End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts"
```

**为什么重要**：调用方（父 agent 或前端）可以提取关键文件列表做后续处理。没有格式契约，每次输出的结构都不同。

**怎么写**：在 prompt 末尾用 `## 输出格式` 或 `End your response with:` 规定结构。

---

## 5. 效率指令 — 明确速度约束

对性能敏感的 agent（如 Explore），需要直接告诉模型"快"是目标。

```
反例（xyz-agent）：
无效率相关指引

正例（Claude Code Explore）：
"NOTE: You are meant to be a fast agent that returns output as quickly
as possible. In order to achieve this you must:
- Make efficient use of the tools
- Wherever possible, spawn multiple parallel tool calls for grepping and reading"
```

**为什么重要**：没有效率指令，模型倾向于串行执行搜索。明确要求并行可显著减少 token 消耗和延迟。

**怎么写**：`NOTE: 快速返回是核心目标。为此：` + 具体效率建议。

---

## 6. 反模式警告 — 指出常见错误

教模型"不要怎么做"比只教"怎么做"更有效。

```
反例（xyz-agent）：
无反模式警告

正例（Claude Code Agent tool）：
"Terse command-style prompts produce shallow, generic work.
Never delegate understanding. Don't write 'based on your findings, fix the bug'
— those phrases push synthesis onto the agent instead of doing it yourself."
```

**为什么重要**：模型容易犯系统性错误（如给子 agent 写过短的提示词）。反模式警告直接阻断这些行为。

**怎么写**：观察模型在实际使用中的高频错误，写成 `不要做 X，因为 Y` 格式。

---

## 差距总结

| Agent | xyz-agent 行数 | Claude Code 行数 | 关键缺失 |
|-------|--------------|----------------|---------|
| Explore | 10行 | ~40行 | 显式禁止清单、效率指令、并行指引 |
| Plan | 9行 | ~50行 | 结构化流程、输出格式契约、Critical Files |
| General Purpose | 25行 | ~15行 | strengths 列表、反模式（不要过度设计） |
| System Static | 25行 | ~200行 | 安全约束、操作谨慎性、工具偏好层次 |

| Tool | xyz-agent 行数 | Claude Code 行数 | 关键缺失 |
|------|--------------|----------------|---------|
| Bash | 6行 | ~100行 | 工具偏好层次、并行/串行指引、git安全 |
| Read | 6行 | ~20行 | 绝对路径要求、默认行数说明 |
| dispatch_agent | 30行 | ~200行 | 提示词写作指引、"When NOT to use" |
