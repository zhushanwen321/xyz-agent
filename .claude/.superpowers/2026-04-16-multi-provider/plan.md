# Multi-Provider 模型管理 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持配置多个 Anthropic 兼容 LLM Provider，运行时切换模型，Agent 可绑定模型。

**Architecture:** ProviderConfig → ProviderRegistry → AppState 替换单一 provider/model。Spawner 持有 registry 引用而非固定 provider。前端新增模型选择器和 Provider 管理 UI。

**Tech Stack:** Rust (toml_edit, reqwest, async-trait), TypeScript (Vue 3 Composition API, shadcn-vue)

**Spec:** `.claude/.superpowers/2026-04-16-multi-provider/spec.md`

---

## File Structure

### 新增文件
| 文件 | 职责 |
|------|------|
| `src-tauri/src/engine/llm/types.rs` | 纯数据类型：ProviderConfig, ModelEntry, ModelTier, ModelInfo, parse_model_ref |
| `src-tauri/src/engine/llm/registry.rs` | ProviderRegistry：管理多 Provider 实例 |
| `src/composables/useModelManager.ts` | 前端模型管理 composable |

### 修改文件
| 文件 | 变更 |
|------|------|
| `src-tauri/src/engine/llm/mod.rs` | 新增 mod types, mod registry, re-export |
| `src-tauri/src/engine/config/mod.rs` | 新增 load_providers(), save_provider_config(), 迁移逻辑 |
| `src-tauri/src/api/mod.rs` | AppState: provider_registry + current_model 替换 provider + model |
| `src-tauri/src/api/commands.rs` | 新命令, 移除 rebuild_runtime/apply_llm_config |
| `src-tauri/src/engine/agent_spawner.rs` | 持有 registry 引用, SpawnConfig.model_ref |
| `src-tauri/src/lib.rs` | build_app_state 适配新 AppState |
| `src/types/index.ts` | 新 ModelInfo/ProviderConfig 类型, 更新 ConfigResponse |
| `src/lib/tauri.ts` | 新 invoke 封装, 移除 applyLlmConfig |
| `src/components/ModelSelector.vue` | 新增 — 模型选择器下拉组件 |
| `src/components/Topbar.vue` | 引用 ModelSelector 组件 |
| `src/composables/useSettings.ts` | 适配新 ConfigResponse |
| `src/components/SettingsView.vue` | Provider 管理界面 |
| `src-tauri/src/engine/loop_/mod.rs` | model 参数来源从 state.model 变为 current_model 的 model_id 部分 |

---

## Task 1: LLM Types & parse_model_ref

**Files:**
- Create: `src-tauri/src/engine/llm/types.rs`
- Modify: `src-tauri/src/engine/llm/mod.rs`

- [ ] **Step 1: 创建 types.rs，定义纯数据类型**

```rust
// src-tauri/src/engine/llm/types.rs
use serde::{Deserialize, Serialize};
use crate::types::AppError;

/// 能力层级
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelTier {
    #[default]
    Balanced,
    Reasoning,
    Fast,
}

/// 模型条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEntry {
    pub id: String,
    #[serde(default)]
    pub alias: Option<String>,
    #[serde(default)]
    pub tier: ModelTier,
}

/// Provider 配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub name: String,
    pub api_key: String,
    #[serde(default = "default_base_url")]
    pub base_url: String,
    #[serde(default)]
    pub models: Vec<ModelEntry>,
}

fn default_base_url() -> String {
    "https://api.anthropic.com".to_string()
}

/// 列表查询用：Provider + Model 的扁平信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub provider_name: String,
    pub model_id: String,
    pub alias: Option<String>,
    pub tier: ModelTier,
}

impl ModelInfo {
    pub fn model_ref(&self) -> String {
        format!("{}/{}", self.provider_name, self.model_id)
    }
}

/// 解析 "provider/model_id" 格式的全局标识符
pub fn parse_model_ref(model_ref: &str) -> Result<(&str, &str), AppError> {
    let mut parts = model_ref.splitn(2, '/');
    match (parts.next(), parts.next()) {
        (Some(p), Some(m)) if !p.is_empty() && !m.is_empty() => Ok((p, m)),
        _ => Err(AppError::Config(format!(
            "invalid model_ref '{}', expected 'provider/model_id'", model_ref
        ))),
    }
}
```

