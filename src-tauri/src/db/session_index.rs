use std::path::Path;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;
use crate::models::transcript::TranscriptEntry;

use super::jsonl::{self, read_all_entries};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 扫描目录下的 .jsonl 文件，提取 session 元数据
pub fn list_sessions(projects_dir: &Path, cwd: &str) -> Result<Vec<SessionMeta>, AppError> {
    let safe_cwd = jsonl::sanitize_path(cwd);
    let session_dir = projects_dir.join("projects").join(&safe_cwd);

    if !session_dir.exists() {
        return Ok(vec![]);
    }

    let mut sessions = Vec::new();

    let entries = std::fs::read_dir(&session_dir)
        .map_err(|e| AppError::Storage(format!("read dir failed: {e}")))?;

    for entry in entries {
        let entry = entry.map_err(|e| AppError::Storage(format!("dir entry failed: {e}")))?;
        let path = entry.path();

        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }

        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown");

        let file_entries = read_all_entries(&path)?;
        let title = extract_title(&file_entries).unwrap_or_else(|| stem.to_string());
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
            id: stem.to_string(),
            title,
            created_at,
            updated_at,
        });
    }

    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(sessions)
}

/// 创建新的 session，返回元数据
pub fn new_session(projects_dir: &Path, cwd: &str) -> Result<SessionMeta, AppError> {
    let safe_cwd = jsonl::sanitize_path(cwd);
    let session_dir = projects_dir.join("projects").join(&safe_cwd);
    std::fs::create_dir_all(&session_dir)
        .map_err(|e| AppError::Storage(format!("create session dir failed: {e}")))?;

    let session_id = Uuid::new_v4().to_string();
    let path = session_dir.join(format!("{session_id}.jsonl"));

    let now = Utc::now().to_rfc3339();
    let system_entry = TranscriptEntry::System {
        uuid: Uuid::new_v4().to_string(),
        parent_uuid: None,
        timestamp: now.clone(),
        session_id: session_id.clone(),
        content: "New session started".to_string(),
    };

    jsonl::append_entry(&path, &system_entry)?;

    Ok(SessionMeta {
        id: session_id,
        title: "New Session".to_string(),
        created_at: now,
        updated_at: Utc::now().to_rfc3339(),
    })
}

/// 从 entries 中提取标题（取第一条 user 消息的前 50 字符）
fn extract_title(entries: &[TranscriptEntry]) -> Option<String> {
    entries.iter().find_map(|e| match e {
        TranscriptEntry::User { content, .. } => {
            let chars: Vec<char> = content.chars().collect();
            let title = if chars.len() > 50 {
                let truncated: String = chars[..50].iter().collect();
                format!("{}...", truncated)
            } else {
                content.clone()
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
        let meta = new_session(dir.path(), "/Users/test/project").unwrap();

        assert!(!meta.id.is_empty());
        assert_eq!(meta.title, "New Session");
        assert!(!meta.created_at.is_empty());

        let safe_cwd = jsonl::sanitize_path("/Users/test/project");
        let file_path = dir.path()
            .join("projects")
            .join(&safe_cwd)
            .join(format!("{}.jsonl", meta.id));
        assert!(file_path.exists());

        let entries = read_all_entries(&file_path).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(matches!(entries[0], TranscriptEntry::System { .. }));
    }

    #[test]
    fn test_list_sessions_empty() {
        let dir = TempDir::new().unwrap();
        let sessions = list_sessions(dir.path(), "/some/path").unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn test_list_sessions_with_data() {
        let dir = TempDir::new().unwrap();

        let meta1 = new_session(dir.path(), "/project").unwrap();
        let meta2 = new_session(dir.path(), "/project").unwrap();

        // 给第一个 session 添加 user 消息
        let safe_cwd = jsonl::sanitize_path("/project");
        let file1 = dir.path()
            .join("projects")
            .join(&safe_cwd)
            .join(format!("{}.jsonl", meta1.id));
        let user_entry = TranscriptEntry::new_user(&meta1.id, "This is my first question", None);
        jsonl::append_entry(&file1, &user_entry).unwrap();

        let sessions = list_sessions(dir.path(), "/project").unwrap();
        assert_eq!(sessions.len(), 2);

        // 按更新时间倒序：meta1 追加了 user 消息，修改时间更晚，排第一
        assert_eq!(sessions[0].id, meta1.id);
        assert_eq!(sessions[1].id, meta2.id);

        // meta1 有 user 消息作为标题
        assert_eq!(sessions[0].title, "This is my first question");
    }

    #[test]
    fn test_new_session_different_cwd() {
        let dir = TempDir::new().unwrap();

        new_session(dir.path(), "/project-a").unwrap();
        new_session(dir.path(), "/project-b").unwrap();

        let sessions_a = list_sessions(dir.path(), "/project-a").unwrap();
        let sessions_b = list_sessions(dir.path(), "/project-b").unwrap();

        assert_eq!(sessions_a.len(), 1);
        assert_eq!(sessions_b.len(), 1);
    }
}
