---
name: rename-session-ext-config
description: "配置 @zhushanwen/pi-rename-session（会话自动重命名）时加载。含配置文件路径、RenameSessionConfig schema、ModelSelector 四形式、触发时机（首 turn）、maxTitleLength 约束、默认值、示例、生效时机、旧开关迁移。触发词：配置重命名、rename 配置、自动标题、rename-session config、auto-rename 设置、首 turn、触发时机。"
---

# rename-session 配置指南

> @zhushanwen/pi-rename-session：新 session 首 turn 完成后，用独立小模型生成会话标题（不搭便车主 session 的昂贵模型）。

## 配置文件位置

`<agentDir>/config/rename-session-ext-config.json`

- `<agentDir>` = pi agent 目录（`PI_CODING_AGENT_DIR` 覆盖，默认 `~/.pi/agent`；xyz-agent 隔离环境为 `~/.xyz-agent/pi/agent`）
- 走 llm-shared 泛型 config（config/ 子目录 + getAgentDir 派生 + mtime+size 缓存 + 原子写）
- 文件缺失/坏 JSON 返回默认值，不抛错

## 何时触发重命名（重要）

**仅在新 session 的第一个 turn 完成后触发一次**（判定条件：session 内 assistant 回复数 === 1）。

- 已存在的多 turn session **不会回溯重命名**——开启 `enabled` 后只对之后新建的 session 生效
- 每个 session 最多重命名一次（首 turn 后不再触发）
- 若首 turn 时 LLM 调用失败，静默跳过保留原标题，不重试

> 改完配置「没看到 session 被重命名」的常见原因：当前 session 已过首 turn。新建一个 session 测试。

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

### maxTitleLength 约束

必须是**正整数**（`Number.isInteger && > 0`）。传小数（`50.5`）、0、负数、非数字都会回落默认值 50。截断按 Unicode 码点（不会截断多字节字符）。

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

## 配置生效时机

配置走 mtime+size 读时刷新（每个 `turn_end` 都重新 load）。改完 JSON 保存后，**下一个新 session 的首 turn** 即按新配置触发（已过首 turn 的 session 不受影响）。

## 排除项

subagent 子进程 session 不重命名（`isSubagentSession` 判定 session 目录）——子 session 是临时产物，重命名会产生噪音。如果你发现某个 session 没被重命名，先确认它不是 subagent session。

## 旧开关迁移

旧版开关是 `<agentDir>/auto-rename-enabled` 文件存在性。升级后检测到旧文件 + 无新配置 → 自动迁移为 enabled:true 写入新配置 + 删旧文件。

## LLM 调用特性

- 独立 model（不搭便车主 session 模型）
- 独立精简 system prompt（~75 字符，非整个 agent prompt）
- 不传 tools（纯文本标题生成）
- fire-and-forget（不阻塞 turn_end handler）
- model 不可用 → 静默跳过（日志 `[rename-session] model not available, skipping`），不阻断主对话
