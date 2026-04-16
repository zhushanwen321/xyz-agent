# xyz-agent

> **Status: Active Development** — 项目正在积极开发中，基础功能已可用，更多能力持续构建中。

个人通用 AI Agent 助手，基于 **Tauri v2 + Vue 3 + Rust** 构建的单进程 Agent 引擎。

核心理念：自由组合 Agent、Tools、MCP Server、Skill，组建面向不同场景（coding、文档撰写、自媒体运营、财务分析、生活助手）的能力团队。

## 已有功能

- [x] SSE 流式对话
- [x] Agent 系统与提示词管理（general_purpose / plan / explore）
- [x] 内置工具：bash、read、write、feedback、dispatch_agent、orchestrate
- [x] 子 Agent 生命周期管理（派发、预算控制、并发限制）
- [x] 上下文管理（任务树、动态上下文构建）
- [x] 会话持久化（JSONL 存储）
- [x] TOML 配置系统（API Key、模型、Agent 参数）
- [x] 前端 UI（对话、侧栏、设置、工具调用卡片、子 Agent 面板）

## Roadmap

详见 [GitHub Project](https://github.com/users/zhushanwen321/projects/2) 和 [Wiki - Roadmap](https://github.com/zhushanwen321/xyz-agent/wiki/Roadmap)。

| 优先级 | 功能 | 状态 |
|--------|------|------|
| P1 | 模型切换支持（多 Provider） | 规划中 |
| P1 | 命令系统（Slash Commands） | 规划中 |
| P1 | Skill 和 MCP Server 支持 | 规划中 |
| P1 | 上下文压缩优化 | 规划中 |
| P1 | Coding 能力完善 | 规划中 |
| P2 | 场景构建支持（Team Assembly） | 规划中 |
| P2 | Orchestrate 功能完善 | 规划中 |

## Quickstart

### Prerequisites

- Rust (stable)
- Node.js >= 18
- Anthropic API Key

### Install & Run

```bash
git clone https://github.com/zhushanwen321/xyz-agent.git
cd xyz-agent
npm install

# Configure API key (either way)
export ANTHROPIC_API_KEY=sk-ant-...
# or write to ~/.xyz-agent/config.toml:
#   anthropic_api_key = "sk-ant-..."

# Start dev (hot reload for both frontend & backend)
npm run tauri dev
```

### Build & Test

```bash
cd src-tauri && cargo test           # Rust tests
npm run build                        # Frontend type check + build
cd src-tauri && cargo check          # Rust compile check
```

## Architecture

```
src-tauri/src/
├── api/          Tauri Command 适配层 + EventBus
├── engine/       核心业务逻辑（不依赖 tauri crate）
│   ├── llm/          LLM Provider trait + Anthropic 实现
│   ├── loop_/        AgentLoop — 多轮工具调用循环 + SSE 流解析
│   ├── tools/        ToolRegistry + 内置工具
│   ├── context/      提示词构建
│   └── config/       TOML 配置
├── prompts/      Agent 系统提示词
├── types/        纯数据结构
└── store/        JSONL 持久化

src/
├── components/   Vue 组件
├── composables/  Composition API 逻辑复用
├── lib/          Tauri invoke/listen 封装
└── types/        TypeScript 类型定义
```

数据流：`用户输入 → Tauri Command → AgentLoop → LLM SSE → mpsc channel → EventBus → Vue reactive state`

## Documentation

- [Wiki](https://github.com/zhushanwen321/xyz-agent/wiki) — 架构设计、配置说明、工具系统

## License

Private — personal use only.
