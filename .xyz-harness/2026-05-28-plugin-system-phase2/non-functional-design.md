---
verdict: pass
---

# Non-Functional Design — Plugin System Phase 2

## 1. 稳定性

**风险点：** Bridge Extension 是单点——它崩溃会导致所有 plugin tool 不可用。

**缓解措施：** Bridge 设计为无状态中继层（不持有业务逻辑，只做消息转发）。连接状态机自动检测断连并重连（2s 间隔，最多 30 次）。Worker 崩溃时 PluginHost 自动重建 trusted Worker（最多 3 次后标记 CRASHED）。tool execute 请求自带超时（复用 extension_ui_request 的 5min 机制），防止无限挂起。

## 2. 数据一致性

**风险点：** sessionData 通过 bridge:append_entry 代理 pi.appendEntry()，存在 sidecar ↔ bridge 间的消息丢失风险。

**设计：** sessionData 在 Worker 内存中维护 mirror（Map<key, value>），每次 set 时先更新 mirror 再发 RPC。如果 bridge:append_entry 失败，mirror 中有最新值可用。session 恢复时从 pi session 文件读取 entry 恢复到 mirror。permissions.json 使用 atomic write（write-then-rename）防止写入中断导致文件损坏。

## 3. 性能

**关注点：** tool execute 经过 4 跳（pi → bridge → sidecar → Worker → 返回），延迟比原生 pi extension 高。

**评估：** 每跳是进程内通信（bridge↔sidecar 通过 extension_ui_request，sidecar↔Worker 通过 MessagePort），预计单次 tool execute 增加延迟 < 50ms（vs pi 内直接调用 < 5ms）。对 LLM tool call 的用户体验影响可忽略（LLM 单次推理通常 1-5s）。PluginRegistry 扫描只在启动时执行一次，不阻塞 UI。

## 4. 业务安全

**风险点：** sandbox 插件的 require 拦截可能被绕过（通过原型链修改或 eval）。

**设计：** sandbox 模式通过覆盖 `Module._resolveFilename` 实现（非 VM 模块）。这是 Node.js 社区的标准做法（如 Electron 的 sandbox），在 Worker Thread 中有效。eval/Function 构造在 sandbox 中也被拦截（bootstrap 脚本覆盖 global.eval 和 global.Function）。trusted 插件不做限制（等同 sidecar 权限）。Phase 2 不面向公共插件市场，安全模型以"开发者自知"为前提。

## 5. 数据安全

**风险点：** plugin 通过 api.sessions.sendMessage 可注入 system 消息到 LLM context，可能操纵 LLM 行为。

**设计：** sendMessage 需要 `sessions:sendMessage` 权限声明。sandbox 插件默认无此权限，需用户显式审批（PluginPermissionDialog）。built-in 和 trusted 插件自动拥有此权限（由 xyz-agent 自身分发，经过审计）。插件数据目录（`~/.xyz-agent/plugins/`）与 pi 数据目录完全隔离，不互相读写。
