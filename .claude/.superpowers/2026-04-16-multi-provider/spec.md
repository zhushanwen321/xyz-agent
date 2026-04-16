# Multi-Provider 模型管理系统

## 概述

支持配置多个 Anthropic 兼容的 LLM Provider，每个 Provider 下可定义多个模型。
用户可在聊天时切换模型，也可在 Settings 中将 Agent 模板绑定到指定模型。

**范围：** 仅支持 Anthropic API 兼容的供应商（相同 SSE 流格式）。

## 数据模型

### ProviderConfig

```rust
struct ProviderConfig {
    name: String,        // 唯一标识，如 "anthropic-official"
    api_key: String,
    base_url: String,    // 默认 "https://api.anthropic.com"
    models: Vec<ModelEntry>,
}
```

### ModelEntry

```rust
struct ModelEntry {
    id: String,              // 模型 ID，如 "claude-sonnet-4-20250514"
    alias: Option<String>,   // 可选显示名，如 "Sonnet 4"
    tier: ModelTier,         // 能力层级
}
```

### ModelTier

```rust
#[derive(Default)]
#[serde(rename_all = "snake_case")]
enum ModelTier {
    #[default]
    Balanced,   // 均衡 — 日常编码（Sonnet 定位）
    Reasoning,  // 深度推理 — 复杂分析（Opus 定位）
    Fast,       // 快速 — 简单任务（Haiku 定位）
}
```

### 全局模型标识符

`provider_name/model_id` 格式作为全局唯一标识，贯穿前后端。
示例：`anthropic-official/claude-sonnet-4-20250514`

## 配置格式

见 [config-format.md](config-format.md)

## 后端架构

见 [backend-architecture.md](backend-architecture.md)

## 前端 UI

见 [frontend-ui.md](frontend-ui.md)

## 配置迁移

见 [migration.md](migration.md)

## 不在 P1 范围

- 流式对话中实时切换模型
- Token 用量按 Provider 分别统计
- 模型能力探测（自动检测支持的 feature）
- 非 Anthropic 兼容的 Provider（OpenAI 等）
