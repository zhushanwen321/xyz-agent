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

pub fn run() {
    let data_dir = store::session::data_dir()
        .expect("cannot determine data directory");
    store::session::ensure_data_dirs(&data_dir)
        .expect("cannot create data directories");

    logging::init(&data_dir.join("logs"));

    log::info!("data_dir={}", data_dir.display());

    let llm_config = config::load_llm_config();
    let default_model = "claude-sonnet-4-20250514".to_string();

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

    let provider = Arc::new(std::sync::RwLock::new(inner_provider));
    let model = Arc::new(std::sync::RwLock::new(model_str));

    let mut tool_registry = ToolRegistry::new();
    let workdir = std::env::current_dir().unwrap_or_default();
    engine::tools::register_builtin_tools(&mut tool_registry, workdir, &agent_config);
    tool_registry.register(std::sync::Arc::new(engine::tools::feedback::FeedbackTool));
    tool_registry.register(std::sync::Arc::new(engine::tools::dispatch_agent::DispatchAgentTool));
    tool_registry.register(std::sync::Arc::new(engine::tools::orchestrate::OrchestrateTool));
    let tool_registry = Arc::new(tool_registry);
    let global_perms = PermissionContext::default();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            // 动态设置窗口大小为屏幕 75%
            if let Some(window) = app.get_webview_window("main") {
                if let Some(monitor) = window.primary_monitor().ok().flatten() {
                    let size = monitor.size();
                    let w = (size.width as f64 * 0.75) as u32;
                    let h = (size.height as f64 * 0.75) as u32;
                    let _ = window.set_size(tauri::PhysicalSize::new(w, h));
                    let _ = window.center();
                }
            }

            // 共享 task_tree 和 concurrency_manager，确保
            // DefaultAgentSpawner 写入的 task result 对 AppState 可见
            let task_tree = Arc::new(tokio::sync::Mutex::new(
                engine::task_tree::TaskTree::new(),
            ));
            let concurrency_manager = Arc::new(
                engine::concurrency::ConcurrencyManager::new(3),
            );

            let agent_spawner_inner: Option<Arc<dyn engine::agent_spawner::AgentSpawner>> = match &llm_config {
                Some(cfg) => Some(Arc::new(
                    engine::agent_spawner::DefaultAgentSpawner {
                        provider: provider.read().unwrap().clone().unwrap(),
                        model: cfg.model.clone(),
                        config: agent_config.clone(),
                        tool_registry: tool_registry.clone(),
                        task_tree: task_tree.clone(),
                        concurrency_manager: concurrency_manager.clone(),
                        data_dir: data_dir.clone(),
                    },
                )),
                None => None,
            };
            let agent_spawner = Arc::new(std::sync::RwLock::new(agent_spawner_inner));

            app.manage(AppState {
                data_dir: data_dir.clone(),
                provider: provider.clone(),
                model: model.clone(),
                config: agent_config.clone(),
                tool_registry: tool_registry.clone(),
                global_perms,
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
            });
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
