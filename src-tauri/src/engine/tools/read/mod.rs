use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json;

use crate::engine::tools::{Tool, ToolResult};

#[cfg(test)]
const FALLBACK_MAX_OUTPUT_BYTES: usize = 100_000;

pub struct ReadTool {
    workdir: PathBuf,
    max_output_bytes: usize,
}

impl ReadTool {
    pub fn new(workdir: PathBuf, max_output_bytes: usize) -> Self {
        Self { workdir, max_output_bytes }
    }

    fn resolve_path(&self, file_path: &str) -> Result<PathBuf, String> {
        resolve_and_validate_path(&self.workdir, file_path)
    }
}

#[async_trait]
impl Tool for ReadTool {
    fn name(&self) -> &str {
        "Read"
    }

    fn description(&self) -> &str {
        "Read file contents with line numbers"
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "file_path": { "type": "string" },
                "offset": { "type": "integer" },
                "limit": { "type": "integer" }
            },
            "required": ["file_path"]
        })
    }

    fn is_concurrent_safe(&self) -> bool {
        true
    }

    fn timeout_secs(&self) -> u64 {
        10
    }

    async fn call(&self, input: serde_json::Value) -> ToolResult {
        let file_path = match input.get("file_path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolResult { output: "Missing file_path".into(), is_error: true },
        };

        let path = match self.resolve_path(file_path) {
            Ok(p) => p,
            Err(e) => return ToolResult { output: e, is_error: true },
        };

        let content = match tokio::fs::read_to_string(&path).await {
            Ok(c) => c,
            Err(e) => {
                return ToolResult {
                    output: format!("Error reading file: {e}"),
                    is_error: true,
                }
            }
        };

        let offset = input.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let limit = input.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);

        let lines: Vec<&str> = content.lines().collect();
        // offset 是 1-based，转为 0-based 索引
        let start = offset.saturating_sub(1).min(lines.len());
        let end = match limit {
            Some(l) => (start + l).min(lines.len()),
            None => lines.len(),
        };

        let mut output = String::new();
        for (i, line) in lines[start..end].iter().enumerate() {
            let line_num = start + i + 1;
            output.push_str(&format!("{:>6}\t{}\n", line_num, line));
        }

        if output.len() > self.max_output_bytes {
            output.truncate(self.max_output_bytes);
            output.push_str("\n[truncated]");
        }

        ToolResult { output, is_error: false }
    }
}

/// 解析路径并验证它在 workdir 内，防止路径穿越。
fn resolve_and_validate_path(workdir: &Path, file_path: &str) -> Result<PathBuf, String> {
    // canonicalize workdir 以确保与 resolved 路径的比较基准一致
    let workdir = workdir
        .canonicalize()
        .map_err(|e| format!("Invalid workdir: {e}"))?;

    let path = Path::new(file_path);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        workdir.join(path)
    };

    let canonical = resolved.canonicalize().or_else(|_| {
        // 文件不存在时，尝试对父目录做 canonicalize
        if let Some(parent) = resolved.parent() {
            parent
                .canonicalize()
                .map(|p| p.join(resolved.file_name().unwrap()))
        } else {
            Err(std::io::Error::new(std::io::ErrorKind::NotFound, "path not found"))
        }
    }).map_err(|e| format!("Invalid path: {e}"))?;

    if !canonical.starts_with(&workdir) {
        return Err("Path outside working directory".into());
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn make_tool(workdir: &std::path::Path) -> ReadTool {
        ReadTool::new(workdir.to_path_buf(), FALLBACK_MAX_OUTPUT_BYTES)
    }

    #[tokio::test]
    async fn test_read_file_with_line_numbers() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("test.txt");
        std::fs::write(&file, "hello\nworld\n").unwrap();

        let tool = make_tool(dir.path());
        let result = tool
            .call(serde_json::json!({"file_path": "test.txt"}))
            .await;

        assert!(!result.is_error);
        assert!(result.output.contains("     1\thello"));
        assert!(result.output.contains("     2\tworld"));
    }

    #[tokio::test]
    async fn test_read_file_offset_limit() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("test.txt");
        std::fs::write(&file, "line1\nline2\nline3\nline4\nline5\n").unwrap();

        let tool = make_tool(dir.path());
        let result = tool
            .call(serde_json::json!({"file_path": "test.txt", "offset": 2, "limit": 2}))
            .await;

        assert!(!result.is_error);
        assert!(result.output.contains("     2\tline2"));
        assert!(result.output.contains("     3\tline3"));
        assert!(!result.output.contains("line1"));
        assert!(!result.output.contains("line4"));
    }

    #[tokio::test]
    async fn test_read_nonexistent_file_returns_error() {
        let dir = tempdir().unwrap();
        let tool = make_tool(dir.path());
        let result = tool
            .call(serde_json::json!({"file_path": "nonexistent.txt"}))
            .await;

        assert!(result.is_error);
    }

    #[tokio::test]
    async fn test_read_large_file_truncated() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("large.txt");
        // 生成约 200KB 的文件（远超 100KB 限制）
        let content = "x".repeat(200);
        let big_content = content.lines().collect::<Vec<_>>().join("\n"); // 一行 200 字符
        let repeated = big_content.repeat(600); // ~120KB
        std::fs::write(&file, &repeated).unwrap();

        let tool = make_tool(dir.path());
        let result = tool
            .call(serde_json::json!({"file_path": "large.txt"}))
            .await;

        assert!(!result.is_error);
        assert!(result.output.ends_with("[truncated]"));
        assert!(result.output.len() <= FALLBACK_MAX_OUTPUT_BYTES + 20); // 允许少量余量
    }

    #[tokio::test]
    async fn test_read_path_traversal_blocked() {
        let dir = tempdir().unwrap();
        let tool = make_tool(dir.path());

        // 尝试读取 workdir 之外的文件
        let result = tool
            .call(serde_json::json!({"file_path": "../../etc/passwd"}))
            .await;

        assert!(result.is_error);
    }
}
