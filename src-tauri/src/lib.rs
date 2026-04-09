mod commands;
mod db;
mod error;
mod logging;
mod models;
mod services;

use services::agent_loop;
use services::llm::{AnthropicProvider, LlmProvider};
use services::tool_registry::{PermissionContext, ToolRegistry};
use services::tools;
use std::sync::Arc;
use tauri::Manager;

pub use commands::session::AppState;

pub fn run() {
    // 先确定数据目录
    let data_dir = db::session_index::data_dir()
        .expect("cannot determine data directory");
    db::session_index::ensure_data_dirs(&data_dir)
        .expect("cannot create data directories");

    // 初始化日志（写到 data_dir/logs/）
    logging::init(&data_dir.join("logs"));

    log::info!("data_dir={}", data_dir.display());

    let llm_config = agent_loop::load_llm_config()
        .expect("Failed to load LLM config");
    log::info!("model={}, base_url={}", llm_config.model, llm_config.base_url);

    let provider: Arc<dyn LlmProvider> =
        Arc::new(AnthropicProvider::new(llm_config.api_key).with_base_url(llm_config.base_url));

    let mut tool_registry = ToolRegistry::new();
    let workdir = std::env::current_dir().unwrap_or_default();
    tools::register_builtin_tools(&mut tool_registry, workdir);
    let global_perms = PermissionContext::default();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            app.manage(AppState {
                data_dir,
                provider,
                model: llm_config.model,
                tool_registry,
                global_perms,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::session::new_session,
            commands::session::list_sessions,
            commands::session::get_history,
            commands::session::delete_session,
            commands::chat::send_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running xyz-agent");
}
