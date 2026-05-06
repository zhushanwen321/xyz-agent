use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
pub struct FolderPickerResult {
    pub path: Option<String>,
    pub cancelled: bool,
}

#[tauri::command]
pub fn pick_folder(app: AppHandle) -> Result<FolderPickerResult, String> {
    let folder_path = app
        .dialog()
        .file()
        .set_title("Select Working Directory")
        .blocking_pick_folder();

    match folder_path {
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
