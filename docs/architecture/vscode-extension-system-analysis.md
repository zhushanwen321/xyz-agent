# VSCode 插件系统架构分析报告

## 1. Extension API 隔离模型

### 1.1 `vscode` Namespace 设计

VSCode 将所有扩展可用的 API 挂在一个全局 `vscode` namespace 下（类似 `import * as vscode from 'vscode'`）。这个 namespace 是 **唯一的 API 入口**，扩展无法直接 `require` VSCode 内部模块。

核心设计：

- **API 代理层（api.ts / extHost.api.impl.ts）**：VSCode 并不直接暴露内部实现。`vscode` namespace 中的每个对象（`window`、`workspace`、`commands` 等）都是通过 `extHost` 层的代理对象创建的。扩展拿到的 `vscode.window.createTerminal()` 实际上调用的是 `ExtHostTerminal` 的方法，后者再通过 RPC 转发到 Main Process。
- **闭包注入**：API 创建函数接受 `extensionRegistry`、`extHostRpc` 等内部依赖作为参数，返回一个冻结的 namespace 对象。扩展拿到的对象已经"烘焙"完毕，无法篡改或访问内部引用。
- **`Object.freeze`**：namespace 及其子对象被递归冻结，扩展无法 monkey-patch VSCode API。

### 1.2 API 稳定性策略

VSCode 将 API 分为三层：

| 层级 | 可见性 | 稳定性 | 用途 |
|------|--------|--------|------|
| **Stable API** | 所有扩展 | 向后兼容，breaking change 需 deprecation cycle | 公开 API，如 `vscode.window.showInformationMessage()` |
| **Proposed API** | 仅通过 `enableProposedApi` 白名单 | 随时可能变 | 实验性 API，VSCode 团队与特定扩展联调用 |
| **Internal API** | 不可见 | 无保证 | `vs/base/`、`vs/workbench/` 等内部模块，扩展无法访问 |

**关键约束**：
- Proposed API 不允许 Marketplace 上的扩展使用（CI 检查 `enableProposedApi` 标志）
- 新 API 通常先以 Proposed 形式存在 1-2 个迭代周期，收集反馈后"毕业"为 Stable
- VSCode 团队有一条不成文规则：**never break extensions**——即使是内部实现变更，也通过 shim 层保持兼容

### 1.3 对 xyz-agent 的启示

- **冻结的 API surface**：xyz-agent 应该提供类似的 `agentAPI` namespace，且必须是代理对象而非内部实现的直接引用
- **三层 API 策略**值得借鉴：stable（给第三方插件用）、proposed（给内部/联调插件用）、internal（仅核心模块）
- `Object.freeze` 防篡改是低成本高回报的防护

---

## 2. 进程模型

### 2.1 三进程架构

```
┌─────────────────────────────────────────────────────────┐
│                    Main Process                          │
│  - 窗口生命周期管理                                        │
│  - 文件系统访问（通过 Electron 的 Node.js）                 │
│  - IPC 消息路由                                           │
│  - Extension Host 进程管理                                │
└──────────┬──────────────────────┬───────────────────────┘
           │ IPC                  │ IPC
           ▼                      ▼
┌──────────────────────┐ ┌────────────────────────────────┐
│   Renderer Process   │ │    Extension Host Process       │
│  (Browser / Web)     │ │  (Node.js 独立进程)             │
│  - Workbench UI      │ │  - 运行所有 Extension 代码       │
│  - Monaco Editor     │ │  - 持有 vscode namespace 代理    │
│  - Terminal          │ │  - 文件系统 watcher              │
│                      │ │  - Language Server 客户端        │
└──────────────────────┘ └────────────────────────────────┘
           │
           │ SharedArrayBuffer / MessagePort
           ▼
┌──────────────────────┐
│    Shared Process     │
│  (Electron Utility)   │
│  - 进程间共享服务       │
│  - 文件搜索            │
│  - 全局状态存储         │
└──────────────────────┘
```

### 2.2 Extension Host 进程详解

- **独立 Node.js 进程**：Extension Host（简称 ExtHost）是一个独立的 Node.js 进程，通过 Electron的 `utilityProcess` 或 `fork()` 启动
- **单进程多扩展**：所有扩展运行在同一个 ExtHost 进程中（而非每个扩展一个进程）。这是一个关键取舍——减少了进程开销，但一个崩溃的扩展会拖死整个 ExtHost
- **Remote Extension Host**：在 WSL、SSH Remote、Codespaces 场景下，ExtHost 运行在远程机器上，通过 WebSocket + JSON-RPC 与本地通信

