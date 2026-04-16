use serde::{Deserialize, Serialize};
use crate::types::AppError;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelTier {
    #[default]
    Balanced,
    Reasoning,
    Fast,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEntry {
    pub id: String,
    #[serde(default)]
    pub alias: Option<String>,
    #[serde(default)]
    pub tier: ModelTier,
}

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

pub fn parse_model_ref(model_ref: &str) -> Result<(&str, &str), AppError> {
    let mut parts = model_ref.splitn(2, '/');
    match (parts.next(), parts.next()) {
        (Some(p), Some(m)) if !p.is_empty() && !m.is_empty() => Ok((p, m)),
        _ => Err(AppError::Config(format!(
            "invalid model_ref '{}', expected 'provider/model_id'", model_ref
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_model_ref_valid() {
        assert_eq!(parse_model_ref("provider/model"), Ok(("provider", "model")));
    }

    #[test]
    fn test_parse_model_ref_no_slash() {
        let err = parse_model_ref("noprovider").unwrap_err();
        assert!(err.to_string().contains("invalid model_ref"));
    }

    #[test]
    fn test_parse_model_ref_empty_provider() {
        let err = parse_model_ref("/model").unwrap_err();
        assert!(err.to_string().contains("invalid model_ref"));
    }

    #[test]
    fn test_parse_model_ref_empty_model() {
        let err = parse_model_ref("provider/").unwrap_err();
        assert!(err.to_string().contains("invalid model_ref"));
    }

    #[test]
    fn test_model_tier_default() {
        assert_eq!(ModelTier::default(), ModelTier::Balanced);
    }

    #[test]
    fn test_model_info_ref() {
        let info = ModelInfo {
            provider_name: "provider".to_string(),
            model_id: "model_id".to_string(),
            alias: None,
            tier: ModelTier::Balanced,
        };
        assert_eq!(info.model_ref(), "provider/model_id");
    }

    #[test]
    fn test_provider_config_serde_roundtrip() {
        let config = ProviderConfig {
            name: "anthropic".to_string(),
            api_key: "sk-test".to_string(),
            base_url: "https://api.anthropic.com".to_string(),
            models: vec![ModelEntry {
                id: "claude-sonnet-4".to_string(),
                alias: Some("sonnet".to_string()),
                tier: ModelTier::Balanced,
            }],
        };
        let json = serde_json::to_string(&config).unwrap();
        let de: ProviderConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(de.name, config.name);
        assert_eq!(de.api_key, config.api_key);
        assert_eq!(de.base_url, config.base_url);
        assert_eq!(de.models.len(), 1);
        assert_eq!(de.models[0].id, config.models[0].id);
        assert_eq!(de.models[0].alias, config.models[0].alias);
        assert_eq!(de.models[0].tier, config.models[0].tier);
    }
}
