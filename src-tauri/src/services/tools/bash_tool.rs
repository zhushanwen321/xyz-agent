use std::path::PathBuf;

use async_trait::async_trait;
use serde_json;

use crate::services::tool_registry::{Tool, ToolResult};

const MAX_OUTPUT_BYTES: usize = 100_000;
const DEFAULT_TIMEOUT_SECS: u64 = 120;

pub struct BashTool {
    workdir: PathBuf,
}

impl BashTool {
    pub fn new(workdir: PathBuf) -> Self {
        Self { workdir }
    }
}

#[async_trait]
impl Tool for BashTool {
    fn name(&self) -> &str {
        "Bash"
    }

    fn description(&self) -> &str {
        "Execute a shell command"
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "command": { "type": "string" },
                "timeout": { "type": "integer" },
                "workdir": { "type": "string" }
            },
            "required": ["command"]
        })
    }

    fn is_concurrent_safe(&self) -> bool {
        false
    }

    fn timeout_secs(&self) -> u64 {
        DEFAULT_TIMEOUT_SECS
    }

    async fn call(&self, input: serde_json::Value) -> ToolResult {
        let command = match input.get("command").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => return ToolResult { output: "Missing command".into(), is_error: true },
        };

        let timeout = input
            .get("timeout")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_TIMEOUT_SECS);

        let workdir = input
            .get("workdir")
            .and_then(|v| v.as_str())
            .map(|d| {
                let p = std::path::Path::new(d);
                if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    self.workdir.join(p)
                }
            })
            .unwrap_or_else(|| self.workdir.clone());

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(timeout),
            run_command(&command, &workdir),
        )
        .await;

        match result {
            Ok(output) => output,
            Err(_) => ToolResult {
                output: format!("Command timed out after {timeout}s"),
                is_error: true,
            },
        }
    }
}

async fn run_command(command: &str, workdir: &std::path::Path) -> ToolResult {
    let child = match tokio::process::Command::new("bash")
        .arg("-c")
        .arg(command)
        .current_dir(workdir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return ToolResult {
                output: format!("Failed to spawn command: {e}"),
                is_error: true,
            }
        }
    };

    let output = match child.wait_with_output().await {
        Ok(o) => o,
        Err(e) => {
            return ToolResult {
                output: format!("Error waiting for command: {e}"),
                is_error: true,
            }
        }
    };

    let exit_code = output.status.code().unwrap_or(-1);
    // 合并 stdout 和 stderr
    let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.is_empty() {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(&stderr);
    }

    if combined.len() > MAX_OUTPUT_BYTES {
        combined.truncate(MAX_OUTPUT_BYTES);
        combined.push_str("\n[truncated]");
    }

    let is_error = exit_code != 0;
    if is_error {
        combined = format!("Exit code: {exit_code}\n{combined}");
    }

    ToolResult { output: combined, is_error }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn make_tool(workdir: &std::path::Path) -> BashTool {
        BashTool::new(workdir.to_path_buf())
    }

    #[tokio::test]
    async fn test_bash_echo() {
        let dir = tempdir().unwrap();
        let tool = make_tool(dir.path());

        let result = tool
            .call(serde_json::json!({"command": "echo hello"}))
            .await;

        assert!(!result.is_error);
        assert!(result.output.contains("hello"));
    }

    #[tokio::test]
    async fn test_bash_exit_code_nonzero() {
        let dir = tempdir().unwrap();
        let tool = make_tool(dir.path());

        let result = tool
            .call(serde_json::json!({"command": "exit 42"}))
            .await;

        assert!(result.is_error);
        assert!(result.output.contains("Exit code: 42"));
    }

    #[tokio::test]
    async fn test_bash_timeout() {
        let dir = tempdir().unwrap();
        let tool = make_tool(dir.path());

        // sleep 10 秒，但只给 1 秒超时
        let result = tool
            .call(serde_json::json!({
                "command": "sleep 10",
                "timeout": 1
            }))
            .await;

        assert!(result.is_error);
        assert!(result.output.contains("timed out"));
    }

    #[tokio::test]
    async fn test_bash_output_truncated() {
        let dir = tempdir().unwrap();
        let tool = make_tool(dir.path());

        // 生成约 200KB 的输出
        let result = tool
            .call(serde_json::json!({"command": "python3 -c \"print('x'*200000)\""}))
            .await;

        // python3 可能不存在，如果是这种情况跳过
        if result.is_error && result.output.contains("python3") {
            return;
        }

        assert!(!result.is_error);
        assert!(result.output.contains("[truncated]"));
        assert!(result.output.len() <= MAX_OUTPUT_BYTES + 20);
    }

    #[tokio::test]
    async fn test_bash_workdir_override() {
        let dir = tempdir().unwrap();
        let subdir = dir.path().join("sub");
        std::fs::create_dir(&subdir).unwrap();

        let tool = make_tool(dir.path());
        let result = tool
            .call(serde_json::json!({
                "command": "pwd",
                "workdir": "sub"
            }))
            .await;

        assert!(!result.is_error);
        assert!(result.output.contains("sub"));
    }
}
