---
verdict: pass
---

# Bundle Pi Extensions into xyz-agent

## Background

xyz-agent 使用 pi 作为底层 AI 引擎，通过 `--no-extensions --extension <path>` 控制加载哪些 pi extension。当前项目仅有 `xyz-agent-extension.js`（session tree navigation）被加载。

xyz-agent 的前端已有工具渲染器（`RenderDescriptor.vue` 用于 goal_manager/todo、`SubagentRenderer.vue` 用于 subagent），但这些渲染器对应的 pi extension 从未被加载——渲染器在等实现，extension 在等 wiring。

源仓库 `xyz-pi-extensions-workspace/main/` 包含 7 个 pi extension + 1 个共享模块。需要将其中 6 个内置到 xyz-agent 项目中，使 /goal、/todos、subagent、/workflow、usage-tracker、hooks 功能可用。

## Functional Requirements

### FR-1: Extension 源码内置

将以下 pi extension 源码复制到 `src-electron/resources/pi/agent/extensions/` 目录：

| Extension | 注册的工具/命令 | 用途 |
|-----------|---------------|------|
| goal | `goal_manager` 工具 + `/goal` 命令 | 持久化目标驱动循环，任务清单 + 预算管理 |
| todo | `todo` 工具 + `/todos` 命令 | 轻量任务列表，session 持久化 |
| subagent | `subagent` 工具 + `analyze_image` 工具 | LLM 自主派发子进程执行子任务 |
| workflow | `workflow-run` 等工具 + `/workflow` `/workflows` 命令 | 多 agent 流水线编排 |
| usage-tracker | 无（纯事件监听） | 被动收集 skill/agent/token 用量数据 |
| hooks | 无（纯事件监听） | 轻量 footer 时间戳更新 |

同时复制 `shared/logger.ts` 共享模块（被 subagent 和 usage-tracker 引用）。

目标目录结构（shared/ 必须与各 extension 目录同级，因为 subagent/src/model.ts 和 usage-tracker/src/index.ts 通过 `../../shared/logger.js` 相对路径引用）：

```
src-electron/resources/pi/agent/extensions/
  shared/
    logger.ts
  goal/
    index.ts
    package.json
    src/...
  todo/
    index.ts
    package.json
    src/...
  subagent/
    index.ts
    package.json
    src/...
  workflow/
    index.ts
    package.json
    src/...
  usage-tracker/
    index.ts
    package.json
    src/...
  hooks/
    index.ts
    package.json
    src/...
```

**不包含** evolution-engine（CLI 交互式自进化，不适合 xyz-agent server-mode）。

### FR-2: shared/logger.ts 路径适配

`shared/logger.ts` 当前硬编码日志写入路径为 `~/.pi/agent/logs/`。在 xyz-agent 环境下 pi 通过 `PI_CODING_AGENT_DIR` 环境变量使用 `~/.xyz-agent/pi/agent/`。需修改 logger 从环境变量读取日志目录，确保日志写入 `~/.xyz-agent/pi/agent/logs/` 而非 `~/.pi/agent/logs/`。

### FR-3: SessionService extension 路径发现

修改 `SessionService.getExtensionPaths()` 使其在 dev 模式下扫描项目源码目录 `src-electron/resources/pi/agent/extensions/`，在 packaged 模式下扫描运行时目录 `~/.xyz-agent/pi/agent/extensions/`（由 `migrateToPiSubdir()` 从 Resources 同步）。

将 `create()` 和 resume 流程中的 extension 路径收集从手动拼接 `[this.extensionPath, ...userExtPaths]` 改为调用 `this.getExtensionPaths()` + user extensions。

### FR-4: Git 跟踪

更新 `.gitignore` 放行 `src-electron/resources/pi/agent/extensions/` 和 `src-electron/resources/pi/agent/skills/` 子目录，使 bundled extension 源码可提交到 git。

### FR-5: 生产构建

