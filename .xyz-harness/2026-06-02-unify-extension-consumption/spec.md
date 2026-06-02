---
verdict: pass
---

# 统一 Extension 消费架构

## Background

xyz-agent 当前有两套 extension 体系共存：

1. **xyz-agent bundled extensions** (`src-electron/resources/pi/agent/extensions/`) — 以源码目录形式随 xyz-agent 仓库分发，pi 子进程启动时通过 `--extension` 参数加载
2. **xyz-pi-extensions npm packages** (`@zhushanwen/pi-*`) — 独立的 npm 包，面向 pi TUI 用户发布

两套体系中有三处功能重叠（goal、todo、workflow），各自独立维护，存在重复开发工作。bundled extension 的更新无法自动同步到 pi-ext，反之亦然。

同时，xyz-agent 的 GUI 前端无法消费 pi extension 的 UI 数据（`ctx.ui.setWidget`/`setStatus`）。事件桥接链路上存在两处断裂：`setWidget` 在 event-adapter 中被显式丢弃（line 276-277），`setStatus` 仅走内部回调不到前端。

参考 VS Code extension 架构的双进程 RPC proxy 模式（研究成果见 `docs/extensions/vscode-extension-architecture-analysis.md`），xyz-agent 的两层结构（pi Extension Host + Vue Renderer）与 VS Code 高度相似，可直接借鉴其协议接口对、声明式 UI 骨架、Pull-based 数据获取等设计。

## Target End State

- xyz-agent **不再维护** goal、todo、workflow 的源码副本，改为直接消费 `@zhushanwen/pi-*` npm 包
- 所有 `@zhushanwen/pi-*` 包均可被 xyz-agent 加载，无需改动 extension 源码
- pi extension 通过 `ctx.ui.setWidget`/`setStatus` 产出的 UI 数据可以到达前端并渲染
- 第三方 pi extension（非自有 npm 包）可以被 xyz-agent 用户安装和使用
- pi-ext 包提供 tsc 编译产物，提升打包稳定性

## Functional Requirements

### FR-1: Extension Resolver

统一解析所有 extension 来源，返回 pi 可加载的目录路径列表。

- **FR-1.1**: 扫描 `node_modules/@zhushanwen/pi-*` 目录，识别为自有 npm 包 extension
- **FR-1.2**: 扫描 `resources/pi/agent/extensions/*` 目录，识别为 bundled extension（subagent、usage-tracker、hooks、bridge）
- **FR-1.3**: 扫描 `~/.xyz-agent/pi/agent/extensions/*` 目录，识别为第三方 extension（pi 原生路径格式，jiti 加载 TS/JS 入口文件，用户手动 clone + npm install 到此处）
- **FR-1.4**: 扫描 `~/.xyz-agent/extensions/*` 目录，识别为用户通过 xyz-agent Settings UI 安装管理的 extension（由现有 ExtensionService 负责 enable/disable state 管理，ExtensionResolver 复用其路径列表）
- **FR-1.5**: 按优先级去重：npm > user（ExtensionService）> third-party > bundled（名称冲突时前者覆盖后者）
- **FR-1.6**: 跳过 `shared/` 目录（非 extension，只是共享模块）
- **FR-1.7**: extension 加载失败时记录日志并跳过，不阻塞 session 启动。event-adapter 生成 `extension.error` WS 事件通知前端

### FR-2: pi 启动参数

- **FR-2.1**: `--extension` 参数传**目录路径**而非文件路径，让 pi 的 `discoverExtensionsInDir` 自动发现 index.ts/index.js，同时 jiti 能正确 resolve extension 同目录下的 `node_modules/`
- **FR-2.2**: 保持 `--no-extensions` 标志，所有 extension 通过显式 `--extension` 加载

### FR-3: npm 包依赖管理

- **FR-3.1**: `src-electron/package.json` 添加以下 runtime dependencies：
  - `@zhushanwen/pi-goal`
  - `@zhushanwen/pi-todo`
  - `@zhushanwen/pi-workflow`
  - `@zhushanwen/pi-coding-workflow`
  - `@zhushanwen/pi-skill-state`
  - `@zhushanwen/pi-vision`
  - `@zhushanwen/pi-evolve-daily`
  - `@zhushanwen/pi-statusline`
  - `@zhushanwen/pi-context-engineering`
  - `@zhushanwen/pi-taste-lint`
  - `@zhushanwen/pi-claude-rules-loader`
  - `@zhushanwen/pi-unified-hooks`
- **FR-3.2**: 删除 `resources/pi/agent/extensions/goal/`、`todo/`、`workflow/` 源码副本

### FR-4: pi-extension 编译构建

- **FR-4.1**: 每个 `@zhushanwen/pi-*` 包添加 `tsconfig.json` 和 `tsc` 构建脚本
- **FR-4.2**: 编译产物输出至 `dist/`，`package.json` 的 `main` 字段指向 `dist/index.js`
- **FR-4.3**: 原有 `main: "index.ts"` 或 `"src/index.ts"` 改为指向编译产物
- **FR-4.4**: 每个 pi-ext 包的 `package.json` 添加 `"pi": {"extensions": ["dist/index.js"]}` 字段。pi 的 `resolveExtensionEntries` 在目录级别优先读取此字段，确保只加载编译产物，避免同时发现 `src/index.ts` 和 `dist/index.js` 导致重复加载

