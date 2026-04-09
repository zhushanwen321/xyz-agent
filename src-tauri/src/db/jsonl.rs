use std::fs::File;
use std::io::{BufRead, Write};
use std::path::Path;

use file_lock::{FileLock, FileOptions};
use serde_json;

use crate::error::AppError;
use crate::models::transcript::TranscriptEntry;

/// 追加一行 JSONL，使用文件锁防止并发冲突
pub fn append_entry(path: &Path, entry: &TranscriptEntry) -> Result<(), AppError> {
    // 先确保父目录存在
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Storage(format!("create dir failed: {e}")))?;
    }

    let options = FileOptions::new()
        .write(true)
        .create(true)
        .append(true);

    let mut file_lock = FileLock::lock(path, true, options)
        .map_err(|e| AppError::Storage(format!("file lock failed: {e}")))?;

    let json_line = serde_json::to_string(entry)
        .map_err(|e| AppError::Storage(format!("serialize failed: {e}")))?;

    writeln!(file_lock.file, "{json_line}")
        .map_err(|e| AppError::Storage(format!("write failed: {e}")))?;

    file_lock.file.flush()
        .map_err(|e| AppError::Storage(format!("flush failed: {e}")))?;

    // drop 时自动释放锁
    Ok(())
}

/// 读取全部 JSONL 条目
pub fn read_all_entries(path: &Path) -> Result<Vec<TranscriptEntry>, AppError> {
    if !path.exists() {
        return Ok(vec![]);
    }

    let file = File::open(path)
        .map_err(|e| AppError::Storage(format!("open failed: {e}")))?;

    let reader = std::io::BufReader::new(file);
    let mut entries = Vec::new();

    for (line_num, line) in reader.lines().enumerate() {
        let line = line.map_err(|e| AppError::Storage(format!("read line failed: {e}")))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let entry: TranscriptEntry = serde_json::from_str(trimmed).map_err(|e| {
            AppError::Storage(format!("parse line {} failed: {e}", line_num + 1))
        })?;
        entries.push(entry);
    }

    Ok(entries)
}

/// 通过 parent_uuid 回溯构建对话链（分支切换时使用）
#[allow(dead_code)]
pub fn build_conversation_chain(
    entries: &[TranscriptEntry],
    leaf_uuid: Option<&str>,
) -> Vec<TranscriptEntry> {
    let leaf = match leaf_uuid {
        Some(uuid) => uuid,
        None => return entries.to_vec(),
    };

    let mut index = std::collections::HashMap::new();
    for entry in entries {
        let uuid = entry.uuid();
        if !uuid.is_empty() {
            index.insert(uuid.to_string(), entry.clone());
        }
    }

    let mut chain = Vec::new();
    let mut current_uuid = Some(leaf.to_string());

    while let Some(uuid) = current_uuid {
        if let Some(entry) = index.get(&uuid) {
            current_uuid = entry.parent_uuid().map(|s| s.to_string());
            chain.push(entry.clone());
        } else {
            break;
        }
    }

    chain.reverse();
    chain
}

/// 将路径转为安全的目录名（替换 / 为 -）
#[allow(dead_code)]
pub fn sanitize_path(path: &str) -> String {
    let sanitized = path.replace('/', "-");
    sanitized.trim_start_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::transcript::TokenUsage;
    use tempfile::TempDir;

    fn make_user(uuid: &str, parent: Option<&str>, session: &str, content: &str) -> TranscriptEntry {
        TranscriptEntry::User {
            uuid: uuid.to_string(),
            parent_uuid: parent.map(|s| s.to_string()),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            session_id: session.to_string(),
            content: vec![crate::models::UserContentBlock::Text {
                text: content.to_string(),
            }],
        }
    }

    fn make_assistant(uuid: &str, parent: &str, session: &str, content: &str) -> TranscriptEntry {
        TranscriptEntry::Assistant {
            uuid: uuid.to_string(),
            parent_uuid: Some(parent.to_string()),
            timestamp: "2026-01-01T00:00:01Z".to_string(),
            session_id: session.to_string(),
            content: vec![crate::models::AssistantContentBlock::Text {
                text: content.to_string(),
            }],
            usage: Some(TokenUsage { input_tokens: 10, output_tokens: 5 }),
        }
    }

    #[test]
    fn test_append_and_read() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.jsonl");

        let entry1 = make_user("u1", None, "s1", "hello");
        let entry2 = make_assistant("a1", "u1", "s1", "hi there");

        append_entry(&path, &entry1).unwrap();
        append_entry(&path, &entry2).unwrap();

        let entries = read_all_entries(&path).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(matches!(entries[0], TranscriptEntry::User { .. }));
        assert!(matches!(entries[1], TranscriptEntry::Assistant { .. }));
    }

    #[test]
    fn test_read_empty_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nonexistent.jsonl");
        let entries = read_all_entries(&path).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn test_append_creates_parent_dirs() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested/deep/test.jsonl");

        let entry = make_user("u1", None, "s1", "hello");
        append_entry(&path, &entry).unwrap();

        assert!(path.exists());
        let entries = read_all_entries(&path).unwrap();
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn test_sanitize_path() {
        assert_eq!(sanitize_path("/Users/test/projects/my-app"), "Users-test-projects-my-app");
        assert_eq!(sanitize_path("C:\\Users\\test"), "C:\\Users\\test");
        assert_eq!(sanitize_path(""), "");
        assert_eq!(sanitize_path("/"), "");
    }

    #[test]
    fn test_build_chain_linear() {
        let u1 = make_user("u1", None, "s1", "q1");
        let a1 = make_assistant("a1", "u1", "s1", "r1");
        let u2 = make_user("u2", Some("a1"), "s1", "q2");
        let a2 = make_assistant("a2", "u2", "s1", "r2");

        let entries = vec![u1, a1.clone(), u2.clone(), a2.clone()];
        let chain = build_conversation_chain(&entries, Some("a2"));
        assert_eq!(chain.len(), 4);
        assert_eq!(chain[0].uuid(), "u1");
        assert_eq!(chain[3].uuid(), "a2");
    }

    #[test]
    fn test_build_chain_from_middle() {
        let u1 = make_user("u1", None, "s1", "q1");
        let a1 = make_assistant("a1", "u1", "s1", "r1");
        let u2 = make_user("u2", Some("a1"), "s1", "q2");

        let entries = vec![u1, a1, u2.clone()];
        let chain = build_conversation_chain(&entries, Some("u2"));
        assert_eq!(chain.len(), 3);
        assert_eq!(chain[0].uuid(), "u1");
        assert_eq!(chain[2].uuid(), "u2");
    }

    #[test]
    fn test_build_chain_none_returns_all() {
        let u1 = make_user("u1", None, "s1", "q1");
        let a1 = make_assistant("a1", "u1", "s1", "r1");
        let entries = vec![u1, a1];
        let chain = build_conversation_chain(&entries, None);
        assert_eq!(chain.len(), 2);
    }

    #[test]
    fn test_build_chain_unknown_leaf() {
        let u1 = make_user("u1", None, "s1", "q1");
        let entries = vec![u1];
        let chain = build_conversation_chain(&entries, Some("nonexistent"));
        assert!(chain.is_empty());
    }
}
