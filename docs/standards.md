# 编码规范与架构标准

## 文件持久化与运行时 Registry 同步

当系统同时存在**文件持久化**和**内存 Registry** 时，两者必须保持同步。文件是 source of truth，Registry 是运行时缓存。

### 适用场景

任何满足以下条件的模块：
- 数据以文件形式存储在 `~/.xyz-agent/` 目录下
- 运行时需要一个 HashMap/Registry 结构快速查找
- 通过 Tauri Command 支持增删改操作

当前实例：`AgentTemplateRegistry`（自定义 Agent）、`PromptRegistry`（用户 prompt）。

### 三条规则

**1. 启动时加载**

`lib.rs` 初始化 `AppState` 时，创建 Registry 并立即从 data_dir 加载：

```rust
agent_templates: {
    let mut reg = AgentTemplateRegistry::new();
    reg.load_custom_agents(&data_dir);
    Arc::new(std::sync::RwLock::new(reg))
},
```

**2. 写后刷新**

所有修改文件的 Tauri Command（save/delete），成功后必须刷新对应的 Registry：

```rust
// 文件写入成功后
if let Ok(mut reg) = state.agent_templates.write() {
    reg.load_custom_agents(&state.data_dir);
}
```

不要依赖"用户重启应用"来同步——运行时修改必须立即可用。

**3. 线程安全包装**

`AppState` 中的 Registry 使用 `Arc<StdRwLock<Registry>>`：
- 读操作（list/get/preview）：`state.registry.read()`
- 写操作（save/delete 后刷新）：`state.registry.write()`
- 在 RwLock 守卫作用域内**提前 clone 所需数据**，不要持有锁跨 `.await` 点

### 参考实现

- `engine/agent_template.rs`：`load_custom_agents()` + `remove_custom_agent()`
- `api/prompt_commands.rs`：`refresh_prompt_registry()` 辅助函数
- `engine/tools/dispatch_agent.rs`：RwLock 读锁 + 提前 clone 模式