### 2.3 Web Extension Worker

- VSCode Web 版（vscode.dev / github.dev）中，扩展运行在 **Web Worker** 中而非 Node.js 进程
- Web Extension 只能使用浏览器 API 子集，不能访问文件系统、不能 spawn 子进程
- 这一层抽象让大部分扩展可以"写一次，跑两边"

### 2.4 对 xyz-agent 的启示

- **ExtHost 独立进程是核心隔离**：xyz-agent 的 sidecar 进程本质上已经扮演了类似角色。关键是 sidecar 中的插件应该运行在**隔离的 worker / 子进程**中，而非与 sidecar 主逻辑共享进程
- **单进程多插件 vs 隔离进程**：VSCode 的"所有扩展共享一个 ExtHost"是其稳定性痛点之一。xyz-agent 可以考虑更激进的隔离——每个插件一个 worker thread（开销可控），或者按信任等级分组
- **不需要 Shared Process**：xyz-agent 是单窗口应用，不需要 VSCode 那种多窗口共享的进程间服务

---

## 3. Extension 生命周期

### 3.1 activate / deactivate

```typescript
export function activate(context: ExtensionContext): void | Thenable<void>
export function deactivate?(): void | Thenable<void>
```

- `activate()` 是扩展的入口函数，在扩展首次被需要时调用（不是启动时）
- `deactivate()` 在扩展被禁用、卸载、或 VSCode 关闭时调用，用于清理资源
- `ExtensionContext` 提供 `subscriptions` 数组（ disposable 模式），扩展注册的资源（事件监听、文件 watcher 等）放入其中，deactivate 时自动 dispose
- `ExtensionContext` 还提供 `globalState` / `workspaceState`（KV 持久化）、`storageUri`（文件持久化）、`extensionUri`（扩展安装路径）

### 3.2 懒激活（Activation Events）

这是 VSCode 插件系统最重要的设计之一：**扩展不是启动时全部加载，而是按需激活**。

声明方式（`package.json`）：

```json
{
  "activationEvents": [
    "onLanguage:python",           // 打开 Python 文件时
    "onCommand:myExt.hello",       // 用户执行该命令时
    "onView:myExt.treeView",       // 对应 View 被展开时
    "onFileSystem:sftp",           // 访问该 scheme 的文件时
    "onDebug",                     // 调试会话开始时
    "onDebugInitialConfigurations",
    "onUri:myExt.auth",            // 打开特定 URI 时
    "onWebviewPanel:myExt.preview",// 恢复 webview 时
    "workspaceContains:**/.eslintrc.json", // 工作区包含匹配文件时
    "onStartupFinished"            // 所有启动完成后（最后的兜底）
  ]
}
```

**VSCode 1.74+ 的改进**：`activationEvents` 可以省略，VSCode 会根据 `contributes` 字段自动推断激活事件。例如 `contributes.commands` 中注册了命令，VSCode 自动添加对应的 `onCommand` 激活事件。

### 3.3 生命周期流程

```
VSCode 启动
  → 扫描所有已安装扩展的 package.json
  → 注册 declarative contributions（commands、views、languages 等）
  → 不加载任何扩展代码

用户触发 activation event（如打开 .py 文件）
  → 找到声明了 onLanguage:python 的扩展
  → require() 扩展入口模块
  → 调用 activate(context)
  → 扩展的 programmatic contributions 开始生效

用户禁用扩展 / VSCode 关闭
  → 调用 deactivate()
  → dispose 所有 subscriptions
```

### 3.4 对 xyz-agent 的启示

- **懒激活是必须的**：xyz-agent 的插件不能启动时全部加载。应该支持类似 `onCommand`、`onSlashCommand`、`onSessionCreate` 等激活事件
- **Disposables 模式**：`subscriptions` + 自动 dispose 是非常优雅的资源管理模式，xyz-agent 应该采用
- **自动推断激活事件**：从 manifest 的 `contributes` 推断 activation events 是很好的 DX 改进，减少样板配置
- **`ExtensionContext` 的 KV 存储**：`globalState` / `workspaceState` 是插件持久化状态的标准方式，值得提供

---

## 4. 扩展点体系（Contributions）