- [ ] **Step 2: 更新 mod.rs，添加模块声明和 re-export**

在 `src-tauri/src/engine/llm/mod.rs` 顶部添加：
```rust
pub mod types;
pub mod registry;
```

并在文件末尾（tests 模块之前）添加 re-export：
```rust
pub use types::{ModelTier, ModelEntry, ProviderConfig, ModelInfo, parse_model_ref};
```

- [ ] **Step 3: 写单元测试**

在 `types.rs` 底部添加 `#[cfg(test)] mod tests`：
- `test_parse_model_ref_valid` — "provider/model" → Ok
- `test_parse_model_ref_no_slash` — "noprovider" → Err
- `test_parse_model_ref_empty_parts` — "/model" 和 "provider/" → Err
- `test_model_tier_default` — Default is Balanced
- `test_model_info_ref` — model_ref() 格式正确
- `test_provider_config_serde_roundtrip` — 序列化/反序列化一致

- [ ] **Step 4: 运行测试确认通过**

Run: `cd src-tauri && cargo test --lib engine::llm::types`
Expected: 全部通过

- [ ] **Step 5: 创建 registry.rs 骨架（空 struct，让 mod.rs 编译通过）**

```rust
// src-tauri/src/engine/llm/registry.rs
// Task 3 中填充实现
```

- [ ] **Step 6: 运行 cargo check 确认编译通过**

Run: `cd src-tauri && cargo check`
Expected: 编译成功

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/engine/llm/types.rs src-tauri/src/engine/llm/registry.rs src-tauri/src/engine/llm/mod.rs
git commit -m "feat: add multi-provider types and parse_model_ref"
```

---

## Task 2: Config 模块重构

**Files:**
- Modify: `src-tauri/src/engine/config/mod.rs`

依赖：Task 1 完成

- [ ] **Step 1: 写 load_providers 测试**

在 `config/mod.rs` 的 `tests` 模块中添加：

```rust
#[test]
fn test_load_providers_parses_providers_array() {
    let content = r#"
default_model = "default/claude-sonnet-4"

[[providers]]
name = "default"
api_key = "sk-test"
base_url = "https://api.anthropic.com"

[[providers.models]]
id = "claude-sonnet-4-20250514"
tier = "balanced"

[[providers.models]]
id = "claude-opus-4-20250514"
alias = "Opus 4"
tier = "reasoning"
"#;
    let result = parse_providers_toml(content);
    assert_eq!(result.providers.len(), 1);
    let p = &result.providers[0];
    assert_eq!(p.name, "default");
    assert_eq!(p.models.len(), 2);
    assert_eq!(p.models[1].alias, Some("Opus 4".into()));
    assert_eq!(result.default_model, Some("default/claude-sonnet-4".into()));
}

#[test]
fn test_load_providers_empty_is_ok() {
    let result = parse_providers_toml("");
    assert!(result.providers.is_empty());
    assert!(result.default_model.is_none());
}

