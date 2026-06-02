---
verdict: pass
---

# 非功能性设计 — 统一 Extension 消费架构

## 1. 稳定性

ExtensionResolver 的每个扫描方法（scanNpm/scanBundled/scanThirdParty/scanUser）都有独立的 try-catch，单个来源失败不影响其他来源。最终 `resolve()` 返回的是已去重的有效路径列表，缺失某些 extension 只导致功能降级（tool 不可用），不会阻塞 session 创建。这与现有的 `getExtensionPaths()` 行为一致（CLAUDE.md Rule #3：错误不阻塞 isGenerating 重置，同理 extension 加载错误不阻塞 session）。

## 2. 数据一致性

本次变更不涉及数据库或持久化状态。ExtensionResolver 是无状态的纯函数式扫描（每次 session 创建时重新扫描），不存在并发写入或缓存一致性问题。前端 Widget/Status 状态存储在 Vue reactive ref（Map），生命周期与 composable 绑定，组件卸载时自动清理。

## 3. 性能

ExtensionResolver 的扫描操作是同步的 `readdirSync` + `statSync` 调用，扫描范围是 4 个目录（每个通常 < 20 个条目）。耗时在毫秒级，远低于 pi 子进程启动时间（数百毫秒）。不引入性能瓶颈。setWidget/setStatus 事件的转发是内存操作（event-adapter → WS emit），与现有消息处理链路同级别。

## 4. 业务安全

pi-ext 包作为 npm dependencies 安装，版本由 `package.json` 的 semver 约束控制。第三方 extension 来自用户手动 clone 的本地路径，安全责任在用户。ExtensionResolver 不执行 extension 代码（只返回目录路径），代码执行由 pi 子进程负责。不存在 AI 行为指令注入的新风险（pi extension 本身就是代码执行环境，本次变更不改变这一模型）。

## 5. 数据安全

ExtensionResolver 扫描的路径（`node_modules/`、`resources/`、`~/.xyz-agent/`）都是本地文件系统路径，不涉及网络请求或敏感信息传输。setWidget/setStatus 事件的内容（widgetKey、lines、statusKey、text）由 pi extension 产出，经过 event-adapter 透传到前端，不经过持久化。与现有的 chat 消息流具有相同的安全边界。
