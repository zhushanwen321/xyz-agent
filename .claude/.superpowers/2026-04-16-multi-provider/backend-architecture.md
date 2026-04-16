# 后端架构

## 新增 ProviderRegistry

管理所有 Provider 实例，核心职责：按 provider_name 查找 `Arc<dyn LlmProvider>`。

```rust
// engine/llm/registry.rs（新文件）

struct ProviderRegistry {
    providers: HashMap<String, Arc<dyn LlmProvider>>,
}

impl ProviderRegistry {
    /// 从 ProviderConfig 列表构建所有 Provider 实例
    fn from_config(configs: &[ProviderConfig], max_tokens: u32, thinking: ThinkingConfig) -> Self;

    /// 获取指定 Provider
    fn get_provider(&self, provider_name: &str) -> Option<Arc<dyn LlmProvider>>;

    /// 列出所有可用模型（flat list，带 provider 信息和 tier）
    fn list_models(&self) -> Vec<ModelInfo>;

    /// 热更新：替换指定 Provider（配置变更时调用）
    fn update_provider(&mut self, config: &ProviderConfig, max_tokens: u32, thinking: ThinkingConfig);
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

## 数据流

1. `send_message` 从 `current_model` 解析出 `provider_name` + `model_id`
2. 从 `provider_registry` 获取对应 Provider 实例
3. 调用 `provider.chat_stream(system, messages, model_id, tools)`

```rust
// commands.rs - send_message 变更示意
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
| `get_config` | 修改 | 返回多 Provider 信息 |
| `get_current_model` | 修改 | 返回 "provider/model" 格式 |

## 涉及文件

| 文件 | 变更 |
|------|------|
| `engine/llm/registry.rs` | 新增 — ProviderRegistry |
| `engine/llm/mod.rs` | 新增 ModelInfo, ModelTier, ProviderConfig 类型 |
| `engine/config/mod.rs` | 重构 — 新增 load_providers()，保留 load_agent_config() |
| `api/commands.rs` | 重构 — 新命令，移除旧命令 |
| `api/mod.rs` | 修改 — AppState 结构 |
| `engine/agent_spawner.rs` | 修改 — 从 registry 获取 provider |
| `engine/loop_/mod.rs` | 小改 — model 参数来源变更 |
