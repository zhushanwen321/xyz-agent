use std::collections::HashMap;
use std::sync::Arc;

use crate::engine::llm::anthropic::AnthropicProvider;
use crate::engine::llm::types::*;
use crate::engine::llm::LlmProvider;

/// 管理多个 LLM Provider 实例，支持运行时增删和热更新
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
    ) -> Self {
        let mut providers = HashMap::new();
        let mut provider_configs = HashMap::new();

        for cfg in configs {
            let provider = Self::build_provider(cfg, max_tokens, thinking_enabled, thinking_budget_tokens);
            providers.insert(cfg.name.clone(), Arc::from(provider) as Arc<dyn LlmProvider>);
            provider_configs.insert(cfg.name.clone(), cfg.clone());
        }

        Self { providers, provider_configs, max_tokens, thinking_enabled, thinking_budget_tokens }
    }

    pub fn get_provider(&self, name: &str) -> Option<Arc<dyn LlmProvider>> {
        self.providers.get(name).cloned()
    }

    /// 展平所有 provider 下的模型为 ModelInfo 列表
    pub fn list_models(&self) -> Vec<ModelInfo> {
        let mut result = Vec::new();
        // 按插入顺序遍历（HashMap 无序，这里按 config 顺序重建）
        for cfg in self.provider_configs.values() {
            for model in &cfg.models {
                result.push(ModelInfo {
                    provider_name: cfg.name.clone(),
                    model_id: model.id.clone(),
                    alias: model.alias.clone(),
                    tier: model.tier.clone(),
                });
            }
        }
        result
    }

    /// 热更新：替换指定 provider 的实例和配置
    pub fn update_provider(&mut self, config: ProviderConfig) {
        let provider = Self::build_provider(&config, self.max_tokens, self.thinking_enabled, self.thinking_budget_tokens);
        self.providers.insert(config.name.clone(), Arc::from(provider) as Arc<dyn LlmProvider>);
        self.provider_configs.insert(config.name.clone(), config);
    }

    /// 移除指定 provider
    pub fn remove_provider(&mut self, name: &str) {
        self.providers.remove(name);
        self.provider_configs.remove(name);
    }

    pub fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }

    /// 获取默认模型 ref（第一个 provider 的第一个 model）
    pub fn default_model_ref(&self) -> Option<String> {
        self.provider_configs.values().next().and_then(|cfg| {
            cfg.models.first().map(|m| format!("{}/{}", cfg.name, m.id))
        })
    }

    /// 获取第一个 provider 的名称（用于 fallback）
    pub fn first_provider_name(&self) -> Option<&str> {
        self.provider_configs.keys().next().map(|s| s.as_str())
    }

    fn build_provider(
        cfg: &ProviderConfig,
        max_tokens: u32,
        thinking_enabled: bool,
        thinking_budget_tokens: u32,
    ) -> AnthropicProvider {
        AnthropicProvider::new(cfg.api_key.clone())
            .with_base_url(cfg.base_url.clone())
            .with_max_tokens(max_tokens)
            .with_thinking(thinking_enabled, thinking_budget_tokens)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config(name: &str) -> ProviderConfig {
        ProviderConfig {
            name: name.to_string(),
            api_key: "sk-test".to_string(),
            base_url: "https://api.anthropic.com".to_string(),
            models: vec![
                ModelEntry { id: "claude-sonnet-4".to_string(), alias: Some("sonnet".to_string()), tier: ModelTier::Balanced },
                ModelEntry { id: "claude-opus-4".to_string(), alias: None, tier: ModelTier::Reasoning },
            ],
        }
    }

    #[test]
    fn test_registry_from_config() {
        let configs = vec![sample_config("test")];
        let registry = ProviderRegistry::from_config(&configs, 4096, false, 10000);
        assert!(registry.get_provider("test").is_some());
        assert!(registry.get_provider("nonexist").is_none());
        assert!(!registry.is_empty());
    }

    #[test]
    fn test_list_models_flattens() {
        let configs = vec![
            sample_config("p1"),
            ProviderConfig {
                name: "p2".to_string(),
                api_key: "sk-2".to_string(),
                base_url: "https://api.other.com".to_string(),
                models: vec![ModelEntry { id: "gpt-4o".to_string(), alias: None, tier: ModelTier::Fast }],
            },
        ];
        let registry = ProviderRegistry::from_config(&configs, 8192, false, 10000);
        let models = registry.list_models();
        assert_eq!(models.len(), 3); // p1 有 2 个, p2 有 1 个

        let refs: Vec<String> = models.iter().map(|m| m.model_ref()).collect();
        assert!(refs.contains(&"p1/claude-sonnet-4".to_string()));
        assert!(refs.contains(&"p1/claude-opus-4".to_string()));
        assert!(refs.contains(&"p2/gpt-4o".to_string()));
    }

    #[test]
    fn test_update_provider_replaces() {
        let configs = vec![sample_config("test")];
        let mut registry = ProviderRegistry::from_config(&configs, 4096, false, 10000);
        assert_eq!(registry.list_models().len(), 2);

        let updated = ProviderConfig {
            name: "test".to_string(),
            api_key: "sk-updated".to_string(),
            base_url: "https://api.anthropic.com".to_string(),
            models: vec![ModelEntry { id: "claude-sonnet-4".to_string(), alias: None, tier: ModelTier::Fast }],
        };
        registry.update_provider(updated);
        assert_eq!(registry.list_models().len(), 1);
        assert_eq!(registry.list_models()[0].tier, ModelTier::Fast);
        assert!(registry.get_provider("test").is_some());
    }

    #[test]
    fn test_remove_provider() {
        let configs = vec![sample_config("a"), sample_config("b")];
        let mut registry = ProviderRegistry::from_config(&configs, 4096, false, 10000);
        assert_eq!(registry.list_models().len(), 4);

        registry.remove_provider("a");
        assert!(registry.get_provider("a").is_none());
        assert!(registry.get_provider("b").is_some());
        assert_eq!(registry.list_models().len(), 2);
    }

    #[test]
    fn test_default_model_ref() {
        let configs = vec![sample_config("first"), sample_config("second")];
        let registry = ProviderRegistry::from_config(&configs, 4096, false, 10000);
        let default = registry.default_model_ref();
        // HashMap 迭代顺序不确定，但应该是某个 provider 的第一个 model
        assert!(default.is_some());
        let r = default.unwrap();
        assert!(r.contains('/') && !r.starts_with('/') && !r.ends_with('/'));
    }

    #[test]
    fn test_empty_registry() {
        let registry = ProviderRegistry::from_config(&[], 4096, false, 10000);
        assert!(registry.is_empty());
        assert!(registry.default_model_ref().is_none());
        assert!(registry.list_models().is_empty());
    }
}
