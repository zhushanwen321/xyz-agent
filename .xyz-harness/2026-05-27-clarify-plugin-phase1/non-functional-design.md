---
verdict: pass
---

# Non-Functional Design — 插件系统 Phase 1

## 1. 稳定性

Worker Thread 隔离确保单个插件崩溃不会拖垮 Sidecar 主进程。每个 untrusted 插件独占 Worker，crash 只影响自身；trusted 插件共享 Worker，crash 会触发整组重建（自动恢复），不阻塞主线程。PluginStorage 的原子写入（temp + rename）保证数据不会因 crash 而损坏。关闭流程中 5s 超时强制 terminate 确保不会卡死。

**风险缓解**：Phase 1 的 Electron 环境冒烟测试（spec Risks §2）会在真实环境中验证 Worker 行为。Node.js Worker Thread 是成熟 API，与 Electron 兼容性风险可控。

## 2. 数据一致性

PluginStorage 每个插件独立 JSON 文件 + 独立内存缓存 + 独立 debounce timer，多插件并发写互不干扰。500ms debounce 窗口内，多次 set() 只触发一次磁盘写入，避免高频写入的 IO 开销。原子写入（writeFile(temp) + rename）确保 crash 时要么是旧数据要么是新数据，不会出现半写状态。

**workspaceState 隔离**：基于 cwd hash 的路径映射，不同项目目录的 workspace 状态完全隔离，不会串数据。

## 3. 性能

PluginRegistry.scan() 在 initialize() 时执行一次，结果缓存在 Map 中。后续 getDescriptor() 是 O(1) 查找，无 IO。插件目录通常 <50 个，扫描耗时 <100ms，不影响启动速度。

JSON-RPC 通信使用 structuredClone 序列化，单次 RPC 往返约 0.1-1ms（本地 MessagePort，无网络开销）。PluginStorage 的 1MB 单值限制和 10MB 总量限制确保序列化不会成为瓶颈。

**资源监控**：每 30s 采样 Worker 内存（trusted 256MB / sandbox 128MB 阈值），仅 warn 不 kill，避免误判。

## 4. 业务安全

Phase 1 不涉及权限检查和 Worker 沙箱（Phase 2 范围）。当前所有插件以 Node.js Worker Thread 的默认权限运行。trustLevel 字段已在 manifest 中声明但 Phase 1 不强制执行——仅用于 Worker 分组（trusted 共享 vs sandbox 独占）。

**理由**：Phase 1 的目标是让插件能跑起来，建立完整的生命周期链路。安全模型在 Phase 2 基于已验证的生命周期基础设施构建，避免过早引入复杂度。

## 5. 数据安全

插件数据存储在 `~/.xyz-agent/plugins/<pluginId>/data/` 下，与用户主目录隔离。PluginStorage 不存储敏感信息（API key 等），仅用于插件配置和状态。数据文件权限遵循 umask 默认值。

**不适用维度**：Phase 1 不涉及网络传输（无 marketplace、无远程 registry），不存在传输层安全问题。插件安装目前仅支持手动复制目录到 `~/.xyz-agent/plugins/`，无自动下载。