### FR-5: setWidget/setStatus 事件桥接

- **FR-5.1**: `event-adapter.ts` 中删除 `setWidget` 的 discard 逻辑（当前第 276-277 行），改为生成 WS 事件 `extension.widget`
- **FR-5.2**: `event-adapter.ts` 中 `setStatus` 事件从仅内部回调改为同时生成 WS 事件 `extension.status`
- **FR-5.3**: 新增 WS 事件类型定义在 `shared/src/extension.ts`（新文件）。extension UI 事件是独立领域，与 `protocol.ts` 中的 session/chat 事件正交

### FR-6: 前端 Extension UI 面板

- **FR-6.1**: 新增 `ExtensionWidgetPanel` Vue 组件，接收 `{ widgetKey: string, lines: string[] }` 数据，渲染为可折叠面板
- **FR-6.2**: 新增 ExtensionStatusBar 区域，接收 `{ statusKey: string, text: string }` 数据，渲染为状态栏条目
- **FR-6.3**: 组件不绑定特定 extension，基于 `widgetKey`/`statusKey` 动态显示（通用渲染）

### FR-7: 打包适配

- **FR-7.1**: `electron-builder.yml` 的 `files` 字段添加 `node_modules/@zhushanwen/pi-*/**/*`
- **FR-7.2**: `asarUnpack` 添加 `node_modules/@zhushanwen/pi-*/**/*`（pi 子进程需要直接读取）
- **FR-7.3**: `files` 显式包含 pi-ext 的传递依赖（如 `js-yaml`）。方法：扫描每个 `@zhushanwen/pi-*` 的 `package.json` dependencies 和 peerDependencies，将不在 `@zhushanwen/` scope 下的依赖逐个加入 `files` 白名单
- **FR-7.4**: `preflight-check.sh` 增加以下检查：(a) 每个 `node_modules/@zhushanwen/pi-*` 存在且有 `dist/index.js`，(b) pi-ext 的传递依赖存在于打包产物 node_modules 中
- **FR-7.5**: `tsup.config.ts` 的 `noExternal` 不包含 `@zhushanwen/pi-*`（这些包不在 runtime bundle 内运行）

### FR-8: 第三方 Extension 支持

- **FR-8.1**: ExtensionResolver 自动发现 `~/.xyz-agent/pi/agent/extensions/*` 下的 extension
- **FR-8.2**: pi 能正确 resolve 第三方 extension 的 `node_modules/` 依赖（通过传目录路径而非文件路径）
- **FR-8.3**: 第三方 extension 也受益于 FR-5 的 setWidget/setStatus 桥接——只有 `ctx.ui.custom()`（TUI overlay）不在范围内
- **FR-8.4**: 不处理第三方 extension 的 GUI 交互适配（`ctx.ui.confirm()`、`ctx.ui.select()`、`ctx.ui.input()` 等需要用户交互的 API）

## Acceptance Criteria

### AC-1: Extension 加载无回归

**Given** xyz-agent 启动新 session
**When** pi 子进程加载 extension
**Then** 所有 @zhushanwen/pi-* extension 注册的 tools 和 commands 出现在 `/commands` 列表中，且行为与 bundled 版本等价。基线 checklist（变更前后均需验证）：
  - goal: tool `goal_manager`（含 create_tasks/list_tasks/update_tasks/complete_goal/cancel_goal/report_blocked 六个 action），command `/goal`
  - todo: tool `todo`（含 add/update/delete/list/clear 五个 action），command `/todos`
  - workflow: command `/workflow`，tool `subagent`（从 workflow extension 注册）

### AC-2: 去重无冲突

**Given** `node_modules/` 和 `~/.xyz-agent/pi/agent/extensions/` 同时存在 `pi-goal`
**When** ExtensionResolver 解析
**Then** 只加载 npm 版本，第三方版本被忽略

### AC-3: 第三方 extension 依赖解析

**Given** 第三方 extension `pi-hashline-edit` 自带 `node_modules/diff`
**When** pi jiti 加载该 extension
**Then** `import diff from 'diff'` 能正确解析到 extension 同目录下的 `node_modules/diff`

### AC-4: setWidget 数据到达前端

**Given** pi extension 调用 `ctx.ui.setWidget("goal", lines)`
**When** xyz-agent 运行时
**Then** 前端 ExtensionWidgetPanel 收到 `extension.widget` WS 事件并渲染 lines 内容

### AC-5: setStatus 数据到达前端

**Given** pi extension 调用 `ctx.ui.setStatus("goal", text)`
**When** xyz-agent 运行时
**Then** 前端 ExtensionStatusBar 收到 `extension.status` WS 事件并显示 text

### AC-6: 打包产物包含 npm extension

