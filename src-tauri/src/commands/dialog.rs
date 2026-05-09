use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
pub struct FolderPickerResult {
    pub path: Option<String>,
    pub cancelled: bool,
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<FolderPickerResult, String> {
    // blocking_pick_folder internally dispatches to the main thread for the native dialog.
    // We must NOT call it from the main thread (which sync commands run on) — that causes deadlock.
    // async commands run on tauri's thread pool; spawn_blocking prevents starving it.
    let result = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Select Working Directory")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e: tauri::Error| e.to_string())?;

    match result {
        Some(path) => Ok(FolderPickerResult {
            path: Some(path.to_string()),
            cancelled: false,
        }),
        None => Ok(FolderPickerResult {
            path: None,
            cancelled: true,
        }),
    }
}