#[test]
fn test_migration_from_old_format() {
    let content = r#"
anthropic_api_key = "sk-ant-old"
llm_model = "claude-sonnet-4"
anthropic_base_url = "https://custom.api.com"
"#;
    let result = migrate_if_needed(content);
    assert_eq!(result.providers.len(), 1);
    assert_eq!(result.providers[0].name, "default");
    assert_eq!(result.providers[0].api_key, "sk-ant-old");
    assert_eq!(result.default_model, Some("default/claude-sonnet-4".into()));
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd src-tauri && cargo test --lib engine::config`
Expected: 编译失败（函数不存在）

- [ ] **Step 3: 实现 ProvidersConfig 和解析函数**

在 `config/mod.rs` 中添加：

```rust
use crate::engine::llm::types::{ProviderConfig, ModelEntry, ModelTier};

pub struct ProvidersConfig {
    pub providers: Vec<ProviderConfig>,
    pub default_model: Option<String>,
}

/// 从 toml 内容解析 providers 配置
fn parse_providers_toml(content: &str) -> ProvidersConfig { ... }

/// 检测旧格式并迁移为新的 providers 格式
fn migrate_if_needed(content: &str) -> ProvidersConfig { ... }

/// 加载 providers 配置：优先 [[providers]]，fallback 到旧格式，再 fallback 到环境变量
pub fn load_providers() -> ProvidersConfig { ... }
```

关键实现逻辑：
- `parse_providers_toml`: 用 `toml_edit` 解析 `[[providers]]` 数组和嵌套的 `[[providers.models]]`。
  关键 API：`doc.get("providers").and_then(|v| v.as_array_of_tables())` 遍历 provider，
  每个 provider table 中 `table.get("models").and_then(|v| v.as_array_of_tables())` 遍历模型
- `migrate_if_needed`: 检测旧字段 `anthropic_api_key` 存在且无 `[[providers]]` 时自动创建 default provider
- `load_providers`: 先尝试 `parse_providers_toml`，如果 providers 为空则 `migrate_if_needed`，再为空则尝试环境变量

- [ ] **Step 4: 实现 save_provider_config**

```rust
/// 保存单个 Provider 配置到 config.toml（更新或追加）
pub fn save_provider_config(config: &ProviderConfig, agent_config: &AgentConfig) -> Result<(), AppError> { ... }

/// 删除指定 Provider
pub fn delete_provider(provider_name: &str) -> Result<(), AppError> { ... }

/// 更新默认模型
pub fn save_default_model(model_ref: &str) -> Result<(), AppError> { ... }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd src-tauri && cargo test --lib engine::config`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/engine/config/mod.rs
git commit -m "feat: add multi-provider config parsing, save, and migration"
```

---

## Task 3: ProviderRegistry

**Files:**
- Modify: `src-tauri/src/engine/llm/registry.rs`

依赖：Task 1, 2 完成

- [ ] **Step 1: 写 ProviderRegistry 测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_from_config() {
        let configs = vec![ProviderConfig {
            name: "test".into(),
            api_key: "sk-test".into(),
            base_url: "https://api.anthropic.com".into(),
            models: vec![ModelEntry { id: "claude-sonnet-4".into(), alias: None, tier: ModelTier::Balanced }],
        }];
        let registry = ProviderRegistry::from_config(&configs, 4096, false, 10000);
        assert!(registry.get_provider("test").is_some());
        assert!(registry.get_provider("nonexist").is_none());
    }

    #[test]
    fn test_list_models_flattens() { ... }

    #[test]
    fn test_update_provider_replaces() { ... }

    #[test]
    fn test_remove_provider() { ... }
}
```

- [ ] **Step 2: 实现 ProviderRegistry**

```rust
use std::collections::HashMap;
use std::sync::Arc;
use crate::engine::llm::anthropic::AnthropicProvider;
use crate::engine::llm::types::*;
use crate::engine::llm::LlmProvider;

pub struct ProviderRegistry {
    providers: HashMap<String, Arc<dyn LlmProvider>>,
    provider_configs: HashMap<String, ProviderConfig>,
    max_tokens: u32,
    thinking_enabled: bool,
    thinking_budget_tokens: u32,
}

impl ProviderRegistry {
    pub fn from_config(
        configs: &[ProviderConfig],
        max_tokens: u32,
        thinking_enabled: bool,
        thinking_budget_tokens: u32,
    ) -> Self { ... }

