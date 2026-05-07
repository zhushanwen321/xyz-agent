#[tauri::command]
pub fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    let existing = app.get_webview_window("settings");
    if let Some(win) = existing {
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = tauri::WebviewUrl::App("settings.html".into());
    let label = "settings".to_string();
    let _window = tauri::WebviewWindowBuilder::new(&app, &label, url)
        .title("xyz-agent - Settings")
        .fullscreen(true)
        .decorations(true)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}
