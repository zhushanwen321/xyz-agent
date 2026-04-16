# 配置格式

## config.toml 结构

```toml
# 全局默认模型
default_model = "anthropic-official/claude-sonnet-4-20250514"

[[providers]]
name = "anthropic-official"
api_key = "sk-ant-..."
base_url = "https://api.anthropic.com"

[[providers.models]]
id = "claude-sonnet-4-20250514"
tier = "balanced"

[[providers.models]]
id = "claude-opus-4-20250514"
alias = "Opus 4"
tier = "reasoning"

[[providers]]
name = "my-proxy"
api_key = "sk-..."
base_url = "https://proxy.example.com"

[[providers.models]]
id = "claude-sonnet-4-20250514"
```

## 字段说明

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `default_model` | 否 | 第一个 provider 的第一个 model | 全局默认模型标识 |
| `providers[].name` | 是 | - | Provider 唯一标识 |
| `providers[].api_key` | 是 | - | API 密钥 |
| `providers[].base_url` | 否 | `https://api.anthropic.com` | API 端点 |
| `providers[].models[].id` | 是 | - | 模型 ID |
| `providers[].models[].alias` | 否 | model id | UI 显示名 |
| `providers[].models[].tier` | 否 | `balanced` | 能力层级 |

## 环境变量覆盖

环境变量仍然支持，作为 fallback：

| 环境变量 | 作用 |
|---------|------|
| `ANTHROPIC_API_KEY` | 未配置 Provider 时的默认 Key |
| `ANTHROPIC_BASE_URL` | 未配置 Provider 时的默认 URL |
| `LLM_MODEL` | 未配置模型时的默认模型 |
