mod commands;
mod db;
mod error;
mod models;
mod services;

use services::agent_loop;
use services::llm::{AnthropicProvider, LlmProvider};
use std::sync::Arc;
use tauri::Manager;

pub use commands::session::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let config_dir = dirs::home_dir()
                .expect("cannot find home directory")
                .join(".xyz-agent");
            std::fs::create_dir_all(&config_dir).ok();

            let llm_config = agent_loop::load_llm_config()
                .expect("Failed to load LLM config");
            let provider: Arc<dyn LlmProvider> =
                Arc::new(AnthropicProvider::new(llm_config.api_key).with_base_url(llm_config.base_url));

            app.manage(AppState {
                config_dir,
                provider,
                model: llm_config.model,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::session::new_session,
            commands::session::list_sessions,
            commands::session::get_history,
            commands::chat::send_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running xyz-agent");
}
