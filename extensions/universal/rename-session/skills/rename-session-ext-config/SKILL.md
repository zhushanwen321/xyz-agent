---
name: rename-session-ext-config
description: "配置 @zhushanwen/pi-rename-session（会话自动重命名）时加载。含配置文件路径、RenameSessionConfig schema、ModelSelector ref 精确指定、触发时机（首 turn）、maxTitleLength 约束、默认值、示例、生效时机、开关优先级（flag 覆盖）。触发词：配置重命名、rename 配置、自动标题、rename-session config、auto-rename 设置、首 turn、触发时机、开关不生效。"
---

# rename-session 配置指南

> @zhushanwen/pi-rename-session：新 session 首个成功 round 完成后，用独立小模型生成会话标题（不搭便车主 session 的昂贵模型）。

## 配置文件位置

`<agentDir>/config/rename-session-ext-config.json`

- `<agentDir>` = pi agent 目录（`PI_CODING_AGENT_DIR` 覆盖，默认 `~/.pi/agent`；xyz-agent 隔离环境为 `~/.xyz-agent/pi/agent`）
- 走 llm-shared 泛型 config（config/ 子目录 + getAgentDir 派生 + mtime+size 缓存 + 原子写）
- 文件缺失/坏 JSON 返回默认值，不抛错

## 何时触发重命名（重要）

**仅在新 session 的首个成功 round 完成后触发一次**（判定条件：round 最终 turn 的 `stopReason === "stop"`，且 session 内成功（stop）assistant 回复数 === 1）。

- 已存在的多 turn session **不会回溯重命名**——开启 `enabled` 后只对之后新建的 session 生效
- 每个 session 最多重命名一次（首个成功 round 后不再触发）
- 工具中间轮（`stopReason === "toolUse"`）不评估；error/aborted/length 轮延迟到下一个成功轮再命名
- 若首个成功 round 时 LLM 调用失败，静默跳过保留原标题，不重试

> 改完配置「没看到 session 被重命名」的常见原因：当前 session 已过首个成功 round。新建一个 session 测试。

## Schema

```ts
interface RenameSessionConfig {
  enabled: boolean;        // 自动重命名开关，默认 false
  model: ModelSelector;    // 标题生成模型，默认 { type: "ref", ref: "" }（未配置则解析不到，跳过 rename）
  maxTitleLength: number;  // 标题最大长度（Unicode 码点），默认 50
  thinkingLevel: ModelThinkingLevel;  // 标题 LLM 的 thinking 级别，默认 "off"
}
```

### ModelSelector（仅支持 ref 精确指定）

| type | 形式 | 语义 |
|---|---|---|
| `ref` | `{type:"ref", ref:"provider/modelId"}` | 精确指定（需配 auth） |

不再支持 `fallback` / `available` / `scoped`。需要自动选模时请在调用方（如 permission 的 `"auto"`）自行基于 `ctx.modelRegistry` 实现。

### maxTitleLength 约束

必须是**正整数**（`Number.isInteger && > 0`）。传小数（`50.5`）、0、负数、非数字都会回落默认值 50。截断按 Unicode 码点（不会截断多字节字符）。

### thinkingLevel 取值

标题 LLM 的 thinking 级别，枚举 `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`（pi 的 `ModelThinkingLevel`）。默认 `"off"`：直接透传给 llm-shared，由 llm-shared 映射为不传 reasoning（provider 默认行为）；`minimal`~`max` 透传给 reasoning（provider 不支持时静默忽略）。缺失或非法值回落 `"off"`。

## 默认值

```json
{ "enabled": false, "model": { "type": "ref", "ref": "" }, "maxTitleLength": 50, "thinkingLevel": "off" }
```

## 环境变量覆盖（容器化部署/CI-CD）

支持通过环境变量覆盖配置，适用于容器化部署、CI/CD 等场景。环境变量优先级最高，覆盖配置文件和 flag 文件。

