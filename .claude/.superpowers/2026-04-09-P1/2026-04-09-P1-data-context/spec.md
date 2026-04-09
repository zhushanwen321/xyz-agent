# P1-DataContext 设计规格

**版本**: v1 | **日期**: 2026-04-09 | **状态**: 已确认

---

## 目标

追踪 Agent 已获取的数据（主要是文件读取），生成摘要注入系统提示词动态层，帮助 Agent 了解"已知什么"并避免重复读取。

## 不包含

- FileStateCache LRU 缓存（P2，100 条/25MB，含文件内容缓存）
- 文件变更检测（P2，mtime 比较 + diff 生成）
- Post-compact 文件重注入（P2，与 ContextManager 集成，恢复最近 5 文件 / 50K budget）
- AttachmentMessage 系统（P2，@mention 文件、Memory、Skills 等多种附件注入）
- 工具结果状态追踪（P2，Bash 输出、Grep 匹配等）

## 参考

- Claude Code `src/tools/FileReadTool/` — FileStateCache, readFileState
- Claude Code `src/services/compact/compact.ts:518` — Post-compact 文件重注入
- Claude Code `src/services/attachments.ts` — AttachmentMessage 系统、变更检测

---

## 核心类型

### DataContext

```rust
pub struct DataContext {
    files: HashMap<String, FileInfo>,  // path → info
}

pub struct FileInfo {
    pub size_bytes: u64,
    pub line_count: u32,
    pub read_at: String,  // ISO timestamp
}

impl DataContext {
    pub fn new() -> Self;

    /// 记录文件读取（由 Read 工具调用后触发）
    pub fn record_file_read(&mut self, path: &str, size_bytes: u64, line_count: u32);

    /// 生成摘要文本，注入 DynamicContext.data_context_summary
    /// 格式："Recently read: main.rs (120 lines), config.toml (45 lines)"
    pub fn generate_summary(&self) -> Option<String>;

    /// 清空（ContextManager 第二层压缩后可选清空）
    pub fn clear(&mut self);
}
```

### 摘要格式

```
Recently read files:
- src/main.rs (120 lines, 3.2KB)
- src/lib.rs (45 lines, 1.1KB)
- Cargo.toml (32 lines, 0.8KB)
```

按最近读取时间排序，最多列出 20 个文件。超过 20 个时只显示最近 20 个 + 总数提示。

---

## 集成点

### 1. Read 工具调用后更新

```rust
// 在 ToolExecutor 执行 Read 工具后：
if tool_name == "Read" {
    data_context.record_file_read(&path, size, line_count);
}
```

通过 `ToolExecutor::execute_batch` 返回扩展结果，或在 `AgentLoop` 中拦截 Read 工具的执行结果。

**推荐方案**：在 AgentLoop 的工具执行后，检查 tool_name 为 "Read" 时更新 DataContext。不需要修改 Tool trait。

### 2. 注入 PromptManager 动态层

```rust
// 构建 DynamicContext 时：
let dynamic = DynamicContext {
    cwd, os, model, git_branch, tool_names,
    data_context_summary: data_context.generate_summary(),  // NEW
};
```

### 3. AgentLoop 生命周期

```rust
// AgentLoop::run_turn 中：
let mut data_context = DataContext::new();  // 每次 run_turn 创建

loop {
    // ... 工具执行 ...
    // Read 工具结果后更新
    if tool_name == "Read" {
        data_context.record_file_read(path, size, lines);
    }

    // 构建 system prompt（注入摘要）
    let dynamic = DynamicContext { ..., data_context_summary: data_context.generate_summary() };
    let system = prompt_manager.build_system_prompt(&dynamic);
    // ...
}
```

---

## 新增文件

| 文件 | 职责 |
|------|------|
| `src-tauri/src/services/data_context.rs` | DataContext, FileInfo |

## 修改文件

| 文件 | 变更 |
|------|------|
| `src-tauri/src/services/agent_loop.rs` | 创建 DataContext，Read 工具结果后更新，注入 DynamicContext |
| `src-tauri/src/services/prompt_manager.rs` | DynamicContext.data_context_summary 渲染 |

## 约束

- DataContext 不 import tauri
- P1 不缓存文件内容（只记元数据）
- P1 不做变更检测（不知晓文件是否被修改）
- 每次 `run_turn` 创建新的 DataContext（不跨 session 持久化）

## 已知限制

- **不追踪文件内容**：只记元数据（路径、大小、行数），不缓存内容。
  TODO (P2)：FileStateCache 缓存内容，支持变更检测和 diff 生成。
- **不跨 session 持久化**：每次 run_turn 新建，session 结束后丢失。
  TODO (P2)：持久化到 session 元数据。
- **不追踪非文件工具结果**：Bash 输出、Grep 匹配等不被追踪。
  TODO (P2)：全工具结果追踪。
- **Post-compact 不重注入**：压缩后已读取文件信息丢失。
  TODO (P2)：与 ContextManager 集成，压缩后恢复最近文件。
- **不检测文件变更**：不知道文件是否被外部修改。
  TODO (P2)：mtime 比较 + diff 附件。

---

## 与 agent-benchmark 维度对照

### 2. Context 工程（补充）

| 设计点 | Claude Code | 本 spec P1 | 差距 |
|--------|------------|-----------|------|
| 文件读取追踪 | FileStateCache (LRU 100/25MB) | HashMap<path, FileInfo> | 基础对齐 |
| 文件变更检测 | mtime 比较 + diff 附件 | 不涉及 | TODO (P2) |
| Post-compact 重注入 | 恢复 5 文件 / 50K budget | 不涉及 | TODO (P2) |
| Attachment 注入 | 20+ 种附件类型 | 仅动态层文本摘要 | TODO (P2) |
