use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::types::AppError;
use crate::types::{TranscriptEntry, UserContentBlock};

use super::jsonl::read_all_entries;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 获取数据根目录：dev 模式 ~/.xyz-agent-dev，release 模式 ~/.xyz-agent
pub fn data_dir() -> Result<PathBuf, AppError> {
    let dir_name = if cfg!(debug_assertions) {
        ".xyz-agent-dev"
    } else {
        ".xyz-agent"
    };
    let dir = dirs::home_dir()
        .ok_or_else(|| AppError::Config("cannot find home directory".to_string()))?
        .join(dir_name);
    Ok(dir)
}

/// 确保数据目录结构存在
pub fn ensure_data_dirs(data: &Path) -> Result<(), AppError> {
    for sub in &["sessions", "logs"] {
        std::fs::create_dir_all(data.join(sub))
            .map_err(|e| AppError::Storage(format!("create {sub}/ dir failed: {e}")))?;
    }
    Ok(())
}

fn sessions_dir(data: &Path) -> PathBuf {
    data.join("sessions")
}

fn session_path(data: &Path, session_id: &str) -> PathBuf {
    sessions_dir(data).join(format!("{session_id}.jsonl"))
}

/// 列出所有 session
pub fn list_sessions(data: &Path) -> Result<Vec<SessionMeta>, AppError> {
    let dir = sessions_dir(data);
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut sessions = Vec::new();
    let entries = std::fs::read_dir(&dir)
        .map_err(|e| AppError::Storage(format!("read sessions dir failed: {e}")))?;

    for entry in entries {
        let entry = entry.map_err(|e| AppError::Storage(format!("dir entry failed: {e}")))?;
        let path = entry.path();

        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }

        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();

        let file_entries = read_all_entries(&path)?;
        let title = extract_title(&file_entries).unwrap_or_else(|| stem.clone());
        let created_at = file_entries
            .first()
            .and_then(|e| match e {
                TranscriptEntry::User { timestamp, .. } => Some(timestamp.clone()),
                TranscriptEntry::Assistant { timestamp, .. } => Some(timestamp.clone()),
                TranscriptEntry::System { timestamp, .. } => Some(timestamp.clone()),
                _ => None,
            })
            .unwrap_or_default();

        let updated_at = path
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|t| {
                let dt: chrono::DateTime<Utc> = t.into();
                dt.to_rfc3339()
            })
            .unwrap_or_default();

        sessions.push(SessionMeta {
            id: stem,
            title,
            created_at,
            updated_at,
        });
    }

    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(sessions)
}

/// 创建新 session
pub fn new_session(data: &Path) -> Result<SessionMeta, AppError> {
    let dir = sessions_dir(data);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::Storage(format!("create sessions dir failed: {e}")))?;

    let session_id = Uuid::new_v4().to_string();
    let path = session_path(data, &session_id);

    let now = Utc::now().to_rfc3339();
    let system_entry = TranscriptEntry::System {
        uuid: Uuid::new_v4().to_string(),
        parent_uuid: None,
        timestamp: now.clone(),
        session_id: session_id.clone(),
        content: "New session started".to_string(),
    };

    super::jsonl::append_entry(&path, &system_entry)?;

    Ok(SessionMeta {
        id: session_id,
        title: "New Session".to_string(),
        created_at: now,
        updated_at: Utc::now().to_rfc3339(),
    })
}

/// 删除 session
pub fn delete_session(data: &Path, session_id: &str) -> Result<(), AppError> {
    let path = session_path(data, session_id);
    if !path.exists() {
        return Err(AppError::SessionNotFound(session_id.to_string()));
    }
    std::fs::remove_file(&path)
        .map_err(|e| AppError::Storage(format!("delete session failed: {e}")))?;
    Ok(())
}

/// 重命名 session（写入 CustomTitle 条目）
pub fn rename_session(data: &Path, session_id: &str, new_title: &str) -> Result<(), AppError> {
    let path = session_path(data, session_id);
    if !path.exists() {
        return Err(AppError::SessionNotFound(session_id.to_string()));
    }
    let entry = TranscriptEntry::CustomTitle {
        session_id: session_id.to_string(),
        title: new_title.to_string(),
    };
    super::jsonl::append_entry(&path, &entry)?;
    Ok(())
}

/// 获取 session JSONL 文件路径
pub fn session_file_path(data: &Path, session_id: &str) -> Option<PathBuf> {
    let path = session_path(data, session_id);
    if path.exists() { Some(path) } else { None }
}

/// 从 entries 中提取标题
/// 优先使用 CustomTitle 条目，否则取第一条 user 消息的前 50 字符
fn extract_title(entries: &[TranscriptEntry]) -> Option<String> {
    // 优先取最后一个 CustomTitle（支持多次重命名）
    let custom = entries.iter().rev().find_map(|e| match e {
        TranscriptEntry::CustomTitle { title, .. } => Some(title.clone()),
        _ => None,
    });
    if custom.is_some() {
        return custom;
    }
    entries.iter().find_map(|e| match e {
        TranscriptEntry::User { content, .. } => {
            let text: String = content
                .iter()
                .filter_map(|b| match b {
                    UserContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            let chars: Vec<char> = text.chars().collect();
            let title = if chars.len() > 50 {
                let truncated: String = chars[..50].iter().collect();
                format!("{}...", truncated)
            } else {
                text
            };
            Some(title)
        }
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_new_session_creates_file() {
        let dir = TempDir::new().unwrap();
        let meta = new_session(dir.path()).unwrap();

        assert!(!meta.id.is_empty());
        assert_eq!(meta.title, "New Session");

        let file_path = dir.path().join("sessions").join(format!("{}.jsonl", meta.id));
        assert!(file_path.exists());

        let entries = read_all_entries(&file_path).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(matches!(entries[0], TranscriptEntry::System { .. }));
    }

    #[test]
    fn test_list_sessions_empty() {
        let dir = TempDir::new().unwrap();
        let sessions = list_sessions(dir.path()).unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn test_list_sessions_with_data() {
        let dir = TempDir::new().unwrap();

        let meta1 = new_session(dir.path()).unwrap();
        let _meta2 = new_session(dir.path()).unwrap();

        let file1 = dir.path().join("sessions").join(format!("{}.jsonl", meta1.id));
        let user_entry = TranscriptEntry::new_user(&meta1.id, "This is my first question", None);
        crate::store::jsonl::append_entry(&file1, &user_entry).unwrap();

        let sessions = list_sessions(dir.path()).unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].id, meta1.id);
        assert_eq!(sessions[0].title, "This is my first question");
    }

    #[test]
    fn test_delete_session() {
        let dir = TempDir::new().unwrap();
        let meta = new_session(dir.path()).unwrap();

        let path = dir.path().join("sessions").join(format!("{}.jsonl", meta.id));
        assert!(path.exists());

        delete_session(dir.path(), &meta.id).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn test_delete_nonexistent_session() {
        let dir = TempDir::new().unwrap();
        let result = delete_session(dir.path(), "nonexistent");
        assert!(result.is_err());
    }
}
