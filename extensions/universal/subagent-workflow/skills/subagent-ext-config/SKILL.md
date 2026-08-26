---
name: subagent-ext-config
description: "使用或排查 @zhushanwen/pi-subagent-workflow 的引擎路由配置时加载。说明 config.json 三环境路径与动态推导方法、字段表（defaultEngine / engineRouting.strict / maxConcurrent）、三层路由优先级、生效时机（新 session 生效）、probe 缓存语义、验证步骤与常见错误。触发词：subagent 引擎配置、切换 subagent 引擎、defaultEngine、zcode 派发、subagent 配置在哪、engineFallback、engine_not_found、subagent-ext-config。"
---

# subagent-workflow 引擎路由配置指南

> @zhushanwen/pi-subagent-workflow：subagent 派发扩展。P4 起支持多引擎路由（pi / zcode），路由偏好来自 config.json + 调用点覆盖。本指南讲清配置位置、字段语义、生效时机与排查路径。

**重要前提**：配置在 pi 子进程启动与每次 `session_start` 时读取——**改完 config.json 后必须新建 session 才生效**，当前 session 内不重读。用户问「改了没生效」时先确认这一点，不要怀疑文件路径。

## 配置文件在哪（三环境）

config.json 位于 pi agent 目录下的 `subagents/config.json`，随环境不同：

| 环境 | 路径 |
|------|------|
| 独立 pi CLI | `~/.pi/agent/subagents/config.json` |
| xyz-agent dev | `~/.xyz-agent-dev/pi/agent/subagents/config.json` |
| xyz-agent prod | `~/.xyz-agent/pi/agent/subagents/config.json` |

**动态推导（推荐）**：agentDir 由 pi 核心 `getAgentDir()` 决定（读 `PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`）；xyz-agent 通过 `XYZ_AGENT_DATA_DIR` 隔离数据目录。排查时先查这两个 env 变量组合出实际路径（`<agentDir>/subagents/config.json`），不要假设单一环境——写错环境的配置文件改了也不生效。

文件不存在 / JSON 解析失败 / 字段缺失时全部回默认配置，不报错。旧版 `categories` / `fallback` / `yoloByDefault` 等字段读取时忽略（模型解析已退化为「主 agent model 优先」）。

## 字段表（sanitize 语义）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `defaultEngine` | string | 缺省由路由层落 `'pi'` | 全局默认引擎。合法值 `'pi'` / `'zcode'`。坏值（非字符串/空串）**静默忽略**回缺省 pi，不报错——排查「改了 defaultEngine 却还在用 pi」时先检查 JSON 值合法性 |
| `engineRouting.strict` | boolean | `false` | `true` = 一切 probe 失败直接报错、不做兜底回退。仅认 strict 布尔键，其余键忽略 |
| `maxConcurrent` | number | `6` | subagent 并发池大小。正整数，非正整数/非整数回默认 |

示例（最小可用）：

```json
{
  "version": 1,
  "defaultEngine": "zcode",
  "engineRouting": { "strict": false },
  "maxConcurrent": 6
}
```

## 三层路由优先级

一次 subagent 派发用哪个引擎，按以下顺序决定（高优先级覆盖低优先级）：

| 优先级 | 来源 |
|------|------|
| 1 | `subagents` 工具调用的 `engine` 参数（单次指定） |
| 2 | agent `.md` frontmatter 的 `engine` 字段 |
| 3 | config.json 的 `defaultEngine` |

显式指定（层级 1/2）属「守卫命中」——probe 失败**不兜底**、直接报 `engine_probe_failed`；仅全局默认任务才走 fallback 兜底回 pi。

## 生效时机与 probe 缓存

- **配置读取**：pi 子进程启动 + 每次 `session_start` 各读一次，session 内不重读。改配置 → 新建 session 生效。
- **probe 缓存**：引擎探针（zcode CLI 存在性/版本检查）成功或失败均缓存直返，**进程存活期内不重探**。
- **engineFallback 留痕条件**：兜底回 pi（record 带 `engineFallback` 标记）只在探针**未缓存**时触发。同一 session 内先 probe 成功后 CLI 损坏，不会再触发兜底。要复现/验证 fallback 场景，必须新建 session 重置缓存。

## 验证步骤

改完配置后：

1. **新建 session**（必须——当前 session 不重读配置）。
2. 让主 agent 派一个 subagent（例：用 `subagents` 工具发个简单任务）。
3. xyz-agent 侧边栏 **Agents tab** 看该项最左的引擎 icon（pi / zcode）——这是统一验证面。
4. journal 落点 `~/.xyz-agent-dev/engines/<engineId>/` **仅适用非 pi 引擎**（zcode 分支建 journal）；pi 分支不建 journal，pi 任务以 icon 为验证面。

## 常见错误排查

| 症状 | 原因与处置 |
|------|------|
| `engine_not_found` | engine id 未注册。检查拼写，合法值仅 `pi` / `zcode` |
| zcode 任务传 `conversation` / `fork` / `worktree` 被预检拒绝 | 这些是 pi 专属能力，zcode 不支持。改用 `engine: pi` 或不传该参数重试（预检在 record 创建前同步拒绝，可立即换引擎） |
| 改了 `defaultEngine` 没生效 | 两种可能：① 当前 session 不重读配置——新建 session；② 值非法被静默忽略回 pi——核对 JSON 值 |
| 期望 fallback 回 pi 却报错 | 显式指定引擎（工具参数/frontmatter）属守卫命中，probe 失败不兜底直接报错；只有走 `defaultEngine` 的任务才兜底 |
| probe 结果与 CLI 实际状态不符 | 探针进程存活期内缓存——CLI 刚装好/刚损坏，需新建 session 重置缓存 |
