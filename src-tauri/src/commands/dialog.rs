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
    eprintln!("[pick_folder] opening dialog...");
    let result = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Select Working Directory")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e: tauri::Error| {
        eprintln!("[pick_folder] spawn_blocking error: {e}");
        e.to_string()
    })?;

    match result {
        Some(path) => {
            let s = path.to_string();
            eprintln!("[pick_folder] selected: {s}");
            Ok(FolderPickerResult {
                path: Some(s),
                cancelled: false,
            })
        }
        None => {
            eprintln!("[pick_folder] cancelled");
            Ok(FolderPickerResult {
                path: None,
                cancelled: true,
            })
        }
    }
}
