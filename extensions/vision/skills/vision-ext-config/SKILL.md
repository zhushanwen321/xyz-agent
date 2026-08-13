---
name: vision-ext-config
description: "配置 @zhushanwen/pi-vision（多模态视觉模型图片分析）时加载。含配置文件路径、vision-models schema、默认行为、fallback 链、示例。触发词：配置视觉模型、vision 配置、vision-models、图片分析模型设置、analyze_image 模型。"
---

# vision 配置指南

> @zhushanwen/pi-vision：提供 `analyze_image` 工具，spawn 一个独立的 pi 子进程用多模态视觉模型分析图片。图片只在子进程内处理，**不进入主 session 上下文**；主 session 只收到文本分析结论。支持 fork 模式（继承父 session 上下文做带上下文的图片分析）。

## 配置文件位置

`<agentDir>/config/vision.json`

- `agentDir` 由 pi 的 `getAgentDir()`（`@earendil-works/pi-coding-agent`）推导，尊重 `PI_CODING_AGENT_DIR` 环境变量实现实例隔离
- 源码：`extensions/vision/src/vision-model.ts` → `VISION_MODELS_PATH = path.join(getAgentDir(), "config", "vision.json")`
- [HISTORICAL] 旧路径 `<agentDir>/vision-models.json`：npm 安装时经 `scripts/migrate-config.mjs` 自动迁移到新路径，运行时不双读旧路径
- 文件不存在时 `loadVisionModels()` 返回 `null`，`analyze_image` 抛错 `No vision models configured. Create <path> with model entries.`（即**无配置 = 工具不可用**，没有内置默认模型）

## Schema（VisionModelsConfig）

顶层只有一个 `models` 数组（`src/vision-model.ts`）：

```ts
interface VisionModelsConfig {
  models: VisionModelEntry[];
}
```

每个 `VisionModelEntry`：

| 字段 | 类型 | 必填 | 含义 |
|------|------|------|------|
| `id` | `string` | 是 | 模型 ID（与 `provider` 拼成 `provider/id` ref，如 `opencode-go-router/mimo-v2.5`） |
| `provider` | `string` | 是 | provider 名；**缺失则该条目被跳过并告警** |
| `order` | `number` | 是 | 优先级，越小越优先；候选链按 `order` 升序排列 |
| `thinkingLevel` | `"high" \| "max"` | 否 | 传给子进程的思考深度 |
| `fallbacks` | `Array<{ id, provider }>` | 否 | **已定义但当前未消费**——实际 fallback 靠 `order` 排序的候选链逐个尝试，不读此字段 |

## 默认行为

- **文件不存在 / 无有效条目**：`resolveVisionModelsSync()` 返回 `[]`，`analyze_image` 直接抛错（错误消息内嵌示例配置）。没有内置默认模型。
- **provider 缺失的条目**：被 `filter((m) => m.provider)` 过滤并 `console.warn`，不影响其他条目。
- **配置缓存**：60 秒 TTL（`vision-model.ts` 的 `CACHE_TTL_MS = 60 * 1000`），改完配置后最多 1 分钟生效（或重启 session）。
- **候选解析**：按 `order` 升序排序，映射为 `{ ref: "provider/id", thinkingLevel }`，逐个尝试直到成功；全部 spawn 失败才抛 `All vision models failed`。

## 配置示例

最小可用配置（单模型，取自 `index.ts` 的 `EXAMPLE_CONFIG`）：

```json
{
  "models": [
    {
      "id": "mimo-v2.5",
      "provider": "opencode-go-router",
      "order": 1,
      "thinkingLevel": "high"
    }
  ]
}
```

多模型 + fallback 链（按 `order` 自动降级，无需 `fallbacks` 字段）：

```json
{
  "models": [
    { "id": "mimo-v2.5", "provider": "opencode-go-router", "order": 1, "thinkingLevel": "high" },
    { "id": "glm-5.1", "provider": "zhipu", "order": 2 },
    { "id": "qwen-vl", "provider": "dashscope", "order": 3 }
  ]
}
```

## 备注

- **spawn 子进程**：`analyze_image` 通过 `runSingleVisionAgent`（`src/spawn.ts`）spawn 独立 pi 子进程执行 LLM 调用，主进程不直接调模型。子进程固定允许工具 `read,bash,grep`（`VISION_ALLOWED_TOOLS`），固定系统提示词约束「只输出分析结论、不写文件」（`VISION_SYSTEM_PROMPT`）。
- **context 模式**（工具参数，非配置文件）：`fresh`（默认，干净 session）/ `fork`（复制父 session 文件到临时目录 `os.tmpdir()/pi-vision/`，子进程继承上下文）。fork 失败（如无 session 文件）自动降级为 fresh 并附 `[Warning: Fork session unavailable ...]`。
- **图片不进主上下文**：图片由子进程的视觉模型读取，主 session 永远不接收图片数据，只收文本结论——避免污染主对话的 token 用量。
- **`fallbacks` 字段未启用**：schema 保留了 `fallbacks`，但当前版本 fallback 完全靠 `order` 排序的候选链，配置时无需填写 `fallbacks`。
- **实例隔离**：路径走 `getAgentDir()`，不同 `PI_CODING_AGENT_DIR` 完全隔离。
