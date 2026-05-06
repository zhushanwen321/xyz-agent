use tauri::Emitter;

pub fn register_shortcuts(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let shortcuts = app.global_shortcut();

    shortcuts.on_shortcut("CmdOrCtrl+1", |app, _shortcut, _event| {
        let _ = app.emit("shortcut", "standard");
    })?;

    shortcuts.on_shortcut("CmdOrCtrl+3", |app, _shortcut, _event| {
        let _ = app.emit("shortcut", "focus");
    })?;

    shortcuts.on_shortcut("CmdOrCtrl+,", |app, _shortcut, _event| {
        let _ = app.emit("shortcut", "settings");
    })?;

    Ok(())
}
