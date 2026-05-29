---
verdict: pass
---

# Business Use Cases — plugin-arch-remaining-and-ci-fix

## UC-1: 用户在 Settings 管理插件

**Actor:** 终端用户

**Preconditions:**
- xyz-agent 已启动
- 用户已打开 Settings 页面

**Main Flow:**
1. 用户在 Settings 侧栏看到 "Plugins" / "插件" tab（位于 Extensions 之前）
2. 用户点击 "Plugins" tab
3. 系统显示 PluginsPane 组件内容：已安装插件列表
4. 用户可以 Toggle 插件启用/禁用状态
5. 用户可以点击插件查看详情（权限、配置）

**Alternative/Exception Paths:**
- 无已安装插件 → PluginsPane 显示空状态提示
- 插件状态变更失败 → 显示错误提示

**Postconditions:**
- 用户成功导航到插件管理页
- 插件启用/禁用状态已更新

**Module Boundaries:**
- 前端: SettingsView.vue → tabs 路由 → PluginsPane.vue
- 状态: stores/plugin.ts（Pinia）
- 通信: composables/usePlugin.ts → ws-client → sidecar PluginService

**Spec AC 覆盖:** AC-1

---

## UC-2: LLM 调用插件注册的 Tool

**Actor:** AI Agent（通过 pi 引擎）

**Preconditions:**
- 一个插件已通过 `api.tools.register()` 注册了自定义 tool（含 execute handler）
- Plugin 已激活，Worker 正常运行
- LLM 生成了包含该 tool 调用的回复

**Main Flow:**
1. pi 引擎发送 tool execute 请求到 xyz-agent bridge
2. Bridge 层（PluginService.handleBridgeToolExecute）查找 toolRegistry 找到插件
3. PluginService 通过 rpcServer.invoke 向 Worker 发送 `{ type: 'rpc', request: { method: 'plugin.tool.execute', ... } }`
4. Worker 的 plugin-bootstrap.ts handleMessage 接收到 msg.request
5. handleIncomingRequest 按 toolKey 查找本地 toolHandlers Map
6. 执行插件的 execute handler
7. Worker 通过 parentPort 发送 `{ type: 'rpc', response: { jsonrpc: '2.0', id, result } }`
8. PluginHost 收到 response，rpcServer.handleResponse resolve Promise
9. PluginService 返回结果给 bridge → pi 引擎

**Alternative/Exception Paths:**
- Tool handler 未找到 → 返回 METHOD_NOT_FOUND error response（AC-2 覆盖）
- Handler 执行抛异常 → 返回 INTERNAL_ERROR error response（AC-2 覆盖）
- Handler 超时（30s）→ rpcServer invoke 超时 → PluginService 返回 timeout error
- Worker crash → getWorkerHandle 返回 undefined → PluginService 返回 "worker crashed" error

**Postconditions:**
- Tool 执行结果（成功或错误）返回给 pi 引擎
- toolRegistry 和 toolHandlers 状态一致

**Module Boundaries:**
- pi 进程 → Extension Bridge → PluginService（主线程）
- PluginService → PluginHost → Worker（rpcServer.invoke）
- Worker 内部: plugin-bootstrap.ts → toolHandlers Map → 插件 execute handler

**Spec AC 覆盖:** AC-2

---

## UC-3: Windows 用户正常构建

**Actor:** CI/CD 系统（GitHub Actions Windows runner）

**Preconditions:**
- 代码已推送到分支/PR
- CI workflow 触发

**Main Flow:**
1. Windows runner 执行 `prepare-pi-resources.sh`
2. 脚本下载 `pi-windows-x64.zip`，unzip 解压
3. 检测到 `pi.exe` 直接存在于根目录（无 `pi/` 子目录）
4. 将 `pi.exe` 重命名为 `pi-windows-x64.exe`
5. `chmod +x` 成功（Git Bash 环境）
6. 继续执行 extension-service 测试
7. 测试中 readFile mock 使用 `normalizePath()` 处理 `\` 分隔符
8. 所有 20 个测试通过

**Alternative/Exception Paths:**
- macOS/Linux 不受影响（仍走 tar.gz + `pi/` 目录分支）

**Postconditions:**
- Windows Build 的 pi 资源准备步骤成功
- Windows Build 的 extension-service 测试全通过

**Module Boundaries:**
- CI: `.github/workflows/release.yml` → `prepare-pi-resources.sh`
- 测试: `extension-service.test.ts` → mock `readFile` → `normalizePath`

**Spec AC 覆盖:** AC-3, AC-4, AC-5

---

## UC 覆盖映射表

| UC | 覆盖的 Spec AC |
|----|---------------|
| UC-1 | AC-1 |
| UC-2 | AC-2 |
| UC-3 | AC-3, AC-4, AC-5 |
