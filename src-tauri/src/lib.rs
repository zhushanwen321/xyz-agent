mod api;
mod engine;
mod logging;
mod store;
mod types;

use engine::config;
use engine::llm::anthropic::AnthropicProvider;
use engine::llm::LlmProvider;
use engine::tools::{PermissionContext, ToolRegistry};
use std::sync::Arc;
use tauri::Manager;

pub use api::AppState;

/// 构建 AppState，集中 setup 闭包中的状态初始化逻辑
fn build_app_state(
    data_dir: std::path::PathBuf,
    provider: api::ProviderRef,
    model: Arc<std::sync::RwLock<String>>,
    config: Arc<engine::config::AgentConfig>,
    tool_registry: Arc<ToolRegistry>,
    llm_config: &Option<engine::config::LlmConfig>,
) -> AppState {
    let task_tree = Arc::new(tokio::sync::Mutex::new(
        engine::task_tree::TaskTree::new(),
    ));
    let concurrency_manager = Arc::new(
        engine::concurrency::ConcurrencyManager::new(3),
    );

    let agent_spawner_inner: Option<Arc<dyn engine::agent_spawner::AgentSpawner>> = match llm_config {
        Some(cfg) => Some(Arc::new(
            engine::agent_spawner::DefaultAgentSpawner::new(
                provider.read().expect("provider lock").clone().expect("provider must exist during setup"),
                cfg.model.clone(),
                config.clone(),
                tool_registry.clone(),
                task_tree.clone(),
                concurrency_manager.clone(),
                data_dir.clone(),
            ),
        )),
        None => None,
    };
    let agent_spawner: api::SpawnerRef = Arc::new(std::sync::RwLock::new(agent_spawner_inner));

    AppState {
        data_dir: data_dir.clone(),
        provider,
        model,
        config,
        tool_registry,
        global_perms: PermissionContext::default(),
        task_tree,
        concurrency_manager,
        background_tasks: Arc::new(tokio::sync::Mutex::new(
            std::collections::HashMap::new(),
        )),
        agent_templates: {
            let mut reg = engine::agent_template::AgentTemplateRegistry::new();
            reg.load_custom_agents(&data_dir);
            Arc::new(std::sync::RwLock::new(reg))
        },
        prompt_registry: {
            let mut reg = engine::context::prompt_registry::PromptRegistry::new();
            reg.load_user_prompts(&data_dir);
            Arc::new(std::sync::RwLock::new(reg))
        },
        agent_spawner,
        cancel_tokens: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
    }
}

pub fn run() {
    let data_dir = store::session::data_dir()
        .expect("cannot determine data directory");
    store::session::ensure_data_dirs(&data_dir)
        .expect("cannot create data directories");

    logging::init(&data_dir.join("logs"));

    log::info!("data_dir={}", data_dir.display());

    const DEFAULT_MODEL: &str = "claude-sonnet-4-20250514";

    let llm_config = config::load_llm_config();
    let default_model = DEFAULT_MODEL.to_string();

    let agent_config = Arc::new(
        config::load_agent_config().unwrap_or_default(),
    );

    // 根据 LLM 配置构建 provider 和 model
    let (inner_provider, model_str) = match &llm_config {
        Some(cfg) => {
            log::info!("model={}, base_url={}", cfg.model, cfg.base_url);
            let p: Arc<dyn LlmProvider> = Arc::new(
                AnthropicProvider::new(cfg.api_key.clone())
                    .with_base_url(cfg.base_url.clone())
                    .with_max_tokens(agent_config.max_output_tokens)
                    .with_thinking(agent_config.thinking_enabled, agent_config.thinking_budget_tokens),
            );
            (Some(p), cfg.model.clone())
        },
        None => {
            log::warn!("No API Key found. Please configure in Settings.");
            (None, default_model)
        },
    };

    let provider: api::ProviderRef = Arc::new(std::sync::RwLock::new(inner_provider));
    let model = Arc::new(std::sync::RwLock::new(model_str));

    let mut tool_registry = ToolRegistry::new();
    let workdir = std::env::current_dir().unwrap_or_default();
    engine::tools::register_builtin_tools(&mut tool_registry, workdir, &agent_config);
    tool_registry.register(std::sync::Arc::new(engine::tools::feedback::FeedbackTool));
    tool_registry.register(std::sync::Arc::new(engine::tools::dispatch_agent::DispatchAgentTool));
    tool_registry.register(std::sync::Arc::new(engine::tools::orchestrate::OrchestrateTool));
    let tool_registry = Arc::new(tool_registry);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                if let Some(monitor) = window.primary_monitor().ok().flatten() {
                    let size = monitor.size();
                    let w = (size.width as f64 * 0.75) as u32;
                    let h = (size.height as f64 * 0.75) as u32;
                    let _ = window.set_size(tauri::PhysicalSize::new(w, h));
                    let _ = window.center();
                }
            }

            let state = build_app_state(
                data_dir,
                provider.clone(),
                model.clone(),
                agent_config.clone(),
                tool_registry.clone(),
                &llm_config,
            );
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            api::commands::new_session,
            api::commands::list_sessions,
            api::commands::get_history,
            api::commands::delete_session,
            api::commands::rename_session,
            api::commands::get_current_model,
            api::commands::list_tools,
            api::commands::send_message,
            api::commands::check_api_key,
            api::commands::get_config,
            api::commands::update_config,
            api::commands::apply_llm_config,
            api::commands::cancel_message,
            api::commands::kill_task,
            api::commands::pause_task,
            api::commands::resume_task,
            api::commands::load_sidechain_history,
            api::prompt_commands::prompt_list,
            api::prompt_commands::prompt_get,
            api::prompt_commands::prompt_preview,
            api::prompt_commands::prompt_save,
            api::prompt_commands::prompt_delete,
            api::prompt_commands::custom_agent_save,
            api::prompt_commands::custom_agent_delete,
            api::tool_commands::tool_config_list,
            api::tool_commands::tool_config_save,
            api::tool_commands::tool_config_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running xyz-agent");
}
