---
verdict: pass
---

# Extension User Install & Settings

## Background

xyz-agent 目前支持 pi extension（goal、todo、workflow 等）作为 **built-in** 功能，通过 npm `dependencies` 自动安装、`ExtensionResolver` 白名单自动发现。但缺乏**用户自行安装第三方 extension** 的能力——用户无法安装 `pi-ask-user`、`pi-interactive-shell` 等社区扩展。

同时 `ExtensionService` 使用了与 `ExtensionResolver` 脱节的独立状态模型（`~/.xyz-agent/extensions/extension-state.json`），需要统一。

## Functional Requirements

### FR-1: 用户安装 extension
用户在 Settings → Extensions 页面输入 npm 包名（`npm:pi-ask-user`），系统安装后生效。

npm 安装目录初始化：
```
~/.xyz-agent/pi/agent/npm/
  package.json    ← 如果不存在，安装前自动创建：{"private":true}
  node_modules/   ← npm install 自动创建
```

安装命令：
```
npm install <name> --prefix ~/.xyz-agent/pi/agent/npm/ --omit=peer
```

### FR-2: 卸载 extension
用户卸载已安装的 user-installed extension，删除 npm 包及配置。

### FR-3: 启用/禁用 extension
已安装的 extension 可以切换启用/禁用。禁用不删除 npm 包，只跳过扫描。

### FR-4: ExtensionResolver settings 扫描源
新增第 5 个扫描源 `settings`，读取 `~/.xyz-agent/pi/agent/settings.json` 的 `packages[]`，定位 `npm/` 目录下的实体。
优先级顺序（升序 = 低优先级先被覆盖）：
```
sources.push({ source: 'bundled', ... })        // 最低
sources.push({ source: 'third-party', ... })
sources.push({ source: 'settings', ... })         // 新增
if (userExtPaths.length > 0)
  sources.push({ source: 'user', ... })
sources.push({ source: 'npm', ... })              // 最高（built-in）
```
与现有 `PRIORITY_ORDER = ['npm', 'user', 'third-party', 'bundled']` 一致，`settings` 插入到 `third-party` 与 `user` 之间：
`['npm', 'user', 'settings', 'third-party', 'bundled']`。

### FR-5: ExtensionService 重写
重写 `ExtensionService`，新接口契约如下：

```typescript
interface IExtensionService {
  /** 用 ExtensionResolver 扫描所有源，返回 ExtensionInfo[]，
   *  对 settings 源的扩展读取 packages[] 判断启用状态 */
  scanExtensions(): Promise<ExtensionInfo[]>
  /** 返回启用的 extension 路径列表（供 pi --extension 参数使用）*/
  getExtensionPaths(): Promise<string[]>
  /** 安装 npm 包 → 写入 settings.json packages[] → 刷新 */
  installExtension(source: string): Promise<void>
  /** 从 settings.json packages[] 移除 → npm uninstall → 刷新 */
  uninstallExtension(name: string): Promise<void>
  /** 切换 packages[] 中某个包的启用/禁用 */
  toggleExtension(name: string, enabled: boolean): Promise<void>
}
```

关键集成点：
- `session-service.ts` 的 `getExtensionPaths()` 只能存在一条调用链——通过 `ExtensionService` 间接调用 `ExtensionResolver`。**禁止**在 session-service 中同时直调 `ExtensionResolver.resolve()` 和 `ExtensionService.getExtensionPaths()`，否则 extension 路径会重复传给 pi 子进程。
  - 当前正确：session-service 的 `getExtensionPaths()` 已使用 `ExtensionResolver` 做发现，然后拼接 `userExtPaths`
  - 新实现：`ExtensionService.getExtensionPaths()` 封装 `ExtensionResolver.resolve()` + 过滤禁用项 + 追加文件型 extension（`xyz-agent-extension.js`），session-service 只调 `ExtensionService.getExtensionPaths()`

文件型 extension（`xyz-agent-extension.js`）的处理：`ExtensionService.getExtensionPaths()` 在 `ExtensionResolver.resolve()` 返回后，读取 `xyz-agent-extension.js` 的路径（与当前逻辑一致：打包模式 `Resources/xyz-agent-extension.js`，开发模式 repo 根目录），检查文件是否存在，存在则 `result.extensionDirs.push(filePath)`。这发生在所有 resolver 扫描之后，不经过去重/过滤。
- 旧的 `~/.xyz-agent/extensions/extension-state.json` 直接废弃，不迁移（从未有实际数据）

### FR-6: WS 协议扩展
新增 `extension.install` / `extension.uninstall` 客户端消息类型，以及对应的服务端结果响应。

已有的消息（保持不动）：
- `extension.list` → `config.extensions`（获取列表）
- `extension.toggle` → `config.extensions`（切换启用状态）

新增：
- `{ type: 'extension.install', payload: { source: string } }` → 服务器执行安装后返回 `config.extensions`
- `{ type: 'extension.uninstall', payload: { name: string } }` → 服务器执行卸载后返回 `config.extensions`

