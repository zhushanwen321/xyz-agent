mod api;
mod engine;
mod logging;
mod store;
mod types;

use engine::config;
use engine::llm::registry::ProviderRegistry;
use engine::tools::{PermissionContext, ToolRegistry};
use std::sync::Arc;
use tauri::Manager;

pub use api::AppState;

/// 构建 AppState，集中 setup 闭包中的状态初始化逻辑
fn build_app_state(
    data_dir: std::path::PathBuf,
    provider_registry: Arc<std::sync::RwLock<ProviderRegistry>>,
    current_model: Arc<std::sync::RwLock<String>>,
    config: Arc<engine::config::AgentConfig>,
    tool_registry: Arc<ToolRegistry>,
) -> AppState {
    let task_tree = Arc::new(tokio::sync::Mutex::new(
        engine::task_tree::TaskTree::new(),
    ));
    let concurrency_manager = Arc::new(
        engine::concurrency::ConcurrencyManager::new(3),
    );

    // 从 registry 提取默认 provider 和 model_id 构造 spawner
    let agent_spawner_inner: Option<Arc<dyn engine::agent_spawner::AgentSpawner>> = {
        let reg = provider_registry.read().expect("registry lock");
        if reg.is_empty() {
            None
        } else {
            let model_ref = current_model.read().expect("model lock").clone();
            let (provider_name, model_id) = engine::llm::types::parse_model_ref(&model_ref)
                .unwrap_or(("unknown", "unknown"));
            let provider = reg.get_provider(provider_name)
                .or_else(|| reg.get_provider(reg.first_provider_name()?));
            match provider {
                Some(p) => Some(Arc::new(
                    engine::agent_spawner::DefaultAgentSpawner::new(
                        p,
                        model_id.to_string(),
                        config.clone(),
                        tool_registry.clone(),
                        task_tree.clone(),
                        concurrency_manager.clone(),
                        data_dir.clone(),
                    ),
                )),
                None => None,
            }
        }
    };
    let agent_spawner: api::SpawnerRef = Arc::new(std::sync::RwLock::new(agent_spawner_inner));

    AppState {
        data_dir: data_dir.clone(),
        provider_registry,
        current_model,
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

    let agent_config = Arc::new(
        config::load_agent_config().unwrap_or_default(),
    );

    // 加载 providers 配置并构建 ProviderRegistry
    let providers_config = config::load_providers();
    let registry = ProviderRegistry::from_config(
        &providers_config.providers,
        agent_config.max_output_tokens,
        agent_config.thinking_enabled,
        agent_config.thinking_budget_tokens,
    );

    // 确定 default_model
    let default_model = providers_config.default_model
        .or_else(|| registry.default_model_ref())
        .unwrap_or_else(|| "default/claude-sonnet-4-20250514".to_string());

    if registry.is_empty() {
        log::warn!("No API Key found. Please configure in Settings.");
    } else {
        log::info!("default_model={}", default_model);
    }

    let provider_registry = Arc::new(std::sync::RwLock::new(registry));
    let current_model = Arc::new(std::sync::RwLock::new(default_model));

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
                provider_registry.clone(),
                current_model.clone(),
                agent_config.clone(),
                tool_registry.clone(),
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
