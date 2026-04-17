use std::fs::{File, OpenOptions};
use std::io::{BufRead, Write};
use std::path::Path;

use crate::types::AppError;
use crate::types::TranscriptEntry;

fn append_jsonl(path: &Path, entry: &TranscriptEntry) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Storage(format!("create dir failed: {e}")))?;
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| AppError::Storage(format!("open failed: {e}")))?;

    let json_line = serde_json::to_string(entry)
        .map_err(|e| AppError::Storage(format!("serialize failed: {e}")))?;

    writeln!(file, "{json_line}")
        .map_err(|e| AppError::Storage(format!("write failed: {e}")))?;

    file.flush()
        .map_err(|e| AppError::Storage(format!("flush failed: {e}")))?;

    Ok(())
}

pub fn append_entry(path: &Path, entry: &TranscriptEntry) -> Result<(), AppError> {
    append_jsonl(path, entry)
}

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

#[allow(dead_code)]
pub fn sanitize_path(path: &str) -> String {
    let sanitized = path.replace('/', "-");
    sanitized.trim_start_matches('-').to_string()
}

// ── AsyncResult / LoadHistoryResult ──────────────────────────

#[derive(serde::Serialize)]
pub struct AsyncResult {
    pub task_id: String,
    pub description: String,
    pub status: String,
    pub result_summary: String,
    pub output_file: Option<String>,
}

#[derive(serde::Serialize)]
pub struct LoadHistoryResult {
    pub entries: Vec<TranscriptEntry>,
    pub conversation_summary: Option<String>,
    #[serde(rename = "task_nodes")]
    pub task_node_entries: Vec<TranscriptEntry>,
    #[serde(rename = "orchestrate_nodes")]
    pub orchestrate_node_entries: Vec<TranscriptEntry>,
    pub pending_async_results: Vec<AsyncResult>,
}

pub fn load_history(path: &Path) -> Result<LoadHistoryResult, AppError> {
    let all_entries = read_all_entries(path)?;

    // 提取节点条目：每个 node_id/task_id 保留最后一条（last write wins）
    let mut task_nodes_map = std::collections::HashMap::<String, TranscriptEntry>::new();
    let mut orch_nodes_map = std::collections::HashMap::<String, TranscriptEntry>::new();
    for entry in &all_entries {
        match entry {
            TranscriptEntry::TaskNode { task_id, .. } => {
                task_nodes_map.insert(task_id.clone(), entry.clone());
            }
            TranscriptEntry::OrchestrateNode { node_id, .. } => {
                orch_nodes_map.insert(node_id.clone(), entry.clone());
            }
            _ => {}
        }
    }
    let task_node_entries: Vec<TranscriptEntry> = task_nodes_map.into_values().collect();
    let orchestrate_node_entries: Vec<TranscriptEntry> = orch_nodes_map.into_values().collect();

    // 找到最新的 Summary 条目（从后往前搜索）
    let latest_summary = all_entries.iter().rev().find_map(|e| {
        if let TranscriptEntry::Summary {
            summary, leaf_uuid, ..
        } = e
        {
            Some((summary.clone(), leaf_uuid.clone()))
        } else {
            None
        }
    });

    match latest_summary {
        Some((summary_text, leaf_uuid)) => {
            let entries_after = all_entries
                .into_iter()
                .skip_while(|e| e.uuid() != leaf_uuid)
                .skip(1) // 跳过 leaf_uuid 条目本身
                .filter(|e| !matches!(e, TranscriptEntry::Summary { .. }))
                .collect();
            Ok(LoadHistoryResult {
                entries: entries_after,
                conversation_summary: Some(summary_text),
                task_node_entries,
                orchestrate_node_entries,
                pending_async_results: Vec::new(),
            })
        }
        None => Ok(LoadHistoryResult {
            entries: all_entries,
            conversation_summary: None,
            task_node_entries,
            orchestrate_node_entries,
            pending_async_results: Vec::new(),
        }),
    }
}

// ── Sidechain / Orchestrate JSONL helpers ─────────────────────────

/// Session transcript 路径
pub fn session_transcript_path(data_dir: &Path, session_id: &str) -> std::path::PathBuf {
    data_dir.join("sessions").join(format!("{session_id}.jsonl"))
}

/// 将 task_tree::TaskNode 持久化到 session transcript
pub fn persist_task_node(
    data_dir: &Path,
    session_id: &str,
    node: &crate::engine::task_tree::TaskNode,
) -> Result<(), AppError> {
    let path = session_transcript_path(data_dir, session_id);
    let entry = TranscriptEntry::from_task_node(node);
    append_entry(&path, &entry)
}

/// 将 task_tree::OrchestrateNode 持久化到 session transcript
pub fn persist_orchestrate_node(
    data_dir: &Path,
    session_id: &str,
    node: &crate::engine::task_tree::OrchestrateNode,
) -> Result<(), AppError> {
    let path = session_transcript_path(data_dir, session_id);
    let entry = TranscriptEntry::from_orchestrate_node(node);
    append_entry(&path, &entry)
}

