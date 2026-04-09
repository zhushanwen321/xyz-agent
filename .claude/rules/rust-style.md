# Rust 编码规范

## 测试

- 单元测试放在同文件 `#[cfg(test)] mod tests` 中
- 测试隔离：文件系统测试使用 `tempfile` crate
- 每个 service 模块的核心函数都应有对应测试

## 并发

- 使用 `tokio` 异步运行时
- LLM Provider trait 使用 `async-trait`
- 事件传递使用 `tokio::sync::mpsc::unbounded_channel`

## 序列化

- 枚举使用 `#[serde(tag = "type")]` 实现判别联合
- 变体重命名使用 `#[serde(rename = "snake_case")]`
- 所有持久化数据必须实现 `Serialize + Deserialize + Clone`