### 4.1 声明式 vs 编程式

VSCode 支持两种注册方式，且**声明式优先**：

#### 声明式（在 `package.json` 中）

```json
{
  "contributes": {
    "commands": [
      { "command": "myExt.hello", "title": "Say Hello" }
    ],
    "languages": [
      { "id": "python", "extensions": [".py"], "aliases": ["Python"] }
    ],
    "configuration": {
      "title": "My Extension",
      "properties": {
        "myExt.maxResults": {
          "type": "number",
          "default": 100,
          "description": "Maximum number of results"
        }
      }
    },
    "views": {
      "explorer": [
        { "id": "myExt.treeView", "name": "My View" }
      ]
    },
    "menus": {
      "commandPalette": [
        { "command": "myExt.hello", "when": "editorLangId == python" }
      ]
    }
  }
}
```

**声明式注册的优势**：
- 不需要加载扩展代码就能注册（VSCode 只读 `package.json`）
- 支持懒激活——用户看到命令/视图/语言支持，点击时才激活扩展
- VSCode 可以在扩展未安装时也显示 Marketplace 中的 contributes 信息
- 更容易做静态分析和 lint

#### 编程式（在 `activate()` 中）

```typescript
export function activate(context: ExtensionContext) {
  // 动态注册命令
  const cmd = vscode.commands.registerCommand('myExt.dynamicCmd', () => { ... });
  context.subscriptions.push(cmd);

  // 动态创建 TreeDataProvider
  const tree = vscode.window.registerTreeDataProvider('myExt.tree', provider);
  context.subscriptions.push(tree);

  // 动态注册 CodeLens Provider
  const lens = vscode.languages.registerCodeLensProvider(selector, provider);
  context.subscriptions.push(lens);
}
```

### 4.2 扩展点分类

| 类别 | 声明式 | 编程式 | 典型用途 |
|------|--------|--------|---------|
| Commands | ✓ | ✓ | 命令面板、快捷键绑定 |
| Views | ✓ | ✓ | 侧边栏面板、自定义视图 |
| Languages | ✓ | - | 语言支持（语法高亮、文件关联） |
| Debuggers | ✓ | - | 调试适配器注册 |
| Configuration | ✓ | - | Settings 贡献 |
| Themes | ✓ | - | 颜色主题、图标主题 |
| Keybindings | ✓ | - | 快捷键 |
| Menus | ✓ | - | 上下文菜单、命令面板过滤 |
| Grammars | ✓ | - | TextMate 语法 |
| Snippets | ✓ | - | 代码片段 |
| TreeDataProvider | - | ✓ | 动态树视图内容 |
| CodeLensProvider | - | ✓ | 内联代码操作 |
| CompletionItemProvider | - | ✓ | 自动补全 |
| WebviewPanel | - | ✓ | 自定义 UI 面板 |

### 4.3 对 xyz-agent 的启示

- **声明式优先**：xyz-agent 应该在 `package.json`（或类似的 manifest）中支持声明式注册以下扩展点：
  - `slashCommands`：自定义 slash 命令（`/search`、`/review` 等）
  - `tools`：AI Agent 可调用的工具
  - `panels`：侧边栏面板（类似 VSCode 的 views）
  - `settings`：插件配置项
  - `hooks`：事件钩子（消息发送前、代码生成后等）
- **编程式作为补充**：需要在 `activate()` 中动态注册的能力（如运行时才能确定的工具列表）
- **不需要 VSCode 那么多扩展点**：xyz-agent 不需要 Grammars、Snippets、Debuggers、Themes 这些编辑器特有的扩展点

---

## 5. Manifest（package.json）

### 5.1 必填字段

```json
{
  "name": "my-extension",           // 扩展 ID 的一部分（与 publisher 组成唯一 ID）
  "publisher": "myName",            // 发布者
  "version": "1.0.0",               // SemVer
  "engines": {
    "vscode": "^1.75.0"             // 兼容的 VSCode API 版本
  },
  "main": "./dist/extension.js",    // 入口文件（activate/deactivate 所在模块）
  "activationEvents": [],           // 激活事件（1.74+ 可省略，自动推断）
  "contributes": {}                 // 扩展点声明
}
```

### 5.2 关键可选字段