| 环境变量 | 说明 | 示例值 |
|---|---|---|
| `PI_RENAME_ENABLED` | 自动重命名开关 | `true` / `false` |
| `PI_RENAME_MODEL` | 模型引用（`provider/model` 格式，映射为 `{type:"ref", ref:"provider/model"}`） | `deepseek/chat` |
| `PI_RENAME_MAX_TITLE_LENGTH` | 标题最大长度（正整数） | `30` |
| `PI_RENAME_THINKING_LEVEL` | thinking 级别 | `minimal` / `high` |

**注意事项：**
- 环境变量值无效时静默忽略，回落到配置文件或默认值
- 环境变量优先级最高，即使 flag 文件存在，`PI_RENAME_ENABLED=false` 也会禁用重命名
- 环境变量每次调用时 live 读取，修改后无需重启进程（下一个 `turn_end` 生效）
- 环境变量只支持简单 `provider/model` 覆盖；ModelSelector 本身仅支持 ref 精确指定

**使用示例：**
```bash
# 容器化部署：启用重命名 + 指定便宜模型
PI_RENAME_ENABLED=true PI_RENAME_MODEL=deepseek/chat node app.js

# CI/CD 禁用重命名
PI_RENAME_ENABLED=false npm test

# 开发环境：使用轻量 thinking
PI_RENAME_ENABLED=true PI_RENAME_THINKING_LEVEL=minimal npm run dev
```

## 配置示例

固定用便宜模型生成标题：
```json
{
  "enabled": true,
  "model": { "type": "ref", "ref": "deepseek/deepseek-chat" },
  "maxTitleLength": 50,
  "thinkingLevel": "off"
}
```

> 必须精确指定 `ref`；未配置或 ref 为空时解析不到模型，rename 会静默跳过。

## 配置生效时机

配置走 mtime+size 读时刷新（每个 `turn_end` 都重新 load）。改完 JSON 保存后，**下一个新 session 的首个成功 round** 即按新配置触发（已过首个成功 round 的 session 不受影响）。

**环境变量生效时机：** 环境变量每次调用时 live 读取（`process.env`），修改后无需重启进程，下一个 `turn_end` 即按新环境变量生效。

## 排除项

subagent 子进程 session 不重命名（`isSubagentSession` 判定 session 目录）——子 session 是临时产物，重命名会产生噪音。如果你发现某个 session 没被重命名，先确认它不是 subagent session。

## 开关优先级（重要）

`enabled` 有四层来源，优先级从高到低（`src/pure.ts` `loadRenameConfig`）：

1. **环境变量 `PI_RENAME_ENABLED`**（最高优先级）：适用于容器化部署、CI/CD 等场景。`true`/`false` 字符串，live 读取。显式设置时覆盖 flag 文件和配置文件（`PI_RENAME_ENABLED=false` 即使 flag 存在也禁用重命名）。
2. **`<agentDir>/auto-rename-enabled` flag 文件**（存在 = 开）：这是 xyz-agent runtime 的开关契约（SystemPage 开关 / 首启默认开启都写这个文件，live 检查每次 turn_end 生效）。**xyz-agent 用户不要手改 JSON 里的 enabled**——桌面端的开关状态存在 flag 文件里，手改 JSON 会被 flag 覆盖（环境变量未显式设置 `PI_RENAME_ENABLED` 时，flag 存在即视为开）。
3. **config 的 `enabled` 字段**（默认 false）：环境变量未设置且 flag 不存在时生效，是原生 pi CLI 用户的开关（手改 JSON 或 `/auto-rename on|off` 命令）。
4. **默认值**（false）：以上三层均未设置时。

`/auto-rename on` 只创建 flag；`/auto-rename off` 写 config.enabled=false + 删 flag（双写同步）。旧版升级用户：旧 flag 文件保留不动，仍作为开关生效，无需任何迁移操作。

## LLM 调用特性

- 独立 model（不搭便车主 session 模型）
- 独立精简 system prompt（<200 字符的 slug 词组约束 + 正反例 few-shot，非整个 agent prompt）
- 不传 tools（纯文本标题生成）
- fire-and-forget（不阻塞 turn_end handler）
- model 不可用 → 静默跳过（日志 `[rename-session] model not available, skipping`），不阻断主对话