    pub fn get_provider(&self, name: &str) -> Option<Arc<dyn LlmProvider>> { ... }

    pub fn list_models(&self) -> Vec<ModelInfo> { ... }

    pub fn update_provider(&mut self, config: ProviderConfig) { ... }

    pub fn remove_provider(&mut self, name: &str) { ... }

    pub fn is_empty(&self) -> bool { ... }

    /// 获取默认模型（第一个 provider 的第一个 model）
    pub fn default_model_ref(&self) -> Option<String> { ... }
}
```

- [ ] **Step 3: 运行测试确认通过**

Run: `cd src-tauri && cargo test --lib engine::llm::registry`
Expected: 全部通过

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/engine/llm/registry.rs
git commit -m "feat: implement ProviderRegistry with hot-update support"
```

---

## Task 4: AppState & lib.rs 适配

**Files:**
- Modify: `src-tauri/src/api/mod.rs`
- Modify: `src-tauri/src/lib.rs`

依赖：Task 2, 3 完成

- [ ] **Step 1: 修改 AppState**

在 `api/mod.rs` 中：
- 移除 `ProviderRef`, `SpawnerRef` type alias
- 替换 `provider: ProviderRef` → `provider_registry: Arc<RwLock<ProviderRegistry>>`
- 替换 `model: Arc<RwLock<String>>` → `current_model: Arc<RwLock<String>>`
- `agent_spawner` 类型改为 `Arc<RwLock<Option<Arc<dyn AgentSpawner>>>>`（保持不变）

添加 import：
```rust
use crate::engine::llm::registry::ProviderRegistry;
```

- [ ] **Step 2: 修改 build_app_state 和 run()**

在 `lib.rs` 中：
- `run()`: 用 `load_providers()` 替换 `load_llm_config()`，构建 `ProviderRegistry`
- `build_app_state`: 接收 `Arc<RwLock<ProviderRegistry>>` 和 `current_model` 字符串
- DefaultAgentSpawner 持有 registry 引用

- [ ] **Step 3: 运行 cargo check**

