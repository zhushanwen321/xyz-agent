/// 工具执行结果 — 类型安全区分成功与错误
pub enum ToolResult {
    Text(String),
    Error(String),
}
