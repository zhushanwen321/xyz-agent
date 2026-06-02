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

### FR-2: 卸载 extension
用户卸载已安装的 user-installed extension，删除 npm 包及配置。

### FR-3: 启用/禁用 extension
已安装的 extension 可以切换启用/禁用。禁用不删除 npm 包，只跳过扫描。

### FR-4: ExtensionResolver settings 扫描源
新增第 5 个扫描源，读取 `~/.xyz-agent/pi/agent/settings.json` 的 `packages[]`，定位 `npm/` 目录下的实体。

### FR-5: ExtensionService 重构
废弃旧的 `~/.xyz-agent/extensions/extension-state.json` 模型，统一使用 settings.json 管理状态。

### FR-6: WS 协议扩展
新增 `extension.install` / `extension.uninstall` 消息类型，以及对应的结果响应。

### FR-7: ExtensionInfo 标识来源
`ExtensionInfo` 增加 `source` 字段，区分 `built-in` 和 `user-installed`。

### FR-8: Extension 安装信息隔离
- user-installed extension 安装到 `~/.xyz-agent/pi/agent/npm/node_modules/`（而非 `~/.xyz-agent/extensions/`）
- 配置写入 `~/.xyz-agent/pi/agent/settings.json` 的 `packages[]` 和 `disabledPackages[]`

## Acceptance Criteria

### AC-1（安装）
用户在 ExtensionsPane 输入 `npm:pi-ask-user` → 点击安装 → sidecar 执行 npm install 并写 settings.json → 列表刷新显示新 extension → 新 session 自动加载

### AC-2（卸载）
用户点击 user-installed extension 的"卸载" → 确认对话框 → sidecar 执行 npm uninstall 并清理 settings.json → 列表刷新移除该项

### AC-3（启用/禁用）
user-installed extension 的 toggle switch 切换 → sidecar 更新 `disabledPackages[]` → 列表刷新 → 新 session 跳过禁用的 extension

### AC-4（source 标识）
`ExtensionsPane` 列表中的每行明确显示 `built-in` 或 `user-installed`。built-in 不显示卸载按钮。

### AC-5（内置不可卸载）
`@zhushanwen/pi-*` 和 `pi-subagents` 在列表中显示 `built-in` 标注，toggle 可能允许关闭但不可卸载。

### AC-6（安装失败处理）
npm install 失败 → 返回错误消息提示。安装的包不是有效 pi extension → 回滚 npm install + 提示"不是有效的 pi extension"。

### AC-7（设置隔离）
`settings.json` 的 `packages[]` 只管理 user-installed extension。built-in extension 由 package.json `dependencies` 管理。

### AC-8（新会话生效）
安装/卸载/切换启用只影响新创建的 session。已有 session 不受影响。

## Constraints

### C-1: `~/.xyz-agent/` 数据隔离
所有配置和 npm 安装必须使用 `~/.xyz-agent/pi/agent/` 路径，禁止读写 `~/.pi/`。

### C-2: npm 仅支持
安装源仅支持 `npm:<pkg>` 格式。不支持 git、本地路径、registry 搜索。

### C-3: 批量限制
Settings UI 不支持批量安装/卸载，一次一个。

### C-4: isValidPiExtension 校验
安装后必须验证包是否为有效的 pi extension（`keywords` 含 `pi-package` 或 `peerDependencies` 含 `pi-coding-agent`/`pi-agent-core`）。

## 业务用例

> 纯技术性需求，无业务用例。

## Decisions

### D-1: settings.json 镜像 pi 原生格式
`packages[]` 和 `disabledPackages[]` 字段名与 pi 的 `settings.json` 一致，保持语义兼容。

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
