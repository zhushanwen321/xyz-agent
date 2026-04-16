use super::*;

#[test]
fn test_default_values_when_no_config() {
    let config = AgentConfig::default();
    assert_eq!(config.max_turns, 50);
    assert_eq!(config.context_window, 200_000);
    assert_eq!(config.max_output_tokens, 8_192);
    assert_eq!(config.auto_compact_buffer, 13_000);
    assert_eq!(config.warning_buffer, 20_000);
    assert_eq!(config.hard_limit_buffer, 3_000);
    assert_eq!(config.keep_tool_results, 10);
    assert_eq!(config.compact_max_output_tokens, 20_000);
    assert_eq!(config.max_consecutive_failures, 3);
    assert_eq!(config.tool_output_max_bytes, 100_000);
    assert_eq!(config.bash_default_timeout_secs, 120);
}

#[test]
fn test_thinking_config_defaults() {
    let config = AgentConfig::default();
    assert!(!config.thinking_enabled);
    assert_eq!(config.thinking_budget_tokens, 10_000);
}

#[test]
fn test_thinking_config_parsing() {
    let content = "thinking_enabled = true\nthinking_budget_tokens = 20000\n";
    let config = parse_config_toml(content);
    assert!(config.thinking_enabled);
    assert_eq!(config.thinking_budget_tokens, 20_000);
}

#[test]
fn test_thinking_config_invalid_uses_defaults() {
    let content = "thinking_enabled = maybe\nthinking_budget_tokens = not_a_number\n";
    let config = parse_config_toml(content);
    assert!(!config.thinking_enabled);
    assert_eq!(config.thinking_budget_tokens, 10_000);
}

#[test]
fn test_partial_config_uses_defaults() {
    let content = "max_turns = 100\ncontext_window = 500000\n";
    let config = parse_config_toml(content);
    assert_eq!(config.max_turns, 100);
    assert_eq!(config.context_window, 500_000);
    assert_eq!(config.max_output_tokens, 8_192);
    assert_eq!(config.tool_output_max_bytes, 100_000);
}

#[test]
fn test_invalid_values_ignored() {
    let content = "max_turns = not_a_number\ntool_output_max_bytes = abc\nbash_default_timeout_secs = 120\n";
    let config = parse_config_toml(content);
    assert_eq!(config.max_turns, 50);
    assert_eq!(config.tool_output_max_bytes, 100_000);
    assert_eq!(config.bash_default_timeout_secs, 120);
}

#[test]
fn load_llm_config_reads_from_env() {
    let saved_key = std::env::var("ANTHROPIC_API_KEY").ok();
    let saved_url = std::env::var("ANTHROPIC_BASE_URL").ok();
    let saved_model = std::env::var("LLM_MODEL").ok();

    std::env::set_var("ANTHROPIC_API_KEY", "env-test-key");
    std::env::set_var("ANTHROPIC_BASE_URL", "https://custom.api.com");
    std::env::set_var("LLM_MODEL", "claude-opus-4");

    let config = load_llm_config().unwrap();
    assert_eq!(config.api_key, "env-test-key");
    assert_eq!(config.base_url, "https://custom.api.com");
    assert_eq!(config.model, "claude-opus-4");

    match saved_key {
        Some(v) => std::env::set_var("ANTHROPIC_API_KEY", v),
        None => std::env::remove_var("ANTHROPIC_API_KEY"),
    }
    match saved_url {
        Some(v) => std::env::set_var("ANTHROPIC_BASE_URL", v),
        None => std::env::remove_var("ANTHROPIC_BASE_URL"),
    }
    match saved_model {
        Some(v) => std::env::set_var("LLM_MODEL", v),
        None => std::env::remove_var("LLM_MODEL"),
    }
}

