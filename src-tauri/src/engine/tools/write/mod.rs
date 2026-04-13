use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json;

use crate::engine::tools::{Tool, ToolResult, ToolExecutionContext};

pub struct WriteTool {
    workdir: PathBuf,
}

impl WriteTool {
    pub fn new(workdir: PathBuf) -> Self {
        Self { workdir }
    }
}

#[async_trait]
impl Tool for WriteTool {
    fn name(&self) -> &str {
        "Write"
    }

    fn description(&self) -> &str {
        "Write content to a file.\n\
         \n\
         - Writes to existing paths only. Does NOT create parent directories.\n\
         - Overwrites the entire file if it already exists.\n\
         - Do NOT use Bash (echo/cat redirect) to write files — always use this tool."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Path to the file. Relative to project root, or absolute."
                },
                "content": {
                    "type": "string",
                    "description": "The complete content to write. Overwrites the entire file."
                }
            },
            "required": ["file_path", "content"]
        })
    }

    fn is_concurrent_safe(&self) -> bool {
        false
    }

    fn timeout_secs(&self) -> u64 {
        10
    }

    async fn call(&self, input: serde_json::Value, _ctx: Option<&ToolExecutionContext>) -> ToolResult {
        let file_path = match input.get("file_path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolResult::Error("Missing file_path".into()),
        };

        let content = match input.get("content").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => return ToolResult::Error("Missing content".into()),
        };

        // 对于新文件，父目录可能不存在，需要特殊处理路径解析
        let raw_path = Path::new(file_path);
        let resolved = if raw_path.is_absolute() {
            raw_path.to_path_buf()
        } else {
            self.workdir.join(raw_path)
        };

        // 检查父目录是否存在
        let parent = resolved.parent().unwrap_or_else(|| Path::new("."));
        if !parent.exists() {
            return ToolResult::Error(format!("Parent directory does not exist: {}", parent.display()));
        }

        // 对已存在的父目录做 canonicalize 以验证路径安全
        let canonical_parent = match parent.canonicalize() {
            Ok(p) => p,
            Err(e) => {
                return ToolResult::Error(format!("Invalid parent path: {e}"))
            }
        };

        // 对 workdir 做 canonicalize 以确保比较基准一致
        let workdir_canonical = match self.workdir.canonicalize() {
            Ok(p) => p,
            Err(e) => {
                return ToolResult::Error(format!("Invalid workdir: {e}"))
            }
        };

        if !canonical_parent.starts_with(&workdir_canonical) {
            return ToolResult::Error("Path outside working directory".into());
        }

        let file_name = match resolved.file_name() {
            Some(name) => name,
            None => {
                return ToolResult::Error("Invalid file path: no file name component".into())
            }
        };
        let final_path = canonical_parent.join(file_name);

        match tokio::fs::write(&final_path, content).await {
            Ok(_) => ToolResult::Text("ok".into()),
            Err(e) => ToolResult::Error(format!("Error writing file: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn make_tool(workdir: &std::path::Path) -> WriteTool {
        WriteTool::new(workdir.to_path_buf())
    }

    #[tokio::test]
    async fn test_write_creates_file() {
        let dir = tempdir().unwrap();
        let tool = make_tool(dir.path());

        let result = tool
            .call(serde_json::json!({
                "file_path": "new_file.txt",
                "content": "hello world"
            }), None)
            .await;

        assert!(matches!(result, ToolResult::Text(_)));
        let output = match &result { ToolResult::Text(s) => s, _ => unreachable!() };
        assert_eq!(output, "ok");

        let written = std::fs::read_to_string(dir.path().join("new_file.txt")).unwrap();
        assert_eq!(written, "hello world");
    }

    #[tokio::test]
    async fn test_write_overwrites_existing() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("existing.txt");
        std::fs::write(&file, "old content").unwrap();

        let tool = make_tool(dir.path());
        let result = tool
            .call(serde_json::json!({
                "file_path": "existing.txt",
                "content": "new content"
            }), None)
            .await;

        assert!(matches!(result, ToolResult::Text(_)));
        let output = match &result { ToolResult::Text(s) => s, _ => unreachable!() };
        assert_eq!(output, "ok");

        let written = std::fs::read_to_string(&file).unwrap();
        assert_eq!(written, "new content");
    }

    #[tokio::test]
    async fn test_write_parent_dir_not_exist() {
        let dir = tempdir().unwrap();
        let tool = make_tool(dir.path());

        let result = tool
            .call(serde_json::json!({
                "file_path": "nonexistent_dir/file.txt",
                "content": "test"
            }), None)
            .await;

        assert!(matches!(result, ToolResult::Error(_)));
        let output = match &result { ToolResult::Error(s) => s, _ => unreachable!() };
        assert!(output.contains("Parent directory does not exist"));
    }

    #[tokio::test]
    async fn test_write_path_traversal_blocked() {
        let dir = tempdir().unwrap();
        let tool = make_tool(dir.path());

        let result = tool
            .call(serde_json::json!({
                "file_path": "/etc/test_write.txt",
                "content": "should not write"
            }), None)
            .await;

        assert!(matches!(result, ToolResult::Error(_)));
    }
}
