use std::path::PathBuf;

use async_trait::async_trait;
use serde_json;

use crate::engine::tools::{Tool, ToolResult, ToolExecutionContext};

#[cfg(test)]
const FALLBACK_MAX_OUTPUT_BYTES: usize = 100_000;
#[cfg(test)]
const FALLBACK_TIMEOUT_SECS: u64 = 120;

pub struct BashTool {
    workdir: PathBuf,
    default_timeout_secs: u64,
    max_output_bytes: usize,
}

impl BashTool {
    pub fn new(workdir: PathBuf, default_timeout_secs: u64, max_output_bytes: usize) -> Self {
        Self { workdir, default_timeout_secs, max_output_bytes }
    }
}

#[async_trait]
impl Tool for BashTool {
    fn name(&self) -> &str {
        "Bash"
    }

    fn description(&self) -> &str {
        "Execute a shell command and return stdout/stderr.\n\
         \n\
         Working directory persists between calls, but shell state (env vars, aliases) does not.\n\
         \n\
         IMPORTANT: Avoid using this tool to run cat, head, tail, sed, awk, or echo commands \n\
         when a dedicated tool can accomplish the task. Instead, use:\n\
         - File reading: Use Read (NOT cat/head/tail)\n\
         - File writing: Use Write (NOT echo >/cat <<EOF)\n\
         \n\
         When issuing multiple commands:\n\
         - If commands are independent, make multiple Bash calls in parallel.\n\
         - If commands depend on each other, chain with && in a single call.\n\
         - Use ; only when you don't care if earlier commands fail.\n\
         \n\
         Additional rules:\n\
         - Always quote file paths containing spaces with double quotes.\n\
         - Prefer absolute paths to avoid working directory confusion.\n\
         - If creating new files/directories, first run ls to verify the parent directory exists."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to execute. Chain dependent commands with &&. Quote file paths containing spaces with double quotes."
                },
                "timeout": {
                    "type": "integer",
                    "description": "Timeout in seconds. Default: 120, max: 600."
                },
                "workdir": {
                    "type": "string",
                    "description": "Override working directory. Default: project root."
                }
            },
            "required": ["command"]
        })
    }

    fn is_concurrent_safe(&self) -> bool {
        false
    }

    fn timeout_secs(&self) -> u64 {
        // executor 层超时 = 工具默认超时 + 60s 余量，避免与内部超时冲突
        self.default_timeout_secs.saturating_add(60)
    }

    async fn call(&self, input: serde_json::Value, _ctx: Option<&ToolExecutionContext>) -> ToolResult {
        let command = match input.get("command").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => return ToolResult::Error("Missing command".into()),
        };

        let timeout = input
            .get("timeout")
            .and_then(|v| v.as_u64())
            .unwrap_or(self.default_timeout_secs);

        // Fix 1: Validate workdir parameter to ensure it's within the tool's base workdir
        // Canonicalize base workdir once for comparison (handles symlinks)
        let base_workdir = match self.workdir.canonicalize() {
            Ok(p) => p,
            Err(e) => return ToolResult::Error(format!("Invalid base workdir: {e}")),
        };

        let cmd_workdir = if let Some(custom_dir) = input.get("workdir").and_then(|v| v.as_str()) {
            let resolved = if std::path::Path::new(custom_dir).is_absolute() {
                PathBuf::from(custom_dir)
            } else {
                self.workdir.join(custom_dir)
            };
            let canonical = match resolved.canonicalize() {
                Ok(p) => p,
                Err(e) => return ToolResult::Error(format!("Invalid workdir: {e}")),
            };
            if !canonical.starts_with(&base_workdir) {
                return ToolResult::Error("workdir must be within the project directory".into());
            }
            canonical
        } else {
            self.workdir.clone()
        };

        // Fix 2: Spawn first so we can kill on timeout, then use tokio::select!
        let mut child = match tokio::process::Command::new("bash")
            .arg("-c")
            .arg(command)
            .current_dir(&cmd_workdir)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                return ToolResult::Error(format!("Failed to spawn command: {e}"))
            }
        };

        // Use tokio::select! to race between command completion and timeout
        tokio::select! {
            // Wait for the child process to complete and get its output
            result = async {
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();

                // Manually read stdout and stderr while process is running
                if let Some(mut stdout_child) = child.stdout.take() {
                    let _ = tokio::io::copy(&mut stdout_child, &mut stdout).await;
                }
                if let Some(mut stderr_child) = child.stderr.take() {
                    let _ = tokio::io::copy(&mut stderr_child, &mut stderr).await;
                }

                // Wait for process to exit
                let status = child.wait().await?;
                Ok::<_, std::io::Error>((status, stdout, stderr))
            } => {
                match result {
                    Ok((status, stdout, stderr)) => {
                        let output = std::process::Output {
                            status,
                            stdout,
                            stderr,
                        };
                        process_output(output, self.max_output_bytes)
                    }
                    Err(e) => ToolResult::Error(format!("Error waiting for command: {e}"))
                }
            }
            // Timeout branch - kill the child process
            _ = tokio::time::sleep(std::time::Duration::from_secs(timeout)) => {
                let _ = child.kill().await;
                ToolResult::Error(format!("Command timed out after {timeout}s"))
            }
        }
    }
}