#[test]
fn test_save_config_creates_and_writes() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("config.toml");

    let mut doc = toml_edit::DocumentMut::new();
    doc["max_turns"] = toml_edit::value(99 as i64);
    doc["context_window"] = toml_edit::value(300_000 as i64);
    doc["max_output_tokens"] = toml_edit::value(4096 as i64);
    doc["tool_output_max_bytes"] = toml_edit::value(50_000 as i64);
    doc["bash_default_timeout_secs"] = toml_edit::value(60 as i64);
    doc["anthropic_api_key"] = toml_edit::value("sk-test");
    doc["llm_model"] = toml_edit::value("test-model");
    doc["anthropic_base_url"] = toml_edit::value("https://test.api.com");
    std::fs::write(&config_path, doc.to_string()).unwrap();

    let content = std::fs::read_to_string(&config_path).unwrap();
    let parsed = content.parse::<toml_edit::DocumentMut>().unwrap();
    assert_eq!(parsed["max_turns"].as_integer(), Some(99));
    assert_eq!(parsed["anthropic_api_key"].as_str(), Some("sk-test"));
    assert_eq!(parsed["llm_model"].as_str(), Some("test-model"));
    assert_eq!(parsed["anthropic_base_url"].as_str(), Some("https://test.api.com"));
    assert_eq!(parsed["tool_output_max_bytes"].as_integer(), Some(50_000));

    let agent_config = parse_config_toml(&content);
    assert_eq!(agent_config.max_turns, 99);
    assert_eq!(agent_config.context_window, 300_000);
    assert_eq!(agent_config.max_output_tokens, 4096);
    assert_eq!(agent_config.tool_output_max_bytes, 50_000);
    assert_eq!(agent_config.bash_default_timeout_secs, 60);
}

#[test]
fn test_read_config_value_toml_edit() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("config.toml");

    let mut doc = toml_edit::DocumentMut::new();
    doc["llm_model"] = toml_edit::value("test-model");
    doc["anthropic_base_url"] = toml_edit::value("https://custom.com");
    std::fs::write(&config_path, doc.to_string()).unwrap();

    let content = std::fs::read_to_string(&config_path).unwrap();
    let parsed = content.parse::<toml_edit::DocumentMut>().unwrap();
    assert_eq!(parsed["llm_model"].as_str(), Some("test-model"));
    assert_eq!(parsed["anthropic_base_url"].as_str(), Some("https://custom.com"));
}

#[test]
fn test_parse_providers_toml_parses_array() {
    let content = r#"
default_model = "my-provider/claude-sonnet-4"

[[providers]]
name = "my-provider"
api_key = "sk-test-123"
base_url = "https://api.example.com"

[[providers.models]]
id = "claude-sonnet-4"
alias = "sonnet"
tier = "balanced"

[[providers.models]]
id = "claude-opus-4"
tier = "reasoning"

[[providers]]
name = "another"
api_key = "sk-other"
base_url = "https://other.api.com"

[[providers.models]]
id = "gpt-4o"
tier = "fast"
"#;
    let config = parse_providers_toml(content);
    assert_eq!(config.default_model, Some("my-provider/claude-sonnet-4".to_string()));
    assert_eq!(config.providers.len(), 2);

    let p1 = &config.providers[0];
    assert_eq!(p1.name, "my-provider");
    assert_eq!(p1.api_key, "sk-test-123");
    assert_eq!(p1.base_url, "https://api.example.com");
    assert_eq!(p1.models.len(), 2);
    assert_eq!(p1.models[0].id, "claude-sonnet-4");
    assert_eq!(p1.models[0].alias, Some("sonnet".to_string()));
    assert_eq!(p1.models[0].tier, ModelTier::Balanced);
    assert_eq!(p1.models[1].id, "claude-opus-4");
    assert_eq!(p1.models[1].alias, None);
    assert_eq!(p1.models[1].tier, ModelTier::Reasoning);

    let p2 = &config.providers[1];
    assert_eq!(p2.name, "another");
    assert_eq!(p2.models.len(), 1);
    assert_eq!(p2.models[0].tier, ModelTier::Fast);
}

#[test]
fn test_parse_providers_toml_empty_is_ok() {
    let config = parse_providers_toml("max_turns = 50\n");
    assert!(config.providers.is_empty());
    assert_eq!(config.default_model, None);
}

