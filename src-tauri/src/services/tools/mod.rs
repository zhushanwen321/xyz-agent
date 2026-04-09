pub mod read_tool;
pub mod write_tool;
pub mod bash_tool;

use crate::services::tool_registry::ToolRegistry;
use std::path::PathBuf;
use std::sync::Arc;

/// 注册所有内置工具到 registry。
pub fn register_builtin_tools(registry: &mut ToolRegistry, workdir: PathBuf) {
    registry.register(Arc::new(read_tool::ReadTool::new(workdir.clone())));
    registry.register(Arc::new(write_tool::WriteTool::new(workdir.clone())));
    registry.register(Arc::new(bash_tool::BashTool::new(workdir)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_register_all_builtin_tools() {
        let dir = tempdir().unwrap();
        let mut registry = ToolRegistry::new();
        register_builtin_tools(&mut registry, dir.path().to_path_buf());

        assert!(registry.get("Read").is_some());
        assert!(registry.get("Write").is_some());
        assert!(registry.get("Bash").is_some());
    }

    #[tokio::test]
    async fn test_builtin_tool_schemas_valid() {
        let dir = tempdir().unwrap();
        let mut registry = ToolRegistry::new();
        register_builtin_tools(&mut registry, dir.path().to_path_buf());

        for name in registry.tool_names() {
            let tool = registry.get(&name).unwrap();
            let schema = tool.input_schema();
            assert_eq!(schema["type"], "object");
        }
    }
}