fn process_output(output: std::process::Output, max_output_bytes: usize) -> ToolResult {

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

    if combined.len() > max_output_bytes {
        combined.truncate(max_output_bytes);
        combined.push_str("\n[truncated]");
    }

    if exit_code != 0 {
        ToolResult::Error(format!("Exit code: {exit_code}\n{combined}"))
    } else {
        ToolResult::Text(combined)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn make_tool(workdir: &std::path::Path) -> BashTool {
        BashTool::new(workdir.to_path_buf(), FALLBACK_TIMEOUT_SECS, FALLBACK_MAX_OUTPUT_BYTES)
    }

    #[tokio::test]
    async fn test_bash_echo() {
        let dir = tempdir().unwrap();
        let tool = make_tool(dir.path());

        let result = tool
            .call(serde_json::json!({"command": "echo hello"}), None)
            .await;

        assert!(matches!(result, ToolResult::Text(_)));
        let output = match &result { ToolResult::Text(s) => s, _ => unreachable!() };
        assert!(output.contains("hello"));
    }

    #[tokio::test]
    async fn test_bash_exit_code_nonzero() {
        let dir = tempdir().unwrap();
        let tool = make_tool(dir.path());

        let result = tool
            .call(serde_json::json!({"command": "exit 42"}), None)
            .await;

        assert!(matches!(result, ToolResult::Error(_)));
        let output = match &result { ToolResult::Error(s) => s, _ => unreachable!() };
        assert!(output.contains("Exit code: 42"));
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
            }), None)
            .await;

        assert!(matches!(result, ToolResult::Error(_)));
        let output = match &result { ToolResult::Error(s) => s, _ => unreachable!() };
        assert!(output.contains("timed out"));
    }

    #[tokio::test]
    async fn test_bash_output_truncated() {
        let dir = tempdir().unwrap();
        let tool = make_tool(dir.path());

        // 生成约 200KB 的输出
        let result = tool
            .call(serde_json::json!({"command": "python3 -c \"print('x'*200000)\""}), None)
            .await;

        // python3 可能不存在，如果是这种情况跳过
        if let ToolResult::Error(output) = &result {
            if output.contains("python3") {
                return;
            }
        }

        assert!(matches!(result, ToolResult::Text(_)));
        let output = match &result { ToolResult::Text(s) => s, _ => unreachable!() };
        assert!(output.contains("[truncated]"));
        assert!(output.len() <= FALLBACK_MAX_OUTPUT_BYTES + 20);
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
            }), None)
            .await;

        if let ToolResult::Error(output) = &result {
            eprintln!("Error output: {}", output);
        }
        assert!(matches!(result, ToolResult::Text(_)));
        let output = match &result { ToolResult::Text(s) => s, _ => unreachable!() };
        assert!(output.contains("sub"));
    }

    #[tokio::test]
    async fn test_bash_workdir_escape_prevention() {
        let dir = tempdir().unwrap();
        let tool = make_tool(dir.path());

        // Try to escape using .. - should be rejected
        let result = tool
            .call(serde_json::json!({
                "command": "pwd",
                "workdir": "../.."
            }), None)
            .await;

        assert!(matches!(result, ToolResult::Error(_)));
        let output = match &result { ToolResult::Error(s) => s, _ => unreachable!() };
        assert!(output.contains("within the project directory"));
    }
}