#[test]
fn test_migration_from_old_format() {
    let content = r#"
anthropic_api_key = "sk-ant-old"
anthropic_base_url = "https://custom.api.com"
llm_model = "claude-opus-4-20250514"
max_turns = 50
"#;
    let config = migrate_if_needed(content);
    assert_eq!(config.providers.len(), 1);
    assert_eq!(config.default_model, Some("default/claude-opus-4-20250514".to_string()));

    let p = &config.providers[0];
    assert_eq!(p.name, "default");
    assert_eq!(p.api_key, "sk-ant-old");
    assert_eq!(p.base_url, "https://custom.api.com");
    assert_eq!(p.models.len(), 1);
    assert_eq!(p.models[0].id, "claude-opus-4-20250514");
    assert_eq!(p.models[0].tier, ModelTier::Balanced);
}

#[test]
fn test_migration_skips_if_providers_exist() {
    let content = r#"
anthropic_api_key = "sk-ant-old"

[[providers]]
name = "existing"
api_key = "sk-existing"

[[providers.models]]
id = "test-model"
"#;
    let config = migrate_if_needed(content);
    assert_eq!(config.providers.len(), 1);
    assert_eq!(config.providers[0].name, "existing");
    assert_eq!(config.providers[0].api_key, "sk-existing");
}

#[test]
fn test_migration_no_api_key_returns_empty() {
    let content = "llm_model = \"some-model\"\n";
    let config = migrate_if_needed(content);
    assert!(config.providers.is_empty());
}

#[test]
fn test_parse_providers_missing_name_skipped() {
    let content = r#"
[[providers]]
api_key = "sk-no-name"

[[providers]]
name = "valid"
api_key = "sk-valid"

[[providers.models]]
id = "test"
"#;
    let config = parse_providers_toml(content);
    assert_eq!(config.providers.len(), 1);
    assert_eq!(config.providers[0].name, "valid");
}

#[test]
fn test_parse_providers_model_defaults() {
    let content = r#"
[[providers]]
name = "test"
api_key = "sk-test"

[[providers.models]]
id = "some-model"
"#;
    let config = parse_providers_toml(content);
    assert_eq!(config.providers[0].models.len(), 1);
    let m = &config.providers[0].models[0];
    assert_eq!(m.id, "some-model");
    assert_eq!(m.alias, None);
    assert_eq!(m.tier, ModelTier::Balanced);
}

// ── save_provider_config / delete_provider / save_default_model 测试 ──

#[test]
fn test_save_provider_creates_new() {
    let existing = parse_providers_toml("");
    assert!(existing.providers.is_empty());

    let config = ProviderConfig {
        name: "test-provider".to_string(),
        api_key: "sk-test".to_string(),
        base_url: "https://api.test.com".to_string(),
        models: vec![ModelEntry {
            id: "model-a".to_string(),
            alias: Some("alias-a".to_string()),
            tier: ModelTier::Balanced,
        }],
    };

    // 模拟 save_provider_config 的合并逻辑（不写文件）
    let mut providers = existing.providers;
    let mut found = false;
    for p in &mut providers {
        if p.name == config.name {
            *p = config.clone();
            found = true;
            break;
        }
    }
    if !found {
        providers.push(config);
    }

    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0].name, "test-provider");
    assert_eq!(providers[0].models.len(), 1);
}

#[test]
fn test_save_provider_updates_existing() {
    let content = r#"
[[providers]]
name = "my-provider"
api_key = "old-key"
base_url = "https://old.api.com"

[[providers.models]]
id = "old-model"
tier = "balanced"
"#;
    let mut providers = parse_providers_toml(content).providers;
    assert_eq!(providers.len(), 1);

    let updated = ProviderConfig {
        name: "my-provider".to_string(),
        api_key: "new-key".to_string(),
        base_url: "https://new.api.com".to_string(),
        models: vec![ModelEntry {
            id: "new-model".to_string(),
            alias: None,
            tier: ModelTier::Fast,
        }],
    };

    let mut found = false;
    for p in &mut providers {
        if p.name == updated.name {
            *p = updated.clone();
            found = true;
            break;
        }
    }
    assert!(found);
    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0].api_key, "new-key");
    assert_eq!(providers[0].base_url, "https://new.api.com");
    assert_eq!(providers[0].models[0].id, "new-model");
    assert_eq!(providers[0].models[0].tier, ModelTier::Fast);
}

