# xyz-agent

Tauri v2 + Vue 3 + Rust 单进程 AI Agent 引擎。

## Quickstart

### 环境准备

```bash
# 前置依赖：Rust, Node.js >= 18
cd xyz-agent
npm install
```

### 调试构建与启动

```bash
# 方式一：Tauri dev（推荐）— 前后端热重载
npm run tauri dev

# 方式二：分离启动
npm run dev          # 前端 dev server → localhost:1420
cd src-tauri && cargo run   # 后端 debug 构建

# 仅构建检查（不启动）
cd src-tauri && cargo check
npm run build        # vue-tsc 类型检查 + vite 构建
```

### 环境变量

```bash
# Anthropic API Key（必需）
export ANTHROPIC_API_KEY=sk-ant-...
# 或写入 ~/.xyz-agent/config.toml:
#   anthropic_api_key = sk-ant-...
```

### 测试

```bash
cd src-tauri && cargo test     # Rust 单元测试（36 个）
npm run build                   # 前端类型检查 + 构建
```

### 架构概览

```
src-tauri/src/
├── commands/    # Tauri Command 薄适配层
├── services/    # 业务逻辑（不依赖 tauri crate）
├── models/      # 纯数据结构
└── db/          # JSONL 持久化

src/
├── components/  # Vue 组件
├── composables/ # Composition API 逻辑复用
├── lib/         # Tauri invoke/listen 封装
└── types/       # TypeScript 类型定义
```

核心数据流：
LLM SSE → LlmStreamEvent → mpsc channel → EventBus → Tauri Event → Vue reactive state

## 提示词工程准则

**最高准则：在语义准确的情况下，尽量精简文字数量。**

工具定义（description + input_schema）和 system prompt 的每个字段都必须为模型提供足够上下文以正确生成调用参数，但不写冗余描述。

## 代码规范

- Rust：services/ 不 import tauri，纯业务逻辑可独立测试
- TypeScript：strict 模式，Composition API
- 提交格式：Conventional Commits（feat/fix/refactor/test/docs/chore）

### 其他

- superpowers目录：.claude/.superpowers
- Design System: [docs/design-system.md](docs/design-system.md) — 全局色彩、排版、间距、Markdown 渲染规范
- 编码标准: [docs/standards.md](docs/standards.md) — 架构模式与编码规范（文件持久化与 Registry 同步等）

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
