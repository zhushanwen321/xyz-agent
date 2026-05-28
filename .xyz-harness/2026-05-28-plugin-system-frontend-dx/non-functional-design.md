---
verdict: pass
---

# Non-Functional Design — Plugin System Frontend + Quality

## 1. 稳定性

**改动影响**：handleBridgeToolExecute 和 executeHooks 是插件系统的核心路径。从 stub/fire-and-forget 改为真实的 RPC 路由和串行 await，引入了 Worker 崩溃传播和链式超时的风险。缓解措施：(1) 每个调用点都有独立的 try-catch，Worker 崩溃时返回 `isError: true` 而非抛异常；(2) executeHooks 单 Worker 超时 5s 视为放行，不会因为单个慢插件阻塞整个消息流；(3) 所有 RPC 调用有明确超时（tool 30s、hook 5s），不会永久挂起。

**热重载风险**：fs.watch + deactivate + activate 是非原子操作。如果 activate 失败（新代码有 bug），插件会停留在 crashed 状态。缓解：deactivate 使用 force terminate（5s 超时），activate 失败不影响其他插件。

## 2. 数据一致性

**sessionData 缓存**：引入内存缓存后，存在缓存与 pi session JSONL 文件不一致的窗口期（flush 间隔 5s 内）。这是可接受的 trade-off：读取走缓存（快），写入先缓存再异步 flush（最终一致）。如果 xyz-agent 进程在 flush 前崩溃，最多丢失 5s 的 sessionData 写入。插件 deactivate 时强制 flush，保证生命周期结束时的数据完整性。

**Plugin Store 状态**：前端 PluginStore 与后端 PluginService 之间通过 WS 推送保持同步。断连期间前端保持最后已知状态（乐观），重连后自动 `plugin.list` 刷新（最终一致）。不做 optimistic update（toggle 后不等响应直接更新 UI），因为插件激活/停用可能失败。

## 3. 性能

**executeHooks 串行化**：从 O(1) broadcast 改为 O(N) serial await，N 为注册该 hook 的插件数量。当前内置插件数量 ≤ 5，每个 Worker hook 执行通常 < 100ms，总延迟 < 500ms，可接受。如果未来插件数量增长到 20+，需要考虑分组并行（trusted 组串行，sandbox 组并行）。plan 中不实现此优化（YAGNI），但 executeHooks 的设计允许后续扩展。

**WS 消息量**：`plugin:statusBarUpdate` 和 `plugin:messageDecoration` 是高频推送事件。当前设计无节流，依赖 PluginService 在 Worker 侧控制推送频率。如果高频推送导致前端性能问题（如每秒 100+ decoration），需要在 server.ts 广播前加 throttle。

**热重载 debounce**：300ms 是标准值，足以合并同一文件的多次写入（编辑器保存时可能触发多次 fs.watch 事件）。

## 4. 业务安全

**插件权限系统**：sandbox 插件的权限审批是安全边界。UI 中权限对话框逐项展示权限描述，用户必须主动批准。built-in 插件自动 trusted，跳过权限审批。信任等级切换（sandbox → trusted）需要二次确认对话框，防止误操作提升权限。

**插件代码执行**：Worker Thread 提供进程级隔离（不同于 pi extension 的同一进程执行）。插件代码崩溃不会影响 sidecar 主进程或其他插件。PluginSandbox 限制 Worker 的 Node.js API 访问。

## 5. 数据安全

**插件存储隔离**：PluginStorage（`~/.xyz-agent/plugins/data/`）与 pi 数据目录（`~/.pi/`）完全隔离。插件无法访问 pi 的配置、session 文件或 extension 数据。这通过 PluginSandbox 的文件系统白名单实现。

**WS 消息安全**：所有 plugin WS 消息在 Electron 内部 WebSocket 通道传输（localhost only），不暴露到网络。消息 payload 不包含用户凭证，pluginId 是服务端分配的唯一标识。

**权限撤销**：用户可通过 PluginsPane 撤销已授予的权限（`plugin.revokePermissions`），立即生效。撤销后插件的后续权限检查会拒绝访问，已进行的操作不受影响（不回滚）。
