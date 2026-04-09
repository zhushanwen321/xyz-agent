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
        Arc::new(AnthropicProvider::new(llm_config.api_key).with_base_url(llm_config.base_url));

    let mut tool_registry = ToolRegistry::new();
    let workdir = std::env::current_dir().unwrap_or_default();
    engine::tools::register_builtin_tools(&mut tool_registry, workdir);
    let tool_registry = Arc::new(tool_registry);
    let global_perms = PermissionContext::default();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            app.manage(AppState {
                data_dir,
                provider,
                model: llm_config.model,
                config: agent_config,
                tool_registry,
                global_perms,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            api::commands::new_session,
            api::commands::list_sessions,
            api::commands::get_history,
            api::commands::delete_session,
            api::commands::get_current_model,
            api::commands::list_tools,
            api::commands::send_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running xyz-agent");
}
