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
    let folder_path = app
        .dialog()
        .file()
        .set_title("Select Working Directory")
        .blocking_pick_folder();

    match folder_path {
        Some(fp) => {
            // fp.into_path() converts both FilePath::Path and FilePath::Url to PathBuf
            let path = fp.into_path().map_err(|e| format!("Invalid path: {e}"))?;
            let s = path.to_string_lossy().to_string();
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
