# 前端 UI

## 模型选择器

位于聊天框顶部（Topbar 或 ChatView 区域）：

- **默认态**：显示当前模型名称 + tier 标签
- **展开态**：下拉列表按 Provider 分组，每组下列出可用模型
- **选择后**：调用 `set_current_model` 立即生效（下一条消息使用新模型）

### 模型显示格式

```
Provider 名称
  ├─ Sonnet 4          [均衡]
  └─ Opus 4            [推理]
另一个 Provider
  └─ claude-sonnet-4   [均衡]
```

## Settings 页面扩展

### LLM 标签页重构

现有 LLM 配置扩展为 Provider 管理界面：

1. **Provider 列表**：显示已配置的 Provider，支持添加/编辑/删除
2. **Provider 编辑卡片**：name, api_key（脱敏显示）, base_url
3. **模型列表**：Provider 下的模型，每行显示 id + alias + tier
4. **全局默认模型**：下拉选择默认模型

### Agent 模板绑定

在 Agent 模板卡片中增加"默认模型"字段：
- 可选具体模型（"anthropic-official/claude-sonnet-4"）
- 可选 tier（"reasoning"）— 运行时取该 tier 下第一个可用模型
- 可选"跟随全局"（默认行为）

## ConfigResponse 类型变更

旧 `ConfigResponse`（扁平字段）替换为新结构：

```typescript
interface ConfigResponse {
  // 移除旧字段：anthropic_api_key, llm_model, anthropic_base_url
  providers: ProviderConfig[]
  defaultModel: string
  currentModel: string
  // AgentConfig 字段保留
  maxTurns: number
  contextWindow: number
  maxOutputTokens: number
  toolOutputMaxBytes: number
  bashDefaultTimeoutSecs: number
  thinkingEnabled: boolean
  thinkingBudgetTokens: number
}
```

## Tauri 通信

### 新增 composable: useModelManager

```typescript
// composables/useModelManager.ts
export function useModelManager() {
  const models = ref<ModelInfo[]>([])
  const currentModel = ref<string>('')

  async function load()
  async function setCurrentModel(modelRef: string)
  async function saveProvider(config: ProviderConfig)
  async function deleteProvider(name: string)

  return { models, currentModel, load, setCurrentModel, saveProvider, deleteProvider }
}
```

### TypeScript 类型

```typescript
interface ModelInfo {
  providerName: string
  modelId: string
  alias: string | null
  tier: 'balanced' | 'reasoning' | 'fast'
  modelRef: string  // "provider/modelId"
}

interface ProviderConfig {
  name: string
  apiKey: string
  baseUrl: string
  models: ModelEntry[]
}
```
