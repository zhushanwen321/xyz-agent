---
verdict: pass
must_fix: 0
---

# Integration Review — plugin-arch-remaining-and-ci-fix

## Integration Points Verified

### 1. RPC Response Routing (plugin-host.ts ↔ plugin-bootstrap.ts)

**问题（已修复）**: Worker 的 `postRpcResponse()` 发送 `{ type: 'rpc', response: RpcResponse }`（嵌套格式），但 plugin-host.ts 的 `worker.on('message')` 只检查扁平格式的 `msg.id`。

**修复**: 在 plugin-host.ts 中增加嵌套 response 格式检测（`rpcMsg.response && typeof rpcMsg.response.id !== 'undefined'`），优先于扁平格式检查。

**验证**: 修改后所有 342 runtime 测试通过，类型检查通过。

### 2. Tool Registration Sync (tool-api.ts ↔ plugin-bootstrap.ts)

- register: 先 RPC 注册 schema 到主线程，成功后存本地 handler — 顺序正确
- unregister: RPC 成功后清理本地 toolHandlers — 同步正确
- 新增 `unregisterToolHandler` export 与 `registerToolHandler` 对称

### 3. PluginsPane Tab Integration (SettingsView.vue)

- PluginsPane 已 export 自 settings/index.ts
- tab key='plugins' 在 tabs 数组中位于 system 和 extensions 之间
- v-show 独立匹配 `activeTab === 'plugins'`，不受数组位置影响
- i18n key `settings.tabPlugins` 在 zh-CN 和 en-US 中均已定义

### 4. CI Script (prepare-pi-resources.sh)

- elif 分支与 if 分支互斥，不影响 macOS/Linux 的 tar.gz 分支
- chmod +x 在 mv 之后执行，与其他分支行为一致

## Conclusion

所有集成点验证通过。关键修复（plugin-host.ts 嵌套 response 路由）解决了 invoke 响应被静默丢弃的问题。
