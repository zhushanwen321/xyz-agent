---
name: model-switch-ext-config
description: "配置 @zhushanwen/pi-model-switch（模型切换 + 配额策略 + 场景路由）时加载。含配置文件路径、v2 schema、默认值、v1 迁移、示例。触发词：配置模型切换、model-switch 配置、model-policy、配额策略、场景路由、切换模型设置。"
---

# model-switch 配置指南

> @zhushanwen/pi-model-switch：为 pi 提供按场景（vision/planning/coding/chat）+ 配额用量推荐模型的策略引擎。session_start 注入精简能力表，`switch_model` 工具提供 list/search/switch/recommend/setup。配置文件**不强制存在**——无配置时扩展退化为不注入能力表、工具返回 "No model policy configured"。

## 配置文件位置

`<agentDir>/config/model-switch.json`

- `agentDir` 由 pi 的 `getAgentDir()`（`@earendil-works/pi-coding-agent`）推导，尊重 `PI_CODING_AGENT_DIR` 环境变量实现实例隔离（xyz-agent dev 为 `~/.xyz-agent-dev`，prod 为 `~/.xyz-agent`）
- 源码：`extensions/model-switch/src/config.ts` → `CONFIG_PATH = join(getAgentDir(), "config", "model-switch.json")`
- [HISTORICAL] 旧路径 `<agentDir>/model-policy.json`：npm 安装时经 `scripts/migrate-config.mjs` 自动迁移到新路径，运行时不双读旧路径
- 文件不存在时 `loadConfig()` 返回 `null`，扩展不注入能力表，`list`/`switch`/`recommend` 返回 `No model policy configured`

## Schema（v2）

顶层 `ModelPolicy`（`src/types.ts`），`version` 当前为 **2**（`config.ts` 的 `SUPPORTED_CONFIG_VERSION = 2`）：

| 字段 | 类型 | 必填 | 含义 |
|------|------|------|------|
| `version` | `number` | 是 | 配置版本，当前 `2`；`1` 自动迁移（见备注） |
| `models` | `Record<string, ProviderConfig>` | 是 | provider 名 → 该 provider 的套餐与模型表 |
| `scenes` | `Record<string, string[]>` | 是 | 场景名 → 模型 alias 列表（alias 指 `models[provider].models` 的 key） |
| `plans` | `Record<string, PlanConfig>` | 是 | 套餐名 → 配额/峰值策略 |
| `stickiness` | `StickinessConfig`（对象） | 是 | 粘性阈值，决定何时建议切换模型 |

### ProviderConfig（`models` 的 value）

| 字段 | 类型 | 必填 | 含义 |
|------|------|------|------|
| `plan` | `string` | 是 | 套餐标识，匹配 `plans` 的 key 与 quota-provider cache key |
| `models` | `Record<string, ModelEntry>` | 是 | alias → 模型条目 |

### ModelEntry（`models[*].models` 的 value）

| 字段 | 类型 | 必填 | 含义 |
|------|------|------|------|
| `modelId` | `string` | 是 | Pi model ID（如 `"glm-5.1"`、`"ds-flash"`） |
| `capabilities` | `string[]` | 是 | 输入模态，如 `["text", "image"]` |

### PlanConfig（`plans` 的 value）

| 字段 | 类型 | 必填 | 默认值 | 含义 |
|------|------|------|--------|------|
| `priority` | `number` | 是 | — | 套餐优先级 |
| `peak` | `{ start: number, end: number, multiplier: number }` | 否 | — | 峰值时段（24h 制小时整数）与成本倍率 |
| `budgetTarget` | `number` | 否 | — | 预算目标 |
| `peakStrategy` | `"conserve" \| "normal"` | 否 | `"conserve"` | 峰值策略 |
| `rollingWindowHours` | `number` | 否 | `5` | 滚动窗口小时数 |
| `thresholds` | `{ rollingLimitPct?, weeklyLimitPct? }` | 否 | `{ 80, 80 }` | 用量阈值百分比 |

> 默认值由 `config.ts` 的 `applyDefaults()` 在加载时对每个 plan 回填（v2 缺字段时自动补）。

### StickinessConfig（`stickiness`）

| 字段 | 类型 | 含义 | 参考默认 |
|------|------|------|----------|
| `minTurns` | `number` | 最小会话轮数，达到后才有粘性判断 | `3` |
| `minInputTokens` | `number` | 最小输入 token 数 | `20000` |

> `stickiness` 必须是对象（缺则 `loadConfig` 返回 `null`）。上表「参考默认」是 v1 迁移路径（`migrateV1`）填充的值；**v2 配置不会自动回填这两个字段**（`applyDefaults` 不覆盖 stickiness），请显式提供。

## scenes 场景说明

`scenes` 是「场景 → alias 列表」映射，`advisor.ts` 按场景名取候选 alias 列表做推荐（`advisor.ts:189 config.scenes[scene]`）。约定场景名（`setup.ts` 推断时使用）：

- `vision`：图片分析（含 image 能力的模型）
- `planning`：推理/规划（强推理模型）
- `coding`：编码（setup 始终生成）
- `chat`：闲聊（setup 始终生成）

场景名可自定义（`Record<string, string[]>`），上述为约定惯例。

## 配置示例

```json
{
  "version": 2,
  "models": {
    "zhipu": {
      "plan": "glm-plan",
      "models": {
        "glm-5.1": { "modelId": "glm-5.1", "capabilities": ["text", "image"] },
        "glm-air": { "modelId": "glm-air", "capabilities": ["text"] }
      }
    },
    "deepseek": {
      "plan": "ds-plan",
      "models": {
        "ds-flash": { "modelId": "ds-flash", "capabilities": ["text"] },
        "ds-pro": { "modelId": "ds-pro", "capabilities": ["text"] }
      }
    }
  },
  "scenes": {
    "vision": ["glm-5.1"],
    "planning": ["ds-pro"],
    "coding": ["ds-flash"],
    "chat": ["ds-flash"]
  },
  "plans": {
    "glm-plan": { "priority": 1, "peak": { "start": 9, "end": 18, "multiplier": 1.5 } },
    "ds-plan": { "priority": 2 }
  },
  "stickiness": { "minTurns": 3, "minInputTokens": 20000 }
}
```

## 备注

- **v1 自动迁移**：`version: 1` 的旧配置由 `migrateV1()` 在内存转换。v1 的 `models` 是 flat dict（`alias → {provider, modelId, plan, capabilities}`），v2 改为 provider-keyed；v1 provider 名的 `router-` 前缀会被去掉。迁移只在内存，**不回写文件**。
- **stickiness 无自动默认**：v2 配置必须显式提供 `stickiness` 对象（空对象 `{}` 合法但内部字段为 `undefined`）；`minTurns=3` / `minInputTokens=20000` 仅 v1 迁移路径自动填充。
- **配置不写回**：`loadConfig` 只读不写，不会自动生成默认配置文件。可用 `switch_model setup` 交互生成，或手动创建。
- **校验严格**：`models`/`scenes`/`plans`/`stickiness` 任一缺失或类型不符，`loadConfig` 直接返回 `null`（扩展不工作），日志见 `[model-switch] Config missing ...`。
- **实例隔离**：路径走 `getAgentDir()`，不同 `PI_CODING_AGENT_DIR` 完全隔离。