Run: `cd src-tauri && cargo check`
Expected: api/mod.rs 和 lib.rs 编译通过，但 commands.rs 会有约 10+ 处编译错误
（state.provider / state.model / acquire_provider / rebuild_runtime 引用报错）。
**这是预期行为，Task 5 会统一修复 commands.rs。**

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/api/mod.rs src-tauri/src/lib.rs
git commit -m "refactor: AppState uses ProviderRegistry instead of single provider"
```

---

## Task 5: API Commands 重构

**Files:**
- Modify: `src-tauri/src/api/commands.rs`
- Modify: `src-tauri/src/lib.rs`（命令注册）

依赖：Task 4 完成。本 Task 修复 Task 4 遗留的 commands.rs 编译错误。

- [ ] **Step 1: 替换 ConfigResponse 类型**

```rust
#[derive(serde::Serialize)]
pub struct ConfigResponse {
    pub providers: Vec<ProviderConfig>,
    pub default_model: String,
    pub current_model: String,
    // AgentConfig 字段
    pub max_turns: u32,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub tool_output_max_bytes: usize,
    pub bash_default_timeout_secs: u64,
    pub thinking_enabled: bool,
    pub thinking_budget_tokens: u32,
}
```

- [ ] **Step 2: 添加新命令**

```rust
#[tauri::command]
pub async fn list_models(state: State<'_, AppState>) -> Result<Vec<ModelInfo>, String> { ... }

#[derive(Deserialize)]
pub struct SetCurrentModelRequest { pub model_ref: String }

#[tauri::command]
pub async fn set_current_model(
    payload: SetCurrentModelRequest, state: State<'_, AppState>,
) -> Result<(), String> { ... }

#[tauri::command]
pub async fn save_provider(
    payload: ProviderConfig, state: State<'_, AppState>,
) -> Result<(), String> { ... }

#[tauri::command]
pub async fn delete_provider(
    name: String, state: State<'_, AppState>,
) -> Result<(), String> { ... }
```

- [ ] **Step 3: 重构现有命令**

- `send_message`: 用 `acquire_provider_for_model()` 替换 `acquire_provider()`。
  **注意：`build_tool_context` 中引用 spawner 的部分在 Task 6 中调整，此处暂用 `unwrap_or_default` 占位**
- `get_config`: 从 registry 和 AgentConfig 组装新 ConfigResponse
- `get_current_model`: 返回 `state.current_model`
- `check_api_key`: 改为 `!state.provider_registry.read().unwrap().is_empty()`
- `update_config`: 保留 AgentConfig 部分更新，移除 LLM 部分。新 `UpdateConfigRequest`：
```rust
#[derive(Deserialize)]
pub struct UpdateConfigRequest {
    pub max_turns: u32,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub tool_output_max_bytes: usize,
    pub bash_default_timeout_secs: u64,
    pub thinking_enabled: bool,
    pub thinking_budget_tokens: u32,
}
```
- 移除 `apply_llm_config`, `rebuild_runtime`, `ApplyLlmConfigRequest`

- [ ] **Step 4: 注册新命令**

在 `lib.rs` 的 `invoke_handler` 中：
- 添加: `list_models`, `set_current_model`, `save_provider`, `delete_provider`
- 移除: `apply_llm_config`

- [ ] **Step 5: 运行 cargo check + cargo test**

Run: `cd src-tauri && cargo check && cargo test`
Expected: 编译成功，所有测试通过

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/api/commands.rs src-tauri/src/lib.rs
git commit -m "feat: add multi-provider API commands, remove single-provider commands"
```

---

## Task 6: AgentSpawner 适配

**Files:**
- Modify: `src-tauri/src/engine/agent_spawner.rs`

依赖：Task 5 完成（commands.rs 编译通过后才能安全修改 spawner）

```rust
pub struct DefaultAgentSpawner {
    pub provider_registry: Arc<RwLock<ProviderRegistry>>,
    pub default_model: String,
    pub config: Arc<AgentConfig>,
    // 其他字段不变...
}
```

- [ ] **Step 2: 修改 SpawnConfig**

添加字段：
```rust
pub model_ref: Option<String>,
```

- [ ] **Step 3: 修改 spawn_agent 实现**

从 registry 动态获取 provider：
```rust
let model_ref = config.model_ref.as_deref().unwrap_or(&self.default_model);
let (provider_name, model_id) = parse_model_ref(model_ref)
    .map_err(|e| AppError::Config(e.to_string()))?;
let provider = self.provider_registry.read().unwrap()
    .get_provider(provider_name)
    .ok_or_else(|| AppError::Config(format!("provider '{}' not found", provider_name)))?;
let agent_loop = AgentLoop::new(provider, config.session_id.clone(), model_id.to_string());
```

递归创建子 spawner 时传入 registry 引用而非固定 provider。

- [ ] **Step 4: 更新测试**

修改 `default_agent_spawner_runs_subagent` 等测试：
- 构建 `ProviderRegistry` 而非直接创建 `MockLlmProvider`
- 或创建 `ProviderRegistry::from_mock("test", mock_provider)` 辅助方法

在 registry.rs 中添加测试辅助方法：
```rust
#[cfg(test)]
impl ProviderRegistry {
    pub fn from_single(name: &str, provider: Arc<dyn LlmProvider>, model: ModelEntry) -> Self { ... }
}
```

- [ ] **Step 5: 运行 cargo test**

Run: `cd src-tauri && cargo test`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/engine/agent_spawner.rs src-tauri/src/engine/llm/registry.rs
git commit -m "refactor: AgentSpawner uses ProviderRegistry for multi-provider support"
```

---

## Task 7: 前端类型 & tauri.ts 适配

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/lib/tauri.ts`

依赖：Task 5 完成（后端 API 可编译）

- [ ] **Step 1: 更新 TypeScript 类型**

在 `src/types/index.ts` 中：

添加新类型：
```typescript
export type ModelTier = 'balanced' | 'reasoning' | 'fast'

export interface ModelEntry {
  id: string
  alias: string | null
  tier: ModelTier
}

export interface ProviderConfig {
  name: string
  api_key: string
  base_url: string
  models: ModelEntry[]
}

export interface ModelInfo {
  provider_name: string
  model_id: string
  alias: string | null
  tier: ModelTier
}
```

替换 ConfigResponse：
```typescript
export interface ConfigResponse {
  providers: ProviderConfig[]
  default_model: string
  current_model: string
  max_turns: number
  context_window: number
  max_output_tokens: number
  tool_output_max_bytes: number
  bash_default_timeout_secs: number
  thinking_enabled: boolean
  thinking_budget_tokens: number
}
```

移除 `UpdateConfigRequest = ConfigResponse`。

- [ ] **Step 2: 更新 tauri.ts**

添加新函数：
```typescript
export async function listModels(): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>('list_models')
}

export async function setCurrentModel(modelRef: string): Promise<void> {
  return invoke<void>('set_current_model', { payload: { modelRef } })
}

export async function saveProvider(config: ProviderConfig): Promise<void> {
  return invoke<void>('save_provider', { payload: config })
}

export async function deleteProvider(name: string): Promise<void> {
  return invoke<void>('delete_provider', { name })
}
```

移除 `applyLlmConfig` 和 `ApplyLlmConfigPayload`。

- [ ] **Step 3: 运行 npm run build 确认编译**

Run: `npm run build`
Expected: 编译通过（可能有 useSettings/SettingsView 的 break，Task 8/10 修复）

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/lib/tauri.ts
git commit -m "feat: add multi-provider TypeScript types and tauri API"
```

---

## Task 8: useModelManager composable

**Files:**
- Create: `src/composables/useModelManager.ts`

依赖：Task 7 完成

- [ ] **Step 1: 实现 useModelManager**

```typescript
import { ref } from 'vue'
import { listModels, setCurrentModel as apiSetCurrentModel, saveProvider as apiSaveProvider, deleteProvider as apiDeleteProvider } from '../lib/tauri'
import type { ModelInfo, ProviderConfig } from '../types'

export function useModelManager() {
  const models = ref<ModelInfo[]>([])
  const currentModel = ref('')
  const loading = ref(false)

  async function load() {
    loading.value = true
    try {
      models.value = await listModels()
    } finally {
      loading.value = false
    }
  }

  async function setCurrentModel(modelRef: string) {
    await apiSetCurrentModel(modelRef)
    currentModel.value = modelRef
  }

  async function saveProvider(config: ProviderConfig) {
    await apiSaveProvider(config)
    await load()  // 刷新列表
  }

  async function deleteProviderConfig(name: string) {
    await apiDeleteProvider(name)
    await load()
  }

  return { models, currentModel, loading, load, setCurrentModel, saveProvider, deleteProviderConfig }
}
```

- [ ] **Step 2: 运行 npm run build 确认编译**

Run: `npm run build`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add src/composables/useModelManager.ts
git commit -m "feat: add useModelManager composable"
```

---

## Task 9: 前端模型选择器

**Files:**
- Create: `src/components/ModelSelector.vue`
- Modify: `src/components/Topbar.vue`

依赖：Task 8 完成

- [ ] **Step 1: 创建 ModelSelector.vue 组件**

独立组件，负责模型选择器 UI：
- Props: `currentModel: string`
- Emits: `select(modelRef: string)`
- 内部使用 `useModelManager().models` 获取模型列表
- computed `groupedByProvider` 将 models 按 provider_name 分组
- 点击外部区域关闭下拉（onMounted 添加 document click listener，onUnmounted 移除）

- [ ] **Step 2: 在 Topbar.vue 中替换现有 modelName span**

移除现有的 `getCurrentModel()` 调用和 `modelName` ref，
替换为 `<ModelSelector :current-model="..." @select="onModelChange" />`

- [ ] **Step 3: 运行 npm run build 确认编译**

Run: `npm run build`
Expected: 通过

- [ ] **Step 4: 启动 tauri dev 验证 UI**

Run: `npm run tauri dev`
验证：选择器显示、切换模型、发送消息使用新模型

- [ ] **Step 5: Commit**

```bash
git add src/components/ModelSelector.vue src/components/Topbar.vue
git commit -m "feat: add ModelSelector component in Topbar"
```

---

## Task 10: Settings Provider 管理

**Files:**
- Modify: `src/composables/useSettings.ts`
- Modify: `src/components/SettingsView.vue`

依赖：Task 8 完成

- [ ] **Step 1: 重构 useSettings.ts**

- `load()` 解析新 ConfigResponse（providers 数组、default_model、current_model）
- `save()` 拆分为：AgentConfig 用 `updateConfig()`，LLM 配置用 `saveProvider()`
- 添加 `saveProviderConfig()` 和 `deleteProviderConfig()` 方法

- [ ] **Step 2: SettingsView LLM Tab — Provider 列表展示**

卡片式展示已配置的 Provider（name + 脱敏 api_key + base_url），
支持添加/编辑/删除操作。

- [ ] **Step 3: SettingsView LLM Tab — Provider 编辑/添加表单**

name, api_key, base_url 输入框。保存时校验 name 唯一性。

- [ ] **Step 4: SettingsView LLM Tab — 模型管理**

每个 Provider 下的模型列表，支持添加/删除 model（id + alias + tier 选择）。

- [ ] **Step 5: SettingsView LLM Tab — 默认模型选择**

全局默认模型下拉选择器，调用 `set_current_model`。

- [ ] **Step 6: Agent Tab 保留 Thinking Mode section**

Thinking Mode 配置保留在 Agent Tab 或独立 section 中（通过 updateConfig 保存）。

- [ ] **Step 7: 运行 npm run build 确认编译**

Run: `npm run build`
Expected: 通过

- [ ] **Step 8: 启动 tauri dev 验证 Settings**

Run: `npm run tauri dev`
验证：添加 Provider、编辑模型列表、设置默认模型

- [ ] **Step 9: Commit**

```bash
git add src/composables/useSettings.ts src/components/SettingsView.vue
git commit -m "feat: multi-provider management in Settings UI"
```

---

## P2 延后项

以下功能在 P1 中不实现，记录于此避免遗忘：

- `set_agent_model_binding` 命令 — Agent 模板绑定到特定模型/tier（需修改 AgentTemplateRegistry + 前端 Agent 编辑卡片）
- per-provider / per-model 的 max_tokens 和 thinking 配置
- 流式对话中实时切换模型

---

## Task 11: 端到端集成测试

**Files:**
- 无新文件

依赖：Task 1-10 全部完成

- [ ] **Step 1: 运行全量 Rust 测试**

Run: `cd src-tauri && cargo test`
Expected: 全部通过（~183 个测试）

- [ ] **Step 2: 运行前端构建**

Run: `npm run build`
Expected: 通过

- [ ] **Step 3: 手动集成验证**

启动 `npm run tauri dev`，依次验证：
1. 首次启动（无 config.toml）— 显示配置引导
2. 旧 config.toml 自动迁移 — 正常加载
3. 添加新 Provider — 保存成功
4. 切换模型 — 发送消息使用新模型
5. 删除 Provider — 回退到默认模型
6. 子 Agent 使用正确的 provider

- [ ] **Step 4: 最终 Commit**

```bash
git add -A
git commit -m "test: e2e validation for multi-provider system"
```