| 字段 | 用途 |
|------|------|
| `displayName` | Marketplace 显示名 |
| `description` | 扩展描述 |
| `categories` | Marketplace 分类（Programming Languages、Debuggers 等） |
| `keywords` | 搜索关键词 |
| `icon` | 扩展图标 |
| `extensionDependencies` | 依赖的其他扩展 ID |
| `extensionPack` | 扩展包（一组推荐扩展，不包含代码） |
| `enableProposedApi` | 启用实验性 API（需白名单） |
| `browser` | Web Extension 入口 |
| `contributes` | 扩展点声明（见第 4 节） |

### 5.3 版本兼容：`engines.vscode`

```json
"engines": { "vscode": "^1.75.0" }
```

- VSCode 使用 semver 约束，但 VSCode 本身没有 major version 变更（一直 1.x），所以实际是 **minor version 级别兼容**
- 扩展声明的 `engines.vscode` 决定了它可以使用哪些 API
- Marketplace 会根据用户安装的 VSCode 版本过滤不兼容的扩展

### 5.4 对 xyz-agent 的启示

- **复用 npm package.json 格式**：VSCode 直接复用 npm 的 `package.json`，这让扩展开发者无需学习新格式。xyz-agent 可以用同样的方式——扩展就是一个 npm 包，额外约定 `xyz-agent` 特有的字段
- **`engines` 兼容性声明**：xyz-agent 应该有 `engines.xyz-agent` 或类似字段，声明兼容的宿主版本
- **`extensionDependencies`**：插件间依赖关系值得支持，但初期可以简化为可选

---

## 6. 通信模型

### 6.1 IPC 架构

```
Extension Host                    Main Process                   Renderer
┌──────────────┐    JSON-RPC     ┌──────────────┐    DOM/IPC   ┌──────────────┐
│              │  ──────────────>│              │─────────────>│              │
│  Extension   │  <──────────────│   IPC        │<─────────────│  Workbench   │
│  Code        │    MessagePort  │  Router      │              │  UI          │
│              │                 │              │              │              │
└──────────────┘                 └──────────────┘              └──────────────┘
     ExtHost                         Main Thread                  Renderer
   (Node.js)                        (Node.js)                   (Browser)
```

### 6.2 通信协议：JSON-RPC over MessagePort

