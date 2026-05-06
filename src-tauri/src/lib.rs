use tauri::Manager;

mod sidecar;
mod shortcuts;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar = sidecar::SidecarManager::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(sidecar)
        .setup(|app| {
            shortcuts::register_shortcuts(app.handle())?;
            // Start sidecar on port 3210
            let sidecar = app.state::<sidecar::SidecarManager>();
            sidecar.start(3210).ok();
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