**Given** 执行 `npm run build` 打包
**When** 安装打包产物后启动
**Then** xyz-agent 能通过 `app.asar.unpacked/node_modules/@zhushanwen/pi-goal/dist/index.js` 加载 extension

### AC-7: bundled 副本已删除

**Given** 代码仓库最新 commit
**When** 检查 `resources/pi/agent/extensions/`
**Then** 目录中不包含 goal、todo、workflow 子目录

### AC-8: 现有 subagent/usage-tracker/hooks/bridge 不受影响

**Given** bundled extension 仍保留
**When** 启动 session
**Then** subagent tool、last-activity status bar、bridge sync 等功能正常工作

## Constraints

| 约束 | 说明 |
|------|------|
| **C-1: pi 进程版本** | 依赖 xyz-pi fork 版本（支持 `leafId` 字段） |
| **C-2: Node.js 版本** | 运行时需 Node.js 18+（pi jiti loader 要求） |
| **C-3: 不修改 pi 源码** | 所有改动在 xyz-agent + xyz-pi-extensions 范围内，不动 pi coding-agent 源码 |
| **C-4: extension 源码不改** | pi-ext 的 TS 源码保持现状（不拆分 TUI/core），只加构建流程 |
| **C-5: 不处理 `ctx.ui.custom()`** | TUI overlay 在 RPC 模式下不可用，不在此次范围 |
| **C-6: electron-builder 约束** | `files` 必须显式包含 `node_modules/@zhushanwen/pi-*/**/*` 和传递依赖，`asarUnpack` 必须包含对应路径 |
| **C-7: 跨项目时序** | FR-4 的 pi-ext tsc 构建和 npm publish 必须在 FR-3.1 的 npm install 之前完成。开发阶段使用 `npm link` 进行本地联调。打包配置变更需逐个 commit 验证（参考 CLAUDE.md Rule #12） |

## Decisions

| 决策 | 选择 | 原因 |
|------|------|------|
| pi-ext 编译产物 | 使用 tsc，输出 `dist/index.js` | 比 jiti 动态编译更稳定，消除打包时的 tsx 依赖 |
| `--extension` 传目录 | 传包根目录而非 index.ts | pi 的 discoverExtensionsInDir 支持目录扫描；jiti 能 resolve 同目录 node_modules |
| TUI 代码不拆分 | 保持现状 | RPC 模式下 renderCall/renderResult 不执行，无副作用；拆分是纯机械劳动，无实际收益 |
| 通用 UI 组件 | ExtensionWidgetPanel + ExtensionStatusBar 通用渲染 | 参考 VS Code 的声明式 UI 骨架模式，不按 extension 定制组件 |
| 去重优先级 | npm > user > third-party > bundled | npm 版本有 semver 管理，确保可复现 |
| 第三方 extension 安装方式 | 用户手动 clone + npm install 到 `~/.xyz-agent/pi/agent/extensions/` | 初期不开发 GUI 安装管理 |
| pi.extensions manifest | 每个 pi-ext 包的 package.json 添加 `"pi": {"extensions": ["dist/index.js"]}` | 确保 pi 只加载编译产物，避免同时发现 src/ 和 dist/ 入口 |

## 业务用例

> 初版简述（Phase 2 会在此基础上细化）。纯技术性需求部分不在此重复。

### UC-1: 用户升级 extension 版本

- **Actor**: xyz-agent 用户
- **场景**: pi-ext 发布了新版本，用户想升级 xyz-agent 使用的 extension
- **预期结果**: 用户在 xyz-agent 项目目录执行 `npm update @zhushanwen/pi-goal` 后，重启应用即可使用新版本

### UC-2: 用户安装第三方 extension

- **Actor**: xyz-agent 用户
- **场景**: 用户发现一个社区开发的 pi extension（如 pi-hashline-edit），希望安装到 xyz-agent 中使用
- **预期结果**: 用户执行 `git clone + npm install` 到 `~/.xyz-agent/pi/agent/extensions/` 后，重启 session 即可使用

### UC-3: 开发者在 pi-ext 中修复 bug

- **Actor**: pi-ext 开发者
- **场景**: goal extension 发现 bug，修复后发 `@zhushanwen/pi-goal@0.2.1-alpha.0` beta 版
- **预期结果**: 开发者在 xyz-agent 中 `npm install @zhushanwen/pi-goal@0.2.1-alpha.0` 后，重启即可验证修复

## Complexity Assessment

| 维度 | 评估 |
|------|------|
| **涉及项目** | xyz-agent (7-9 文件修改) + xyz-pi-extensions (12 个包加 tsc 构建) |
| **新增文件** | ExtensionResolver、ExtensionWidgetPanel、ExtensionStatusBar、shared extension 类型 |
| **删除文件** | resources/pi/agent/extensions/{goal,todo,workflow}/ (删 3 个目录) |
| **风险点** | electron-builder 打包配置易出错（历史已出过 bug）；npm 包 node_modules 路径在打包后需验证 |
| **依赖复杂性** | 低。Extension 间无互相依赖 |
