use tauri::Manager;

mod commands;
mod sidecar;
mod shortcuts;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar_mgr = sidecar::SidecarManager::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(sidecar_mgr)
        .invoke_handler(tauri::generate_handler![
        commands::dialog::pick_folder,
        commands::settings_window::open_settings_window,
    ])
        .setup(|app| {
            shortcuts::register_shortcuts(app.handle())?;

            // Start sidecar with automatic port discovery
            let sidecar = app.state::<sidecar::SidecarManager>();
            if std::env::var("XYZ_MOCK").as_deref() == Ok("1") {
                log::info!("Mock mode — skipping sidecar start");
            } else {
                match sidecar.start(app.handle()) {
                    Ok(port) => log::info!("Sidecar started on port {}", port),
                    Err(e) => log::error!("Failed to start sidecar: {}", e),
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let sidecar: tauri::State<'_, sidecar::SidecarManager> =
                    window.app_handle().state::<sidecar::SidecarManager>();
                sidecar.stop().ok();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
