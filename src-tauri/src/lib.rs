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

            let api_key = agent_loop::extract_api_key()
                .expect("ANTHROPIC_API_KEY not found");
            let provider: Arc<dyn LlmProvider> = Arc::new(AnthropicProvider::new(api_key));

            app.manage(AppState {
                config_dir,
                provider,
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