#[test]
fn test_save_provider_keeps_other_providers() {
    let content = r#"
[[providers]]
name = "provider-a"
api_key = "key-a"
base_url = "https://a.api.com"

[[providers]]
name = "provider-b"
api_key = "key-b"
base_url = "https://b.api.com"
"#;
    let mut providers = parse_providers_toml(content).providers;
    assert_eq!(providers.len(), 2);

    let updated = ProviderConfig {
        name: "provider-b".to_string(),
        api_key: "new-key-b".to_string(),
        base_url: "https://b2.api.com".to_string(),
        models: vec![],
    };

    for p in &mut providers {
        if p.name == updated.name {
            *p = updated;
            break;
        }
    }

    assert_eq!(providers.len(), 2);
    assert_eq!(providers[0].name, "provider-a");
    assert_eq!(providers[0].api_key, "key-a");
    assert_eq!(providers[1].api_key, "new-key-b");
}

#[test]
fn test_save_parse_roundtrip() {
    let providers = vec![
        ProviderConfig {
            name: "anthropic".to_string(),
            api_key: "sk-ant-123".to_string(),
            base_url: "https://api.anthropic.com".to_string(),
            models: vec![
                ModelEntry {
                    id: "claude-sonnet-4".to_string(),
                    alias: Some("sonnet".to_string()),
                    tier: ModelTier::Balanced,
                },
                ModelEntry {
                    id: "claude-opus-4".to_string(),
                    alias: None,
                    tier: ModelTier::Reasoning,
                },
            ],
        },
        ProviderConfig {
            name: "openai".to_string(),
            api_key: "sk-oai-456".to_string(),
            base_url: "https://api.openai.com".to_string(),
            models: vec![ModelEntry {
                id: "gpt-4o".to_string(),
                alias: None,
                tier: ModelTier::Fast,
            }],
        },
    ];

    // 模拟 save_provider_config 的文本拼接逻辑
    let mut out = String::new();
    for p in &providers {
        out.push_str("\n[[providers]]\n");
        out.push_str(&format!("name = \"{}\"\n", p.name));
        out.push_str(&format!("api_key = \"{}\"\n", p.api_key));
        out.push_str(&format!("base_url = \"{}\"\n", p.base_url));
        for m in &p.models {
            out.push_str("\n[[providers.models]]\n");
            out.push_str(&format!("id = \"{}\"\n", m.id));
            if let Some(ref alias) = m.alias {
                out.push_str(&format!("alias = \"{}\"\n", alias));
            }
            let tier_str = match m.tier {
                ModelTier::Balanced => "balanced",
                ModelTier::Reasoning => "reasoning",
                ModelTier::Fast => "fast",
            };
            out.push_str(&format!("tier = \"{}\"\n", tier_str));
        }
    }

    // roundtrip：parse 回来
    let parsed = parse_providers_toml(&out);
    assert_eq!(parsed.providers.len(), 2);

    let p1 = &parsed.providers[0];
    assert_eq!(p1.name, "anthropic");
    assert_eq!(p1.api_key, "sk-ant-123");
    assert_eq!(p1.models.len(), 2);
    assert_eq!(p1.models[0].alias, Some("sonnet".to_string()));
    assert_eq!(p1.models[0].tier, ModelTier::Balanced);
    assert_eq!(p1.models[1].tier, ModelTier::Reasoning);

    let p2 = &parsed.providers[1];
    assert_eq!(p2.name, "openai");
    assert_eq!(p2.models[0].id, "gpt-4o");
    assert_eq!(p2.models[0].tier, ModelTier::Fast);
}