- **协议**：VSCode 使用 [vscode-jsonrpc](https://github.com/microsoft/vscode-languageserver-node) 库，基于 JSON-RPC 2.0
- **传输层**：
  - 本地场景：`MessagePort`（Electron 的进程间通信）
  - 远程场景：WebSocket + 加密隧道
- **双向通信**：ExtHost 可以主动调用 Main Thread 的方法（如创建终端），Main Thread 也可以推送事件到 ExtHost（如文档变更通知）

### 6.3 API 代理的通信流程

以 `vscode.window.showInformationMessage('Hello')` 为例：

```
1. Extension 调用 vscode.window.showInformationMessage('Hello')
2. 实际调用 ExtHostMessageService.showMessage()
3. ExtHostMessageService 通过 RPC 发送:
   { method: '$showMessage', params: ['info', 'Hello'] }
4. Main Thread 的 MainThreadMessageService 接收
5. MainThreadMessageService 调用 Renderer 层的 notification service
6. Renderer 显示通知 UI
7. 用户点击按钮
8. 结果通过 RPC 原路返回: { result: 'OK' }
9. Extension 的 Promise resolve('OK')
```

**关键设计**：
- 所有跨进程调用都是**异步**的（返回 `Promise` / `Thenable`）
- 方法名约定：Main Thread 暴露的方法以 `$` 前缀（如 `$showMessage`），ExtHost 暴露的以 `$_` 前缀（内部约定）
- 每个扩展有一个 `handle`（数字 ID），RPC 消息中携带 handle 用于路由

### 6.4 对 xyz-agent 的启示

- **JSON-RPC 是成熟选择**：xyz-agent 的 sidecar 已经使用 WebSocket 通信，JSON-RPC 是自然的协议选择
- **API 代理模式**：xyz-agent 应该为插件提供代理对象，插件调用 `agent.tools.search()` 时，代理通过 RPC 转发到主逻辑层
- **所有跨进程调用强制异步**：避免阻塞式 API，这是进程隔离的基本要求
- **不需要 VSCode 那么多层**：VSCode 有 ExtHost ↔ Main ↔ Renderer 三层，xyz-agent 只有 Plugin Worker ↔ Sidecar ↔ Renderer（两层 IPC）

---

## 7. 权限/安全模型

### 7.1 信任模型层级

```
┌────────────────────────────────────────────────────┐
│  Level 0: 未信任工作区（Restricted Mode）            │
│  - 仅激活 trusted 类型的扩展                         │
│  - 禁止执行任意代码、文件系统写入                     │
│  - Settings 中标记 requiresTrust 的配置不可用         │
├────────────────────────────────────────────────────┤
│  Level 1: 信任工作区                                │
│  - 所有扩展可以激活                                  │
│  - 完整文件系统访问                                  │
│  - Task、Debug 配置可用                              │
├────────────────────────────────────────────────────┤
│  Level 2: Proposed API（额外白名单）                 │
│  - 仅在 package.json 中声明 enableProposedApi        │
│  - VSCode 团队审核后加入白名单                        │
│  - 不允许发布到 Marketplace                          │
└────────────────────────────────────────────────────┘
```

### 7.2 具体安全机制

| 机制 | 说明 |
|------|------|
| **Workspace Trust** | 打开陌生文件夹时，用户必须显式信任才能激活完整扩展功能 |
| **Extension Capabilities** | 扩展无法访问其他扩展的数据（每个扩展有隔离的 storage） |
| **No DOM Access** | 扩展代码运行在 ExtHost 进程，无法直接操作 Renderer 的 DOM |
| **Webview Sandbox** | Webview 运行在独立 iframe 中，通过 `postMessage` 与 ExtHost 通信 |
| **Resource Access Policy** | 限制扩展可以访问的 URI scheme |
| **NLS Isolation** | 扩展的本地化字符串通过独立的 NLS 系统加载，不直接访问文件系统 |

### 7.3 API 稳定性分层的实际执行

```
Stable API                    Proposed API                Internal API
┌─────────────────────┐      ┌─────────────────────┐    ┌─────────────────────┐
│ vscode.commands.*   │      │ vscode.auth.*       │    │ /vs/base/*          │
│ vscode.window.*     │      │ vscode.terminal.*   │    │ /vs/workbench/*     │
│ vscode.workspace.*  │      │ (experimental)      │    │ /vs/editor/*        │
│                     │      │                     │    │ (internal modules)  │
│ 破坏性变更需         │      │ 随时可能变           │    │ 随时可能变           │
│ deprecation notice  │      │ 需 enableProposedApi │    │ 扩展不可见           │
│ + 2个版本过渡期      │      │ + 白名单审核         │    │                     │
└─────────────────────┘      └─────────────────────┘    └─────────────────────┘
```

### 7.4 对 xyz-agent 的启示

- **Workspace Trust 思路值得借鉴**：xyz-agent 可以区分"已信任的插件"和"未信任的插件"，未信任的插件不能执行 shell 命令、不能访问文件系统
- **扩展间隔离**：每个插件应该有独立的 storage namespace，不能读写其他插件的数据
- **No DOM Access 是原则**：插件绝对不能直接操作 UI，只能通过声明的 API 间接影响 UI
- **三层 API 不需要全部照搬**：xyz-agent 初期只需要 stable + internal 两层，proposed 可以等规模大了再加

---

## 8. Marketplace 分发

### 8.1 VSIX 打包格式

VSIX 本质上是一个 **ZIP 文件**，结构如下：

```
extension.vsix
├── [Content_Types].xml        # MIME 类型映射
├── extension.vsixmanifest     # 清单（元数据、依赖、兼容性）
├── extension/
│   ├── package.json           # 扩展 manifest
│   ├── dist/
│   │   └── extension.js       # 编译后的入口
│   └── README.md
└── assets/
    └── icon.png
```

打包命令：`npx vsce package`（vsce 是 VSCode Extension Manager CLI）

### 8.2 发布流程

```
开发者 → vsce publish → Marketplace (open-vsx.org)
                         ↓
用户 → Extensions Panel → 搜索 → Install
                         ↓
VSCode → 下载 VSIX → 解压到 ~/.vscode/extensions/
```

### 8.3 版本管理

- **SemVer 强制**：`package.json` 中的 `version` 必须符合 SemVer
- **Pre-release 支持**：VSCode 1.63+ 支持预发布版本（`1.0.0-alpha.1`），用户可以选择安装 stable 或 pre-release
- **自动更新**：VSCode 定期检查更新，后台下载安装
- **Rollback**：用户可以回退到之前的版本

### 8.4 对 xyz-agent 的启示

- **初期不需要 Marketplace**：xyz-agent 的插件数量远达不到需要独立市场的程度。初期用 git repo + npm install 的方式分发即可
- **VSIX 的打包格式值得参考**：即使不做 Marketplace，定义一个标准的 `.xzip`（xyz-agent zip）打包格式，包含 manifest + 编译产物，可以简化安装和版本管理
- **自动更新值得做**：检查 git repo / npm registry 的最新版本，提示用户更新

---

## 9. UI 扩展

### 9.1 Webview API

Webview 是 VSCode 扩展创建自定义 UI 的主要方式：

```
┌───────────────────────────────────────────────────┐
│  VSCode Main Window (Renderer)                     │
│  ┌──────────────────────────────────────────────┐ │
│  │  Editor Area                                 │ │
│  │  ┌────────────────────────────────────────┐  │ │
│  │  │  <iframe sandbox>                      │  │ │
│  │  │  ┌──────────────────────────────────┐  │  │ │
│  │  │  │  Webview HTML/CSS/JS             │  │  │ │
│  │  │  │  (独立 JS 运行时, 无 VSCode API)  │  │  │ │
│  │  │  └──────────────────────────────────┘  │  │ │
│  │  └────────────────────────────────────────┘  │ │
│  └──────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────┘

通信: Extension Host ←postMessage→ Webview iframe
```

**关键特性**：
- Webview 运行在**独立 iframe 沙箱**中，与 VSCode UI 完全隔离
- 使用 `postMessage` 双向通信
- 可以加载任意 HTML/CSS/JS，包括 React/Vue 等 SPA 框架
- 支持 `retainContextWhenHidden`（隐藏时保留状态，类似 Vue 的 keep-alive）
- 支持序列化/反序列化（`vscode.webview.onDidReceiveMessage`）

**限制**：
- 不能访问 VSCode 的 DOM 和 API
- 每个Webview 都是一个独立的浏览器上下文，性能开销大
- 调试困难（需要打开 DevTools 的 Webview 面板）

### 9.2 Tree View

Tree View 是声明式的数据展示组件：

```json
// package.json
{ "contributes": { "views": { "explorer": [{ "id": "myTree", "name": "Files" }] } } }
```

```typescript
// activate()
vscode.window.registerTreeDataProvider('myTree', {
  getChildren: (element) => { ... },
  getTreeItem: (element) => new vscode.TreeItem(label, collapsible),
});
```

- 纯数据驱动，扩展只提供数据，VSCode 负责渲染
- 支持图标、描述、badge、context menu、drag & drop
- 性能优秀（虚拟滚动、懒加载子节点）

### 9.3 StatusBar

```typescript
const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
item.text = '$(check) Ready';
item.show();
```

- 轻量级的 UI 扩展点，只支持文本 + 图标 + 点击事件
- 有优先级排序（数字越大越靠左/右）
- 适合状态指示（如语言服务器状态、Git 分支名）

### 9.4 对 xyz-agent 的启示

- **Webview iframe 沙箱对 xyz-agent 过度设计**：xyz-agent 本身就是 Electron 应用，不需要在 Electron 内再嵌 iframe 做隔离。如果需要自定义 UI 面板，可以让插件声明 Vue 组件（以 Web Component 形式加载），或者使用更轻量的 slot 机制
- **Tree View 的"数据驱动 UI"模式值得借鉴**：插件提供数据结构，xyz-agent 负责渲染成 UI。这是最安全的 UI 扩展方式——插件无法直接影响渲染层
- **StatusBar 类似的轻量扩展点**：xyz-agent 可以提供"消息装饰器"、"面板徽标"等轻量 UI 扩展点，插件不需要做 UI，只需要声明数据

---

## 10. 关键设计取舍

### 10.1 为什么 Extension Host 独立进程？

| 因素 | 同进程（如 Atom 早期） | 独立进程（VSCode 选择） |
|------|----------------------|------------------------|
| **崩溃隔离** | 扩展崩溃 = 编辑器崩溃 | 扩展崩溃只影响 ExtHost，编辑器可恢复 |
| **性能监控** | 无法区分扩展和编辑器的 CPU/内存 | 可以精确监控 ExtHost 的资源占用 |
| **安全边界** | 扩展可直接访问内部模块 | IPC 天然形成 API 边界 |
| **调试体验** | 混在一起难以调试 | 可独立 attach debugger |
| **Remote 场景** | 不可能 | ExtHost 可以跑在远程机器上 |
| **代价** | - | IPC 开销、API 必须全部异步化、序列化成本 |

**VSCode 的结论**：独立进程的成本完全值得。尤其是在 Remote Development（SSH、WSL、Codespaces）场景下，这个架构成为了核心竞争力。

### 10.2 为什么 JSON-RPC 而不是直接调用？

1. **进程间通信的标准化**：JSON-RPC 是成熟的、语言无关的协议，可以跨进程、跨机器、跨网络传输
2. **Remote 场景**：在 Remote Development 中，ExtHost 和 Main Process 可能不在同一台机器上，JSON-RPC over WebSocket 是唯一的选项
3. **可调试性**：JSON-RPC 消息可读性好，便于日志和调试
4. **vscode-jsonrpc 库**：微软已经将这个库独立发布，经过大量生产验证

### 10.3 为什么单进程多扩展（而不是每扩展一个进程）？

这是 VSCode **最受争议**的架构决策之一：

- **选择单进程的原因**：进程开销（每个 Node.js 进程约 30-50MB 内存）、扩展间通信复杂度（需要额外的 IPC）
- **导致的痛点**：
  - 一个扩展的未捕获异常可能导致整个 ExtHost 崩溃
  - CPU 密集型扩展（如语法分析）会阻塞其他扩展
  - 内存泄漏难以归因到具体扩展
- **VSCode 的缓解措施**：
  - `Extension Host Profiler`：可以查看每个扩展的 CPU 占用
  - `Extension Host Latency`：监控扩展的激活时间
  - Slow Extension 警告：激活超过 500ms 的扩展会被标记
- **vscode 的教训**：如果重新设计，可能会考虑更细粒度的隔离（如 Worker Thread 级别）

### 10.4 10 年演进中的经验教训

#### 教训 1：API 一旦发布就无法收回

VSCode 团队多次提到，最痛苦的决策是过早暴露了某些 API。例如 `workspace.rootPath`（只支持单根目录）在多根目录功能推出后无法移除，只能长期维护 shim。

**启示**：xyz-agent 应该从第一天就控制 API surface，宁可少暴露也不要多暴露。用 Proposed API 做缓冲。

#### 教训 2：activation events 的隐式注册是双刃剑

VSCode 1.74 允许省略 `activationEvents`（从 `contributes` 自动推断），但这导致开发者不理解激活时机，写出"启动就激活"的扩展（`onStartupFinished` 滥用）。

**启示**：xyz-agent 应该让激活逻辑透明——即使支持自动推断，也应该在文档中明确说明何时激活。

#### 教训 3：Webview 是"必要之恶"

Webview API 是 VSCode 扩展系统中使用率最高、抱怨最多的 API 之一。每个 Webview 都是一个完整的浏览器上下文，内存开销大、通信繁琐、调试困难。但 VSCode 团队也承认，没有更好的替代方案来实现自定义 UI。

**启示**：xyz-agent 应该尽量通过声明式扩展点覆盖 80% 的 UI 需求，只在极端场景才提供 Webview 类似能力。

#### 教训 4：贡献点（Contribution Points）的版本化困难

当 VSCode 需要修改某个 contributes schema（如 `debuggers` 的字段变更）时，已经发布的扩展不会自动更新。这导致 VSCode 必须长期保持向后兼容。

**启示**：manifest schema 应该有版本号（`manifestVersion: 1`），方便未来做 breaking change。

#### 教训 5：扩展质量差异巨大

VSCode Marketplace 上有 5 万+ 扩展，质量参差不齐。VSCode 团队花了大量精力在性能监控、扩展推荐算法、恶意扩展检测上。

**启示**：xyz-agent 不需要做 Marketplace，但需要一个插件质量评估机制——例如冷启动时间限制、内存占用限制、API 调用频率限制。

---

## 对 xyz-agent 的启示总结

### 必须借鉴的设计

| 设计模式 | VSCode 实践 | xyz-agent 适用场景 |
|---------|------------|-------------------|
| **进程隔离** | Extension Host 独立进程 | 插件运行在 sidecar 的 Worker Thread 或子进程中，与主逻辑隔离 |
| **API 代理层** | `vscode` namespace + `Object.freeze` | 提供 `agentAPI` namespace，代理对象通过 RPC 转发，冻结防篡改 |
| **懒激活** | activation events 按需加载 | 支持 `onSlashCommand`、`onToolCall`、`onSessionCreate` 等激活事件 |
| **声明式 Manifest** | `package.json` 的 `contributes` | 在 manifest 中声明 slash commands、tools、settings，不加载代码即可注册 |
| **Disposables 模式** | `context.subscriptions` 自动清理 | 插件注册的资源（事件监听、定时器等）放入 subscriptions，deactivate 时自动清理 |
| **API 稳定性分层** | Stable / Proposed / Internal | stable（给第三方）、proposed（给联调方）、internal（仅核心） |
| **所有跨进程 API 强制异步** | `Promise` / `Thenable` | 所有涉及 IPC 的 API 必须返回 Promise，禁止同步阻塞 |
| **JSON-RPC 协议** | vscode-jsonrpc 库 | sidecar ↔ renderer 已经是 WebSocket，JSON-RPC 是自然选择 |

### 可以简化的设计

| VSCode 设计 | 简化方案 | 理由 |
|------------|---------|------|
| **Marketplace** | Git repo + npm install | 插件数量少，不需要独立市场 |
| **Webview iframe 沙箱** | 声明式 UI 扩展点 + Vue slot | xyz-agent 本身是 Electron，不需要嵌套沙箱 |
| **Remote Extension Host** | 本地 sidecar 即可 | xyz-agent 是桌面应用，不需要远程扩展 |
| **Shared Process** | 不需要 | 单窗口应用不需要跨窗口共享服务 |
| **Web Extension Worker** | 不需要 | xyz-agent 不需要浏览器版本 |
| **扩展间依赖** | 初期不需要 `extensionDependencies` | 等插件生态成熟后再加 |

### 不需要的设计

| VSCode 设计 | 不适用的原因 |
|------------|------------|
| **Grammars / Snippets** | xyz-agent 不是代码编辑器 |
| **Debuggers** | 不需要调试适配器协议 |
| **Themes（颜色主题）** | xyz-agent 有自己的设计系统，不需要第三方主题 |
| **Language Server Protocol** | xyz-agent 不做语言服务 |
| **Multi-root Workspaces** | xyz-agent 不需要多工作区 |
| **Extension Packs** | 初期不需要"扩展包"概念 |

### 建议的 xyz-agent 插件架构概要

```
┌─────────────────────────────────────────────────────┐
│  xyz-agent Electron App                              │
│                                                       │
│  ┌─────────────────┐     ┌─────────────────────────┐ │
│  │  Renderer (Vue)  │◄───►│  Sidecar (Node.js)      │ │
│  │  - UI            │ WS  │  - Session Manager      │ │
│  │  - Chat Panel    │     │  - Plugin Host          │ │
│  │  - Settings      │     │    ┌─────────────────┐  │ │
│  └─────────────────┘     │    │ Worker Thread    │  │ │
│                           │    │  - Plugin A      │  │ │
│                           │    │  - Plugin B      │  │ │
│                           │    │  - Plugin C      │  │ │
│                           │    └─────────────────┘  │ │
│                           │                         │ │
│                           │  agentAPI (proxy)       │ │
│                           │  - tools.*              │ │
│                           │  - sessions.*           │ │
│                           │  - slashCommands.*      │ │
│                           │  - settings.*           │ │
│                           │  - events.*             │ │
│                           └─────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

**核心原则**：
1. **插件 = npm 包**：复用 `package.json` 格式，额外约定 `agent` 字段（类似 VSCode 的 `contributes`）
2. **Manifest 声明式注册**：slash commands、tools、settings 等在 manifest 中声明，不加载代码即可注册
3. **按需激活**：只在需要时才加载插件代码（`onSlashCommand`、`onToolCall`）
4. **API 代理 + 冻结**：通过 `agentAPI` namespace 暴露能力，Object.freeze 防篡改
5. **Worker Thread 隔离**：插件代码运行在 Worker Thread 中，与 sidecar 主逻辑隔离，崩溃不影响核心功能
6. **JSON-RPC over MessagePort**：Worker Thread 与 sidecar 主线程通过 MessagePort + JSON-RPC 通信
7. **Disposables 资源管理**：`context.subscriptions` + `deactivate()` 自动清理
8. **KV 持久化**：`context.globalState` / `context.workspaceState` 提供插件级存储
