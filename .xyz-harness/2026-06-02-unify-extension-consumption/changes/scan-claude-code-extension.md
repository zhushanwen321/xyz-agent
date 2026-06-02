# Claude Code 插件机制分析

> 源码路径: `~/GitApp/claude-code-source-code/`，分析日期: 2026-06-02

## 1. 三层机制的区别与关系

Claude Code 有三层可扩展机制，关系是 **Plugin > Hook > Skill**：

### Skill（最底层）
- **形态**：Markdown 文件（`SKILL.md` 或 `skill-name/SKILL.md`），带 frontmatter 元数据
- **发现方式**：从以下目录递归扫描（扁平 + `loadSkillsDir.ts`）：
  - `~/.claude/skills/`（用户级）
  - `.claude/skills/`（项目级，沿目录树向上）
  - Managed `.claude/skills/`（企业策略）
  - Legacy `.claude/commands/` 目录（向后兼容）
  - **Bundled skills**：`registerBundledSkill()` 程序化注册（`src/skills/bundled/` 下有 16 个内置 skill）
  - **Conditional skills**：带 `paths` frontmatter 的 skill，文件被访问时才激活
- **初始化**：`getSkillDirCommands()` 在启动时调用，结果 memoize 缓存。Dedup 通过 `realpath()` 计算 file identity
- **Skill 可在 frontmatter 中定义 hooks**（`parseHooksFromFrontmatter`）

### Hook（中间层）
- **形态**：4 种类型 — `command`（shell）、`prompt`（LLM）、`agent`（验证代理）、`http`（webhook）
- **定义位置**：
  - `settings.json` 的 `hooks` 字段（`src/utils/hooks.ts` 通过 `getHooksConfigFromSnapshot` 读取）
  - Plugin 的 `hooks/hooks.json`（通过 `PluginHooksSchema` 校验）
  - Skill frontmatter 的 `hooks` 字段
  - 从多源合并，按优先级排序
