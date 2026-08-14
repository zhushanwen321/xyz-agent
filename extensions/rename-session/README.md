# @zhushanwen/pi-rename-session

Pi rename-session 扩展 — 新 session 首 turn 完成后，自动生成会话标题并落库（`setSessionName`），让 session 列表摆脱默认的日期/序号占位，一眼可辨。

## 功能

- 新 session 的**首个 turn** 完成后自动生成简短标题（3-8 个词，跟随对话语言）
- **独立选模**：标题生成用独立的 `ModelSelector` 配置（默认 `scoped`，取 `settings.json` enabledModels 首个可用），不搭便车主 session 的昂贵模型
- 标题直接 `setSessionName` 落库，不进 session history（不污染对话记录）
- fire-and-forget：任何失败（LLM 调用 / 提取 / auth / 读取）都静默跳过，保留原 label，绝不阻断 agent 循环
- **子 session 自动排除**：subagent 子进程 session 不触发 rename（避免给临时产物起名）

## 安装

```bash
pi install npm:@zhushanwen/pi-rename-session
```

## 配置

配置文件：`<agentDir>/config/rename-session-ext-config.json`（`<agentDir>` 默认 `~/.pi/agent`，`PI_CODING_AGENT_DIR` 可覆盖；xyz-agent 隔离环境为 `~/.xyz-agent/pi/agent`）。

```json
{
  "enabled": true,
  "model": { "type": "scoped" },
  "maxTitleLength": 50
}
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `false` | 自动重命名开关（受 flag 文件覆盖，见下） |
| `model` | `ModelSelector` | `{ "type": "scoped" }` | 标题生成模型，四形式见 config skill（`ref` / `fallback` / `available` / `scoped`） |
| `maxTitleLength` | `number` | `50` | 标题最大长度（Unicode 码点数，须正整数） |

文件缺失/坏 JSON 返回默认值，不抛错。改完保存即生效（mtime 读时刷新，每个 `turn_end` 重新 load）。

## 开关优先级（重要）

`enabled` 有两层来源，优先级从高到低：

1. **`<agentDir>/auto-rename-enabled` flag 文件**（存在 = 开）：xyz-agent runtime 的开关契约——桌面端 SystemPage 开关、首启默认开启都写这个文件。**xyz-agent 用户请通过桌面端开关或 `/auto-rename` 命令管理，不要手改 JSON 的 `enabled`**（flag 存在时永远视为开，手改会被覆盖）。
2. **config 的 `enabled` 字段**（默认 false）：flag 不存在时生效，是原生 pi CLI 用户的开关。

## 命令

```
/auto-rename          # 查看当前状态
/auto-rename on       # 开启（创建 flag 文件）
/auto-rename off      # 关闭（写 config.enabled=false + 删 flag，双写同步）
```

## 工作原理

1. **监听 `turn_end`**：每个 turn 完成时触发。
2. **开关 + subagent 过滤**：开关关闭（flag 不存在且 `enabled=false`）直接返回；session 路径含 `subagents` 段视为子进程 session，跳过。
3. **首 turn 判定**：统计 session entries 中 `assistant` 回复数，===1 才是首 turn（后续 turn 不重复 rename）。
4. **LLM 生成标题**：复用对话 messages 前缀（与主 turn 字节级一致，命中 kvcache），但用**独立精简 system prompt**（<200 字符，非整个 agent prompt）+ 显式 `tools: []`（纯文本生成，不暴露工具），按 `config.model` 独立选模发起一次 LLM 调用。
5. **落库**：调 `setSessionName` 写入清洗后的标题（去首尾引号/markdown 强调标记，按 Unicode 码点截断）。**不**写入 session history，对话记录不受影响。

## 子 session 自动排除

subagent 子进程的 session 目录形如 `.../subagents/...`，是临时产物。本扩展通过检测路径中的 `subagents` 段判定子 session，自动跳过 rename，避免给这些临时 session 生成噪音标题。

## 文件结构

```
rename-session/
├── index.ts              # 工厂入口（re-export src/index.ts）
├── package.json
├── vitest.config.ts
├── README.md
├── skills/rename-session-ext-config/SKILL.md   # 配置指南（pi 内 agent 可发现）
└── src/
    ├── index.ts          # 工厂入口（注册 turn_end handler + /auto-rename 命令）
    ├── commands.ts       # /auto-rename on|off|status 命令
    ├── llm.ts            # callRenameLLM / buildMessages / isSubagentSession
    ├── pure.ts           # 纯函数（loadRenameConfig / setAutoRenameSwitch / countAssistantReplies / cleanTitle）
    └── __tests__/        # 单测（pure / commands / llm mock / index 集成）
```