（安装/卸载结果通过 `config.extensions` 回传，不需要额外结果类型——前端靠收到最新列表来确认操作完成）

### FR-7: ExtensionInfo 标识来源
`ExtensionInfo` 增加 `source` 字段，类型为 `'built-in' | 'user-installed'`。
- `built-in`：来自 npm `dependencies`（如 `@zhushanwen/pi-*`、`pi-subagents`）或 `xyz-agent-extension.js`
- `user-installed`：来自 `settings.json` 的 `packages[]`

`scanExtensions()` 的判断逻辑：ExtensionResolver 扫描结果中，路径出现在 settings packages[] 的 → `user-installed`；其余 → `built-in`。

### FR-8: Extension 安装信息隔离
- user-installed extension 安装到 `~/.xyz-agent/pi/agent/npm/node_modules/`（而非 `~/.xyz-agent/extensions/`）
- 配置写入 `~/.xyz-agent/pi/agent/settings.json` 的 `packages[]`
- 禁用状态写入 `~/.xyz-agent/pi/agent/disabled-packages.json`（独立文件，格式：`{ "disabled": ["pkg-name"] }`），与 pi 的 settings.json schema 解耦

## Acceptance Criteria

### AC-1（安装）
用户在 ExtensionsPane 输入 `npm:pi-ask-user` → 点击安装 → sidecar 执行 npm install 并写 settings.json → 列表刷新显示新 extension → 新 session 自动加载

### AC-2（卸载）
用户点击 user-installed extension 的"卸载" → 确认对话框 → sidecar 执行 npm uninstall 并清理 settings.json → 列表刷新移除该项

### AC-3（启用/禁用）
user-installed extension 的 toggle switch 切换 → sidecar 更新 `~/.xyz-agent/pi/agent/disabled-packages.json` → 列表刷新 → 新 session 跳过禁用的 extension

### AC-4（source 标识）
`ExtensionsPane` 列表中的每行明确显示 `built-in` 或 `user-installed`。built-in 不显示卸载按钮。

### AC-5（内置不可卸载/不可禁用）
`@zhushanwen/pi-*` 和 `pi-subagents` 在列表中显示 `built-in` 标注，toggle 为禁用/灰色状态，不可卸载。

### AC-6（安装失败处理）
npm install 失败 → 返回错误消息提示。安装的包不是有效 pi extension → 尝试 npm uninstall 回滚 + 提示"不是有效的 pi extension"。

回滚的保护：如果 npm uninstall 也失败（如包已损坏），记录 warning 日志，不清除磁盘文件，只从 settings.json packages[] 中移除条目。用户可手动清理 `~/.xyz-agent/pi/agent/npm/node_modules/`。

### AC-7（设置隔离）
`settings.json` 的 `packages[]` 只管理 user-installed extension。built-in extension 由 package.json `dependencies` 管理。

### AC-8（新会话生效）
安装/卸载/切换启用只影响新创建的 session（用户点击 New Chat 时创建的 pi 子进程）。已有 session 的 pi 子进程在启动时已加载完 extension 列表，不受影响。

## Constraints

### C-1: `~/.xyz-agent/` 数据隔离
所有配置和 npm 安装必须使用 `~/.xyz-agent/pi/agent/` 路径，禁止读写 `~/.pi/`。

### C-2: npm 仅支持
安装源仅支持 `npm:<pkg>` 格式。不支持 git、本地路径、registry 搜索。

### C-3: 批量限制
Settings UI 不支持批量安装/卸载，一次一个。

### C-4: isValidPiExtension 校验
安装后必须验证包是否为有效的 pi extension，满足任意一项即通过：
- `keywords` 包含 `'pi-package'`
- `peerDependencies` 包含 `pi-coding-agent` 或 `pi-agent-core`（任意 scope 均可）
- package.json 中有 `"pi"` manifest 字段

## 业务用例

> 纯技术性需求，无业务用例。

## Decisions

### D-1: packages[] 镜像 pi 原生格式
`packages[]` 格式与 pi 一致（字符串 `"npm:xxx"`）。
`disabled-packages.json` 独立文件存储启用/禁用状态，不污染 pi 的 settings.json schema。

### D-2: ExtensionResolver 优先级
settings（用户安装）< npm（built-in），避免用户包覆盖系统包。

### D-3: 安装失败回滚
npm install 成功但 `isValidPiExtension` 失败 → 执行 npm uninstall 回滚，确保磁盘无残留。

### D-4: ExtensionService 重写
废弃旧的 `ExtensionService`（扫描 `~/.xyz-agent/extensions/` + `extension-state.json`）。新的 `ExtensionService` 使用 `ExtensionResolver` 做发现 + `settings.json` 做状态管理。

## Complexity Assessment

| 维度 | 评估 |
|------|------|
| 新增代码 | ~600 lines（protocol + ExtensionService + ExtensionResolver + server.ts + frontend） |
| 修改文件 | ~10 files |
| 风险等级 | Low（独立模块、边界清晰、不影响现有 session） |
