# 后端架构

## 纯数据类型位置

`ProviderConfig`、`ModelEntry`、`ModelTier`、`ModelInfo` 定义在
`engine/llm/types.rs`（新文件）。`config` 模块 import 这些类型，
不反向依赖 `llm` 模块的逻辑。

## 全局模型标识符格式规范

格式：`{provider_name}/{model_id}`

约束：
- provider_name 禁止包含 `/`
- 必须有且仅有一个 `/` 分隔符
- 格式非法时 `parse_model_ref` 返回 `AppError::Config`

```rust
fn parse_model_ref(model_ref: &str) -> Result<(&str, &str), AppError> {
    let parts: Vec<_> = model_ref.splitn(2, '/').collect();
    match parts.as_slice() {
        [provider, model] if !provider.is_empty() && !model.is_empty()
            => Ok((*provider, *model)),
        _ => Err(AppError::Config(format!(
            "invalid model_ref '{}', expected 'provider/model_id'", model_ref
        ))),
    }
}
```

## 新增 ProviderRegistry

管理所有 Provider 实例，核心职责：按 provider_name 查找 `Arc<dyn LlmProvider>`。

```rust
// engine/llm/registry.rs（新文件）

struct ProviderRegistry {
    providers: HashMap<String, Arc<dyn LlmProvider>>,
    provider_configs: HashMap<String, ProviderConfig>,  // 保留配置，用于重建
    max_tokens: u32,
    thinking: ThinkingConfig,
}

impl ProviderRegistry {
    /// 从 ProviderConfig 列表构建所有 Provider 实例
    fn from_config(configs: &[ProviderConfig], max_tokens: u32, thinking: ThinkingConfig) -> Self;

    /// 获取指定 Provider
    fn get_provider(&self, provider_name: &str) -> Option<Arc<dyn LlmProvider>>;

    /// 列出所有可用模型（flat list，带 provider 信息和 tier）
    fn list_models(&self) -> Vec<ModelInfo>;

    /// 热更新：替换指定 Provider（配置变更时调用）
    fn update_provider(&mut self, config: ProviderConfig);

    /// 删除指定 Provider
    fn remove_provider(&mut self, provider_name: &str);
}
```

## AppState 变更

替换原来的 `provider: ProviderRef` + `model: Arc<RwLock<String>>`：

```rust
pub struct AppState {
    // 新增
    pub provider_registry: Arc<RwLock<ProviderRegistry>>,
    pub current_model: Arc<RwLock<String>>,  // "provider/model_id"

    // 移除
    // pub provider: ProviderRef,
    // pub model: Arc<RwLock<String>>,

    // 其他字段不变...
}
```

## AgentSpawner 变更（Critical-1 修复）

`DefaultAgentSpawner` 不再持有固定的 provider + model，改为持有 registry 引用：

```rust
pub struct DefaultAgentSpawner {
    pub provider_registry: Arc<RwLock<ProviderRegistry>>,
    pub default_model: String,  // 默认模型 "provider/model_id"
    pub config: Arc<AgentConfig>,
    pub tool_registry: Arc<ToolRegistry>,
    pub task_tree: Arc<tokio::sync::Mutex<TaskTree>>,
    pub concurrency_manager: Arc<ConcurrencyManager>,
    pub data_dir: std::path::PathBuf,
}
```

`SpawnConfig` 增加可选 `model_ref`：

```rust
pub struct SpawnConfig {
    // ... 现有字段 ...
    /// 指定子 Agent 使用的模型，None 则使用 default_model
    pub model_ref: Option<String>,
}
```

spawn 时从 registry 获取 provider：
```rust
let model_ref = config.model_ref.as_deref().unwrap_or(&self.default_model);
let (provider_name, model_id) = parse_model_ref(model_ref)?;
let provider = self.provider_registry.read().unwrap()
    .get_provider(provider_name)
    .ok_or(AppError::Config(...))?;
```

## 运行时重建流程（Critical-2 修复）