- **生命周期事件**：26 种（`HOOK_EVENTS` in `coreTypes.ts`）：`PreToolUse`、`PostToolUse`、`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`Stop`、`PreCompact`、`Notification` 等
- **执行**：命令行同步/异步（`async: true` 后台执行，`asyncRewake` 退出码 2 时唤醒模型），支持 JSON 输出解析、`if` 条件过滤、超时控制
- **安全**：所有 hooks 要求 workspace trust（`shouldSkipHookDueToTrust`）

### Plugin（最顶层容器）
- **形态**：标准目录结构，包含 `plugin.json` manifest
- **目录约定**：
  ```
  plugin-root/
  ├── .claude-plugin/plugin.json   # 首选 manifest 位置
  ├── plugin.json                   # 兼容位置
  ├── commands/                     # *.md → 斜杠命令
  ├── agents/                       # *.md → AI agent 定义
  ├── skills/                       # SKILL.md 目录 → skills
  ├── hooks/hooks.json              # hook 配置
  ├── output-styles/                # 输出样式
  └── .mcp.json                     # MCP 服务器配置
  ```
- **manifest 能力**（`PluginManifestSchema`）：name、version、description、author、dependencies、hooks（inline 或文件引用）、commands（路径/数组/对象映射三种格式）、agents、skills、outputStyles、mcpServers、lspServers、userConfig（用户可配置项）、settings（合并到 settings cascade）、channels（assistant 模式通道）
- **发现方式**：
  1. **Marketplace 系统**：用户在 `settings.json` 声明 marketplace，指定 github/git/npm/file/directory/settings 六种 source 类型。插件通过 `name@marketplace` 标识符定位
  2. **Session-only**：`--plugin-dir` CLI 标志，后缀 `@inline`，不入持久缓存
  3. **Built-in plugins**：`BUILTIN_PLUGINS` Map 注册，用户可开关（`name@builtin`）

## 2. 插件系统 API 接口

### 插件可提供的能力（从 manifest 到运行时映射）

| 组件 | manifest 字段 | 运行时加载 | 对用户可见为 |
|------|-------------|-----------|------------|
| Commands | `commands` / `commands/` 目录 | `loadPluginCommands.ts` | `/plugin:command-name` |
| Agents | `agents` / `agents/` 目录 | `loadPluginAgents.ts` | 子 agent 定义 |
| Skills | `skills` / `skills/` 目录 | `loadSkillsDir.ts` → `loadedFrom: 'plugin'` | 工具列表中可见 |
| Hooks | `hooks` / `hooks/hooks.json` | `loadPluginHooks.ts` + `hooks.ts` runtime | 生命周期拦截 |
| MCP | `mcpServers` / `.mcp.json` / `.mcpb` | `mcpPluginIntegration.ts` | MCP 工具 |
| LSP | `lspServers` / `.lsp.json` | `lspPluginIntegration.ts` | 代码智能 |
| Output Styles | `outputStyles` | `loadPluginOutputStyles.ts` | 输出格式 |
| Settings | `settings` | 合并到 settings cascade | 全局配置 |
| User Config | `userConfig` | `${user_config.KEY}` 模板 + `CLAUDE_PLUGIN_OPTION_*` 环境变量 | 安装时配置 |

### 模板变量系统
- `${CLAUDE_PLUGIN_ROOT}` → 插件根目录
- `${CLAUDE_PLUGIN_DATA}` → 插件数据目录
- `${CLAUDE_PLUGIN_OPTION_<KEY>}` → 用户配置项（环境变量）
- `${CLAUDE_SKILL_DIR}` → Skill 目录（Skill 内联 shell 命令可用）
- `${user_config.KEY}` → 在 hook 命令/MCP 配置中替换

## 3. TUI vs Headless 模式

- **TUI 模式**：`performBackgroundPluginInstallations()` 通过 AppState 更新 UI（ProgressBar、notifications）
- **Headless 模式**（CCR/SDK）：`installPluginsForHeadless()` 独立路径，无 UI 依赖
  - 使用 `registerSeedMarketplaces()` 支持 BYOC 预填充缓存
  - 支持 ZIP cache 模式（`CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE`），适用于挂载卷/ephemeral 容器
  - 通过 `withDiagnosticsTiming` 计时，不更新 ProgressBar
  - 返回 boolean 指示是否有变更，调用方据此 refresh
- **关键差异**：Headless 跳过 AppState 创建，`reconcileMarketplaces` 异步执行但无 spinner

## 4. 版本管理与分发

- **版本缓存**：`~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/`（三层隔离）
- **版本计算**：`pluginVersioning.ts` — Git SHA（`installFromGitSubdir` 返回）、package.json、manifest version 字段
- **Seed 目录**：`CLAUDE_CODE_PLUGIN_SEED_DIR` 环境变量，预填充只读缓存。`probeSeedCache()` 在写入前检查，命中则跳过 clone
- **ZIP 缓存**：挂载卷兼容方案，`convertDirectoryToZipInPlace()` + `extractZipToDirectory()`
- **自动更新**：marketplace 级别 `autoUpdate` 字段，官方 marketplace 默认 true。`pluginAutoupdate.ts` 控制
- **分发源**：GitHub（HTTPS/SSH）、git URL、npm（含 registry/version）、pip（计划中）、本地路径、git-subdir（monorepo sparse-checkout，`--filter=tree:0` 大幅减少带宽）

## 5. 第三方扩展集成

**不需要修改源码**。集成路径：

1. 创建标准目录结构（至少 `plugin.json`）
2. 在 `settings.json` 添加 marketplace 声明（或直接用 `claude plugins install github:user/repo`）
3. 支持的分发方式：
   - GitHub repo → `source: "github"`, `repo: "user/repo"`
   - npm 包 → `source: "npm"`, `package: "@scope/name"`
   - 本地路径 → `source: "file"` 或 `source: "directory"`
   - Session 调试 → `--plugin-dir /path/to/plugin`
   - Monorepo 子目录 → `source: "git-subdir"`, `path: "plugins/my-plugin"`（partial clone + sparse checkout）
4. 企业场景：通过 managed/policy settings 预配置 marketplace，seed 目录预填充缓存，ZIP cache 用于容器化部署
