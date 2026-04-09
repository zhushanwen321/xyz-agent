use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json;

use crate::engine::tools::{Tool, ToolResult};

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
        "Write content to a file (creates or overwrites)"
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "file_path": { "type": "string" },
                "content": { "type": "string" }
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

    async fn call(&self, input: serde_json::Value) -> ToolResult {
        let file_path = match input.get("file_path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolResult { output: "Missing file_path".into(), is_error: true },
        };

        let content = match input.get("content").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => return ToolResult { output: "Missing content".into(), is_error: true },
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
            return ToolResult {
                output: format!("Parent directory does not exist: {}", parent.display()),
                is_error: true,
            };
        }

        // 对已存在的父目录做 canonicalize 以验证路径安全
        let canonical_parent = match parent.canonicalize() {
            Ok(p) => p,
            Err(e) => {
                return ToolResult {
                    output: format!("Invalid parent path: {e}"),
                    is_error: true,
                }
            }
        };

        // 对 workdir 做 canonicalize 以确保比较基准一致
        let workdir_canonical = match self.workdir.canonicalize() {
            Ok(p) => p,
            Err(e) => {
                return ToolResult {
                    output: format!("Invalid workdir: {e}"),
                    is_error: true,
                }
            }
        };

        if !canonical_parent.starts_with(&workdir_canonical) {
            return ToolResult {
                output: "Path outside working directory".into(),
                is_error: true,
            };
        }

        let file_name = match resolved.file_name() {
            Some(name) => name,
            None => {
                return ToolResult {
                    output: "Invalid file path: no file name component".into(),
                    is_error: true,
                }
            }
        };
        let final_path = canonical_parent.join(file_name);

        match tokio::fs::write(&final_path, content).await {
            Ok(_) => ToolResult { output: "ok".into(), is_error: false },
            Err(e) => ToolResult {
                output: format!("Error writing file: {e}"),
                is_error: true,
            },
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
            }))
            .await;

        assert!(!result.is_error);
        assert_eq!(result.output, "ok");

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
            }))
            .await;

        assert!(!result.is_error);
        assert_eq!(result.output, "ok");

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
            }))
            .await;

        assert!(result.is_error);
        assert!(result.output.contains("Parent directory does not exist"));
    }

    #[tokio::test]
    async fn test_write_path_traversal_blocked() {
        let dir = tempdir().unwrap();
        let tool = make_tool(dir.path());

        let result = tool
            .call(serde_json::json!({
                "file_path": "/etc/test_write.txt",
                "content": "should not write"
            }))
            .await;

        assert!(result.is_error);
    }
}