替代旧 `rebuild_runtime`。不再需要同时重建 provider + spawner，
因为 spawner 持有 registry 引用而非固定 provider。

### Provider 配置变更时

`save_provider_config` 命令：
1. 写入 config.toml
2. `provider_registry.write().update_provider(config)` — 只更新变更的 provider
3. spawner 无需重建（它从 registry 动态获取 provider）

### 删除 Provider 时

`delete_provider` 命令：
1. 从 config.toml 移除
2. `provider_registry.write().remove_provider(name)`
3. 如果删除的是 current_model 的 provider，回退到 default_model

### 切换模型时

`set_current_model` 命令：
1. 验证 model_ref 存在（从 registry 查找）
2. 更新 `state.current_model`
3. 无需重建任何东西

## 数据流

1. `send_message` 从 `current_model` 解析出 `provider_name` + `model_id`
2. 从 `provider_registry` 获取对应 Provider 实例
3. 调用 `provider.chat_stream(system, messages, model_id, tools)`
4. `DynamicContext.model` 只使用 `model_id` 部分（不含 provider 前缀）

```rust
fn acquire_provider_for_model(state: &AppState) -> Result<(Arc<dyn LlmProvider>, String), String> {
    let model_ref = state.current_model.read().unwrap().clone();
    let (provider_name, model_id) = parse_model_ref(&model_ref)?;
    let registry = state.provider_registry.read().unwrap();
    let provider = registry.get_provider(provider_name)
        .ok_or(format!("provider '{provider_name}' not found"))?;
    Ok((provider, model_id.to_string()))
}
```

## Tauri Command 变更

| 命令 | 变更类型 | 用途 |
|------|---------|------|
| `list_models` | 新增 | 返回所有可用模型 |
| `set_current_model` | 新增 | 切换当前模型 |
| `save_provider_config` | 新增 | 保存 Provider（含 models） |
| `delete_provider` | 新增 | 删除 Provider |
| `set_agent_model_binding` | 新增 | Agent 绑定模型 |
| `apply_llm_config` | 移除 | 被新命令替代 |
| `rebuild_runtime` | 移除 | 不再需要全量重建 |
| `get_config` | 修改 | 返回多 Provider 信息 |
| `get_current_model` | 修改 | 返回 "provider/model" 格式 |

## 涉及文件

| 文件 | 变更 |
|------|------|
| `engine/llm/types.rs` | 新增 — 纯数据类型（ProviderConfig, ModelEntry, ModelTier, ModelInfo） |
| `engine/llm/registry.rs` | 新增 — ProviderRegistry |
| `engine/llm/mod.rs` | 新增 re-export，新增 parse_model_ref |
| `engine/config/mod.rs` | 重构 — 新增 load_providers()，重写 save_config，保留 load_agent_config() |
| `api/commands.rs` | 重构 — 新命令，移除 rebuild_runtime 和 apply_llm_config |
| `api/mod.rs` | 修改 — AppState 结构 |
| `engine/agent_spawner.rs` | 修改 — 持有 registry 引用，SpawnConfig 增加 model_ref |
| `engine/loop_/mod.rs` | 小改 — model 参数来源变更 |

## config/mod.rs save_config 重写（Important-3）

`save_config` 重写为支持 `[[providers]]` 嵌套结构：

```rust
pub fn save_provider_config(
    config: &ProviderConfig,
    agent_config: &AgentConfig,
) -> Result<(), AppError> {
    // 用 toml_edit 操作 [[providers]] 数组
    // 找到 name 匹配的 provider 则更新，否则追加
}

pub fn save_default_model(model_ref: &str) -> Result<(), AppError> {
    // 更新 default_model 字段
}
```

## P1 不包含

- per-provider / per-model 的 max_tokens 和 thinking 配置
- 流式对话中实时切换模型
- Token 用量按 Provider 分别统计
- 模型能力探测（自动检测支持的 feature）
- 非 Anthropic 兼容的 Provider
