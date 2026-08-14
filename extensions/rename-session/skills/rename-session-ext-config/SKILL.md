---
name: rename-session-ext-config
description: "配置 @zhushanwen/pi-rename-session（会话自动重命名）时加载。含配置文件路径、RenameSessionConfig schema、ModelSelector 四形式、默认值、示例、旧开关迁移。触发词：配置重命名、rename 配置、自动标题、rename-session config、auto-rename 设置。"
---

# rename-session 配置指南

> @zhushanwen/pi-rename-session：首 turn 后自动用独立小模型生成会话标题（不搭便车主 session 的昂贵模型）。

## 配置文件位置

`<agentDir>/config/rename-session-ext-config.json`

- `<agentDir>` = pi agent 目录（`PI_CODING_AGENT_DIR` 覆盖，默认 `~/.pi/agent`；xyz-agent 隔离环境为 `~/.xyz-agent/pi/agent`）
- 走 llm-shared 泛型 config（config/ 子目录 + getAgentDir 派生 + mtime+size 缓存 + 原子写）
- 文件缺失/坏 JSON 返回默认值，不抛错

## Schema

```ts
interface RenameSessionConfig {
  enabled: boolean;        // 自动重命名开关，默认 false
  model: ModelSelector;    // 标题生成模型，默认 { type: "scoped" }
  maxTitleLength: number;  // 标题最大长度（Unicode 码点），默认 50
}
```

### ModelSelector 四形式（llm-shared 共用）

| type | 形式 | 语义 |
|---|---|---|
| `ref` | `{type:"ref", ref:"provider/modelId"}` | 精确指定（需配 auth） |
| `fallback` | `{type:"fallback", refs:[...]}` | 按序尝试首个可用 |
| `available` | `{type:"available"}` | getAvailable() 首个（配 auth 的全量池） |
| `scoped` | `{type:"scoped"}` | 读 settings.json 的 enabledModels 取首个可用（默认） |

> scoped 读的是用户启用列表（settings.json），不是凭证——凭证走 ctx.modelRegistry。enabledModels 支持 `*` 通配（如 `"anthropic/*"`），顺序即优先级。

## 默认值

```json
{ "enabled": false, "model": { "type": "scoped" }, "maxTitleLength": 50 }
```

## 配置示例

固定用便宜模型生成标题：
```json
{
  "enabled": true,
  "model": { "type": "ref", "ref": "deepseek/deepseek-chat" },
  "maxTitleLength": 50
}
```

多 provider 容错：
```json
{
  "enabled": true,
  "model": { "type": "fallback", "refs": ["zhipu/glm-4-flash", "deepseek/deepseek-chat"] }
}
```

零配置（用用户启用列表首个）：只需把 enabled 设 true，model 保持默认 scoped。

## 旧开关迁移

旧版开关是 `<agentDir>/auto-rename-enabled` 文件存在性。升级后检测到旧文件 + 无新配置 → 自动迁移为 enabled:true 写入新配置 + 删旧文件。

## LLM 调用特性

- 独立 model（不搭便车主 session 模型）
- 独立精简 system prompt（~75 字符，非整个 agent prompt）
- 不传 tools（纯文本标题生成）
- fire-and-forget（不阻塞 turn_end handler）
- model 不可用 → 静默跳过（日志 `[rename-session] model not available, skipping`），不阻断主对话