// ── Sidechain / Orchestrate JSONL helpers (continued) ─────────────────────────

fn sanitize_segment(s: &str) -> String {
    s.chars().map(|c| if c == '/' || c == '\\' || c == '.' { '_' } else { c }).collect()
}

fn ensure_jsonl_path(data_dir: &Path, session_id: &str, sub_dir: &str, file_stem: &str) -> std::path::PathBuf {
    let dir = data_dir.join(sanitize_segment(session_id)).join(sub_dir);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("[jsonl] create_dir_all failed for {sub_dir}: {e}");
    }
    dir.join(format!("{}.jsonl", sanitize_segment(file_stem)))
}

pub fn sidechain_path(data_dir: &Path, session_id: &str, task_id: &str) -> std::path::PathBuf {
    ensure_jsonl_path(data_dir, session_id, "subagents", task_id)
}

pub fn append_sidechain_entry(path: &Path, entry: &TranscriptEntry) -> Result<(), AppError> {
    append_jsonl(path, entry)
}

pub fn orchestrate_path(data_dir: &Path, session_id: &str, node_id: &str) -> std::path::PathBuf {
    ensure_jsonl_path(data_dir, session_id, "orchestrate", node_id)
}

/// 从 sidechain/orchestrate jsonl 加载条目
pub fn load_sidechain_entries(
    data_dir: &Path,
    session_id: &str,
    sidechain_id: &str,
    sidechain_type: &str,
) -> Result<Vec<TranscriptEntry>, AppError> {
    let path = match sidechain_type {
        "subagent" => sidechain_path(data_dir, session_id, sidechain_id),
        "orchestrate" => orchestrate_path(data_dir, session_id, sidechain_id),
        _ => return Err(AppError::Config(format!("unknown sidechain_type: {sidechain_type}"))),
    };
    if !path.exists() {
        return Ok(vec![]);
    }
    let mut entries = Vec::new();
    for line in std::io::BufReader::new(std::fs::File::open(&path).map_err(AppError::Io)?)
        .lines()
    {
        let line = line.map_err(AppError::Io)?;
        if line.trim().is_empty() { continue; }
        let entry: TranscriptEntry = serde_json::from_str(&line).map_err(AppError::Serialization)?;
        entries.push(entry);
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::TokenUsage;
    use tempfile::TempDir;

    fn make_user(uuid: &str, parent: Option<&str>, session: &str, content: &str) -> TranscriptEntry {
        TranscriptEntry::User {
            uuid: uuid.to_string(),
            parent_uuid: parent.map(|s| s.to_string()),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            session_id: session.to_string(),
            content: vec![crate::types::UserContentBlock::Text {
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
            content: vec![crate::types::AssistantContentBlock::Text {
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

    // ── load_history tests ──────────────────────────────────────

    #[test]
    fn test_load_history_no_summary_returns_all() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.jsonl");

        let u1 = make_user("u1", None, "s1", "hello");
        let a1 = make_assistant("a1", "u1", "s1", "hi");
        let u2 = make_user("u2", Some("a1"), "s1", "bye");

        append_entry(&path, &u1).unwrap();
        append_entry(&path, &a1).unwrap();
        append_entry(&path, &u2).unwrap();

        let result = load_history(&path).unwrap();
        assert!(result.conversation_summary.is_none());
        assert_eq!(result.entries.len(), 3);
    }

    #[test]
    fn test_load_history_with_summary_skips_old_entries() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.jsonl");

        let u1 = make_user("u1", None, "s1", "old msg");
        let a1 = make_assistant("a1", "u1", "s1", "old reply");
        let summary = TranscriptEntry::Summary {
            session_id: "s1".to_string(),
            leaf_uuid: "a1".to_string(),
            summary: "用户问了 old msg，助手回复了 old reply".to_string(),
        };
        let u2 = make_user("u2", Some("a1"), "s1", "new msg");
        let a2 = make_assistant("a2", "u2", "s1", "new reply");

        append_entry(&path, &u1).unwrap();
        append_entry(&path, &a1).unwrap();
        append_entry(&path, &summary).unwrap();
        append_entry(&path, &u2).unwrap();
        append_entry(&path, &a2).unwrap();

        let result = load_history(&path).unwrap();
        assert_eq!(
            result.conversation_summary.as_deref().unwrap(),
            "用户问了 old msg，助手回复了 old reply"
        );
        // 应只返回 leaf_uuid (a1) 之后的条目
        assert_eq!(result.entries.len(), 2);
        assert_eq!(result.entries[0].uuid(), "u2");
        assert_eq!(result.entries[1].uuid(), "a2");
    }

    #[test]
    fn test_load_history_empty_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nonexistent.jsonl");

        let result = load_history(&path).unwrap();
        assert!(result.conversation_summary.is_none());
        assert!(result.entries.is_empty());
    }
}
