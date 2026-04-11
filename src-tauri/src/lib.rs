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

    let llm_config = config::load_llm_config()
        .expect("Failed to load LLM config");
    log::info!("model={}, base_url={}", llm_config.model, llm_config.base_url);

    let agent_config = Arc::new(
        config::load_agent_config().unwrap_or_default(),
    );

    let provider: Arc<dyn LlmProvider> =
        Arc::new(
            AnthropicProvider::new(llm_config.api_key)
                .with_base_url(llm_config.base_url)
                .with_max_tokens(agent_config.max_output_tokens)
        );

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

            app.manage(AppState {
                data_dir,
                provider,
                model: llm_config.model,
                config: agent_config,
                tool_registry,
                global_perms,
                task_tree: Arc::new(tokio::sync::Mutex::new(
                    engine::task_tree::TaskTree::new(),
                )),
                concurrency_manager: Arc::new(
                    engine::concurrency::ConcurrencyManager::new(3),
                ),
                background_tasks: Arc::new(tokio::sync::Mutex::new(
                    std::collections::HashMap::new(),
                )),
                agent_templates: Arc::new(
                    engine::agent_template::AgentTemplateRegistry::new(),
                ),
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
            api::commands::get_config,
            api::commands::update_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running xyz-agent");
}
