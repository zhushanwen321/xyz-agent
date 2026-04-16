# 提示词写法指南（Agent + Tool）

基于对 Claude Code 官方 agent prompt 和 tool description 的逆向分析，总结提示词编写原则。

> Agent 提示词原则见 [agent-prompt-guide.md](agent-prompt-guide.md)

## 核心原则

### 1. 动词开头，说做什么不说是什么

工具描述的第一句必须是**动作短语**，告诉模型这个工具"做什么"。

| 差 | 好 |
|----|-----|
| "An orchestration node for multi-agent coordination." | "Launch a sub-agent to execute a specific task." |
| "A command execution tool." | "Execute a shell command and return stdout/stderr." |
| "File reader utility." | "Read a file from the local filesystem." |

模型通过第一句决定"什么时候调用这个工具"。概念性描述让模型猜测，动作性描述让模型直接匹配用户意图。

### 2. 结构分层：摘要 → 用法 → 约束 → 示例

Claude Code 的工具描述普遍遵循这个结构：

```
一句话摘要（做什么）

用法要点（Usage / Usage notes）：
- 参数行为
- 默认值说明
- 与其他工具的关系

约束和注意事项：
- 什么时候不用这个工具
- 常见错误避免

示例（Example）
```

简单工具（Glob、Grep）只有摘要 + 几条用法要点，约 5 行。复杂工具（Agent、Bash）有完整的多层结构，可达 30+ 行。

### 3. 必须包含"什么时候不用"

Claude Code 的 Agent 工具有明确的 "When NOT to use" 段落。这比告诉模型"什么时候用"更重要——它防止模型对简单任务滥用复杂工具。

```
When NOT to use:
- 如果只是读一个已知路径的文件，用 Read
- 如果只是搜一个类名，用 Grep
- 如果任务不涉及子任务分解，不需要 Orchestrate
```

### 4. 用 `<example>` 标签给具体示例

Claude Code 的 Agent 工具使用 `<example>` 标签包裹完整对话片段，展示**调用前后的上下文**：

```xml
<example>
user: "列出 src 下所有文件"
assistant: Agent({
  description: "list files in src",
  prompt: "Run ls -la in the src/ directory and list all files found",
  sync: true
})
</example>
```

示例是减少空参数调用的最有效手段。模型看到示例后，首次调用成功率显著提高。

### 5. property description 要给出具体填写示例

```json
// 差
"directive": {
  "type": "string",
  "description": "Specific instructions for the agent"
}

// 好
"directive": {
  "type": "string",
  "description": "Task instructions for the sub-agent. Be specific about what to do and where, e.g. 'Search for ERROR lines in logs/*.log and summarize patterns'"
}
```

`e.g.` 后面的示例让模型知道参数的"形状"——多长、多具体、什么风格。

### 6. required 字段越少越好，每个都给 example

每多一个 required 字段，模型出错概率就增加。如果有 3 个 required 字段，至少为每个提供填写示例。

对于语义重叠的字段（如 `task_description` vs `directive`），用 description 明确区分：

```json
"task_description": {
  "description": "Short summary of what this task does (for display/logging). e.g. 'Analyze error logs'"
},
"directive": {
  "description": "Full instructions for the sub-agent. Include what to do, where, and expected output. e.g. 'Search for ERROR lines in logs/*.log, count occurrences by type, and summarize the top 3 patterns'"
}
```

### 7. 与其他工具的边界要说清楚

当项目有多个相似工具时（如 Orchestrate vs Subagent），必须在 description 中说明差异：

```
When to use Orchestrate vs Subagent:
- Use Orchestrate for tasks that need recursive decomposition (break task into sub-tasks, each sub-task can break further)
- Use Subagent for simple, independent tasks that don't need decomposition
```

## Description 长度参考

| 工具复杂度 | 行数参考 | 示例 |
|-----------|---------|------|
| 简单（单参数、无分支） | 3-5 行 | Glob、Grep |
| 中等（多参数、有约束） | 8-15 行 | Read、Write、Edit |
| 复杂（多角色、有示例） | 15-30 行 | Agent、Bash |

## 反模式清单

1. **概念命名**：用业务术语而非操作术语描述工具（"orchestration node" vs "launch a sub-agent"）
2. **无示例**：模型猜参数格式，首次调用空 `{}`
3. **重叠字段无区分**：`task_description` 和 `directive` 语义不清
4. **缺少"不用"指引**：模型对简单任务也调用复杂工具
5. **描述中不含默认值**：模型不知道哪些参数可以省略
6. **required 字段无 example**：模型不知道填写什么内容

## Schema 设计原则

1. **必需参数尽量少**：理想 1-2 个，最多 3 个
2. **可选参数有合理默认值**：在 description 中写明 `"Default: true"` 或 `"Default: 50000"`
3. **enum 代替自由文本**：`"enum": ["orchestrator", "executor"]` 比字符串更不容易出错
4. **description 中嵌入 e.g.**：每个 property 的 description 都应包含至少一个填写示例
