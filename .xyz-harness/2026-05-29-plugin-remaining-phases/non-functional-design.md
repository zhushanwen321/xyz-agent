---
verdict: pass
---

# Non-Functional Design — Plugin Remaining Phases

## 1. 稳定性

**风险**：FR-8 Hook 桥接在 event-adapter 的同步翻译流程中插入异步 hook 调用，可能改变消息流的时序。

**缓解**：hook 调用使用 try-catch 包裹，任何异常/超时（5s）均视为放行。消息流不会因 hook 失败而中断。onPiEvent 广播使用 fire-and-forget 模式，不阻塞事件翻译。

**Worker crash 重建**：5s 冷却期 + 3 次上限，防止 crash loop 消耗资源。重建失败不触发新重建（计数器累加）。

## 2. 数据一致性

**SessionData 持久化**：使用 atomic write（write-to-temp + rename）保证并发安全。flush 由 PluginService 内部定时器串行触发，不会并发写入同一 session 文件。

**Agent API 读己之写**：`setModel` 写入 IConfigService 后立即生效，`getModel` 读取同一 configService 实例。无缓存层，读己之写一致性天然保证。

**权限状态**：权限审批通过 `plugin.approvePermissions` WS 消息原子更新，审批前激活流程阻塞（Promise pending），不存在半激活状态。

## 3. 性能

**findFiles**：使用 fast-glob（Rust 实现的 glob 库），大型项目（>10k 文件）搜索延迟 < 500ms。1000 条结果截断防止大量数据通过 RPC 传输。

**SessionData flush**：5s 定时批量 flush，不是每次 set 都写磁盘。内存操作延迟 < 1ms，flush 操作不影响 API 响应时间。

**Hook 执行**：串行执行每个 handler，单 handler 超时 5s。典型场景（1-2 个 handler）增加 < 100ms 延迟。

## 4. 业务安全

**插件权限模型不变**：sandbox 插件受 PermissionChecker 约束，权限审批后才能访问对应 API。trusted 插件（built-in）不受限制，与现有行为一致。

**UI 弹窗用户可控**：用户可以选择取消/忽略弹窗（60s 超时自动关闭）。插件不能强制用户交互。pending request 排队机制防止弹窗轰炸。

**Hook 拦截可审计**：`blocked` 和 `transformedContent` 变更在 session 历史中可见（transformedContent 替换原始 content 发送给 pi）。

## 5. 数据安全

**SessionData 文件**：存储在 `~/.xyz-agent/plugins/session-data/`，与应用数据目录隔离。10MB 单文件上限防止单个插件占用过多磁盘。

**UI 弹窗 WS 消息**：`plugin:uiRequest` 和 `plugin.uiResponse` 通过已有 WS 连接传输（localhost），不暴露到网络。requestId 防止响应伪造（随机生成 UUID）。

**findFiles 搜索范围**：限定在 `process.cwd()`（项目目录）内，自动忽略 `.git` 和 `node_modules`。插件不能搜索项目外文件。