确认 `electron-builder.yml` 的 `extraResources` 规则（`from: resources/pi → to: pi`）已覆盖 extensions 目录。确认 `migrateToPiSubdir()` 在 packaged 模式首次启动时正确同步 bundled extensions 到 `~/.xyz-agent/pi/agent/extensions/`。

## Acceptance Criteria

### AC-1: Extension 加载成功

- pi 启动时无 extension 加载错误（console 无 `Failed to load extension` 或 `does not export a valid factory function` 报错）
- `goal_manager`、`todo`、`subagent`、`analyze_image` 工具在 pi 的工具列表中可见

### AC-2: 前端展示正常

- 前端斜杠命令菜单出现 `/goal`、`/todos`、`/workflow` 命令
- LLM 调用 `goal_manager` 工具后，`RenderDescriptor.vue` 正确渲染任务清单
- LLM 调用 `todo` 工具后，`RenderDescriptor.vue` 正确渲染 todo 列表
- LLM 调用 `subagent` 工具后，`SubagentRenderer.vue` 正确渲染 agent/task/输出

### AC-3: Logger 路径隔离

- subagent 和 usage-tracker 的日志文件写入 `~/.xyz-agent/pi/agent/logs/` 目录
- 不写入 `~/.pi/agent/logs/` 目录

### AC-4: 生产构建

- `npm run build` 成功，extensions 包含在 `Resources/pi/agent/extensions/` 中
- 首次启动 packaged app 时 `migrateToPiSubdir()` 将 extensions 同步到 `~/.xyz-agent/pi/agent/extensions/`
- 后续启动检测到目标目录已存在，跳过同步（幂等）

### AC-5: Git 跟踪

- `src-electron/resources/pi/agent/extensions/` 下的文件可被 `git add` 跟踪
- `src-electron/resources/pi/agent/` 下的其他文件（models.json、settings.json 等）仍被 gitignore

## Constraints

- **数据隔离**：xyz-agent 数据目录（`~/.xyz-agent/`）与 pi 数据目录（`~/.pi/`）完全隔离。Extension 不可读写 `~/.pi/` 下的任何内容（logger 修复即为此约束）
- **Extension 不可修改 extension 行为**：只做路径适配（logger）和加载 wiring，不改动 extension 内部逻辑
- **pi 启动参数**：使用 `--no-extensions` + 显式 `--extension <path>` 控制加载，不依赖 pi 的自动发现
- **Extension 通过 jiti 加载**：pi 使用 jiti 编译 TypeScript，无需预编译 extension。所有外部依赖（@earendil-works/pi-ai、typebox 等）由 pi 的 virtualModules/alias 提供
- **技术栈**：Electron + Vue 3 + Node.js sidecar，extension 为 TypeScript，pi 版本 `xyz-pi@0.75.5-xyz-0.1`

## Decisions Made

1. **不包含 evolution-engine**：设计给 CLI 交互式自进化，xyz-agent 为 server-mode，无配套 UI
2. **shared/logger.ts 修改**：从硬编码 `~/.pi/` 改为读取 `PI_CODING_AGENT_DIR` 环境变量，回退到 `~/.pi/agent/logs/`
3. **Dev 模式依赖项目源码路径**：不需要额外 setup 步骤，`getExtensionPaths()` 直接扫描 `src-electron/resources/pi/agent/extensions/`
4. **getExtensionPaths() 跳过 shared/ 目录**：shared/ 不是 pi extension（无 index.ts），仅作为相对 import 目标存在
5. **Extension 去重**：按 extension name 去重，runtime 目录优先于项目源码路径

## 业务用例

无业务用例。纯技术性需求：将已开发完成的 pi extension 内置到 xyz-agent 中。

## Complexity Assessment

**Low**。改动集中在 3 个文件（logger.ts 1 行路径修改、session-service.ts wiring 已完成、.gitignore 已完成）+ 1 次批量文件复制。无新功能开发，无 UI 改动，无 API 变更。风险点仅在于 pi jiti 加载路径兼容性和生产构建资源同步。
