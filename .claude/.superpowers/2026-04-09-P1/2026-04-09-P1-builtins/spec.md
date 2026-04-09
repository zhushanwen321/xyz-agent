# P1-内置工具 设计规格

**版本**: v1 | **日期**: 2026-04-09 | **状态**: 已确认

---

## 目标

实现 3 个内置工具（Read、Write、Bash），让 Agent 具备文件读写和命令执行能力。

## 不包含

- analysis 工具（推迟到 P2，随 SubAgent 设计）
- context_compact 工具（随 ContextManager 设计）
- 文件搜索（Glob/Grep）、文件编辑（Edit）——后续按需添加

---

## 工具清单

### Read

读取文件内容。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| file_path | String | 是 | 相对或绝对路径 |
| offset | usize | 否 | 起始行号（1-based） |
| limit | usize | 否 | 最大行数，默认 2000 |

**行为**：
- 路径解析 → 检查在工作目录内 → 读取文件
- 输出 `cat -n` 格式（带行号）
- 文件不存在 → `is_error: true`
- 属性：`concurrent_safe = true`，`timeout = 10s`

### Write

写入文件（覆盖或新建）。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| file_path | String | 是 | 相对或绝对路径 |
| content | String | 是 | 写入内容 |

**行为**：
- 路径解析 → 检查在工作目录内
- 父目录不存在 → `is_error: true`（不自动创建目录）
- 已有文件 → 完全覆盖
- 写入成功 → 返回 `"ok"`
- 属性：`concurrent_safe = false`，`timeout = 10s`

### Bash

执行 shell 命令。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| command | String | 是 | 要执行的命令 |
| timeout | u64 | 否 | 超时秒数，默认 120 |
| workdir | String | 否 | 工作目录，默认项目根目录 |

**行为**：
- `tokio::process::Command` 执行，捕获 stdout + stderr
- 输出合并 stdout/stderr，超出 100KB 截断并追加 `[truncated]` 标记
- 退出码非 0 → `is_error: true`，输出中包含退出码
- 超时后 kill 进程，返回超时错误信息
- 环境变量继承当前进程环境
- 属性：`concurrent_safe = false`，`timeout = 120s`

---

## 文件结构

```
src-tauri/src/services/tools/
├── mod.rs          # register_builtin_tools(registry, workdir)
├── read_tool.rs    # ReadTool struct + Tool impl
├── write_tool.rs   # WriteTool struct + Tool impl
└── bash_tool.rs    # BashTool struct + Tool impl
```

## 注册入口

```rust
// tools/mod.rs
pub fn register_builtin_tools(registry: &mut ToolRegistry, workdir: PathBuf) {
    registry.register(Arc::new(ReadTool::new(workdir.clone())));
    registry.register(Arc::new(WriteTool::new(workdir.clone())));
    registry.register(Arc::new(BashTool::new(workdir)));
}
```

`lib.rs` 中调用：`tools::register_builtin_tools(&mut registry, workdir)`

## 共同约定

- 路径参数接受相对路径（基于工作目录解析）和绝对路径
- 绝对路径必须在工作目录内，否则拒绝（路径遍历保护）
- 错误通过 `ToolResult { is_error: true }` 返回
- 输出最大 100KB（与 ToolRouter spec 对齐）

## 约束

- `tools/` 目录下不 import tauri（遵循 architecture.md）
- JSON Schema 输出兼容 Anthropic tool definition 格式
- Bash 工具不使用 Docker 沙箱，P1 先信任 Agent
