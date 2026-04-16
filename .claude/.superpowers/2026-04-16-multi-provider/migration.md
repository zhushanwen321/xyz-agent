# 配置迁移

## 迁移策略

`load_llm_config()` 检测旧格式并自动迁移，不阻塞启动。

## 迁移条件

config.toml 存在以下字段但不存在 `[[providers]]`：
- `anthropic_api_key`
- `llm_model`
- `anthropic_base_url`

## 迁移行为

1. 创建名为 `"default"` 的 Provider
2. 映射字段：

| 旧字段 | 新字段 |
|--------|--------|
| `anthropic_api_key` | `providers[0].api_key` |
| `anthropic_base_url` | `providers[0].base_url` |
| `llm_model` | `providers[0].models[0].id` + `default_model` |

3. 写入迁移后的 config.toml（保留其他字段不变）

## 迁移后示例

```toml
# 保留的旧字段（向后兼容读取）
max_turns = 50
context_window = 200000
# ...

# 新增
default_model = "default/claude-sonnet-4-20250514"

[[providers]]
name = "default"
api_key = "sk-ant-..."
base_url = "https://api.anthropic.com"

[[providers.models]]
id = "claude-sonnet-4-20250514"
tier = "balanced"
```

## 错误处理

| 场景 | 处理 |
|------|------|
| 无 Provider 配置 | 前端显示配置引导，send_message 返回友好错误 |
| Provider 的 API Key 无效 | 首次使用时校验，UI 提示 |
| 切换到已删除的模型 | 回退到 default_model |
| config.toml 损坏 | 保留旧配置，用默认值启动 |
| provider name 重复 | 后写入的覆盖先写入的 |
