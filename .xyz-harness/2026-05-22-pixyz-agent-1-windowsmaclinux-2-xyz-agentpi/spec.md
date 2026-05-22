---
verdict: pass
---

# Bundle pi Binary into xyz-agent

## Background

xyz-agent 通过 Sidecar 子进程启动 pi（`pi --mode rpc`），以 JSONL stdin/stdout 进行 RPC 通信。当前 pi 是一个外部依赖，用户必须自行安装 `npm i -g @mariozechner/pi-coding-agent`。这导致：

1. 用户必须预装 Node.js + npm
2. pi 版本不可控，与 xyz-agent 版本不匹配时可能出 bug
3. xyz-agent 的 extension/skill 需要用户手动配置 `~/.pi/` 目录

pi 官方提供了 Bun 编译的独立 binary（通过 `earendil-works/pi` GitHub Release 发布，6 平台：darwin/linux/windows x arm64/x64，压缩 27-47MB，解压约 70-120MB），内嵌完整运行时，无需 Node.js。

本功能将 pi binary + 预装 extension/skill 打包进 xyz-agent 安装包，实现开箱即用。

## Functional Requirements

### FR-1: 打包 pi Bun Binary

将 pi 预编译 binary 放入 Electron app 的 `extraResources`，随 xyz-agent 一起分发。

- Binary 来源：`earendil-works/pi` GitHub Release（如 v0.75.4）
- 命名规则：`pi-{platform}-{arch}`（与 Release asset 名一致，解压后即为该名称）
- 目标位置：`<resourcesPath>/pi/pi-{platform}-{arch}`
- pi 提供 6 种平台/架构 variant（darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-arm64, windows-x64），xyz-agent 根据当前 CI 构建矩阵仅打包 3 种（darwin-arm64, windows-x64, linux-x64），见「补充说明」章节
- Windows binary 文件名为 `pi-windows-x64.exe`（含 `.exe` 后缀，CI 脚本需处理 `process.platform === 'win32'` 时的路径拼接差异）

### FR-2: 打包预装 Extension

将 xyz-pi-extensions 仓库中的 3 个 extension 打包到 `<resourcesPath>/pi/agent/extensions/`：

| Extension | 来源 |
|-----------|------|
| subagent | xyz-pi-extensions/subagent/ |
| goal | xyz-pi-extensions/goal/ |
| todo | xyz-pi-extensions/todo/ |

Extension 无运行时依赖（纯 TypeScript，pi 用 jiti 加载）。总大小约 228KB。

### FR-3: 打包预装 Skill

将 xyz-harness 仓库的 skills/ 目录下全部 19 个 skill 打包到 `<resourcesPath>/pi/agent/skills/`：

| Skill | 来源 |
|-------|------|
| chrome-automation | xyz-harness/skills/chrome-automation/ |
| create-worktree | xyz-harness/skills/create-worktree/ |
| harness-retrospect | xyz-harness/skills/harness-retrospect/ |
| merge-worktree | xyz-harness/skills/merge-worktree/ |
| vision-analysis | xyz-harness/skills/vision-analysis/ |
| xyz-harness-brainstorming | xyz-harness/skills/xyz-harness-brainstorming/ |
| xyz-harness-writing-plans | xyz-harness/skills/xyz-harness-writing-plans/ |
| xyz-harness-phase-dev | xyz-harness/skills/xyz-harness-phase-dev/ |
| xyz-harness-phase-test | xyz-harness/skills/xyz-harness-phase-test/ |
| xyz-harness-phase-pr | xyz-harness/skills/xyz-harness-phase-pr/ |
| xyz-harness-expert-reviewer | xyz-harness/skills/xyz-harness-expert-reviewer/ |
| xyz-harness-gate | xyz-harness/skills/xyz-harness-gate/ |
| xyz-harness-frontend-dev | xyz-harness/skills/xyz-harness-frontend-dev/ |
| xyz-harness-backend-dev | xyz-harness/skills/xyz-harness-backend-dev/ |
| xyz-harness-test-driven-development | xyz-harness/skills/xyz-harness-test-driven-development/ |
| xyz-harness-subagent-driven-development | xyz-harness/skills/xyz-harness-subagent-driven-development/ |
| xyz-harness-code-standard-protection | xyz-harness/skills/xyz-harness-code-standard-protection/ |
| zcommit | xyz-harness/skills/zcommit/ |

Skill 为纯 Markdown 文件。总大小约 404KB。

### FR-4: 运行时 Binary 发现

**打包模式**（`app.isPackaged === true`）：`findPiExecutable()` 仅查找 bundled binary，不 fallback 到系统 pi。

查找路径：`join(process.cwd(), 'pi', 'pi-{platform}-{arch}')`

- Sidecar 的 cwd 在打包后等于 `process.resourcesPath`（由 runtime-manager.ts 设置）
- 找不到 = 致命错误，抛出异常

**开发模式**（`app.isPackaged === false`）：保持原有逻辑，搜索 PATH / nvm / 通用路径。

Sidecar 需要知道当前是否处于打包模式。通过环境变量传递：runtime-manager 启动 Sidecar 时注入 `XYZ_AGENT_PACKAGED=1`。

### FR-5: 环境变量注入

RpcClient 启动 pi 子进程时，注入以下环境变量：

| 环境变量 | 值 | 作用 |
|----------|---|------|
| `PI_CODING_AGENT_DIR` | `<resourcesPath>/pi/agent` | 让 pi 从 bundled agent 目录加载 extension/skill |

不打包 models.json。Provider 配置（API key、baseUrl、model 列表）全部通过 xyz-agent Settings UI → config-store → `buildProviderEnv()` → 环境变量注入。

### FR-6: electron-builder 配置

在 `electron-builder.yml` 中添加 `extraResources`：

```yaml
extraResources:
  - from: resources/pi
    to: pi
    filter:
      - "**/*"
      - "!**/*.tar.gz"
      - "!**/*.zip"
```

### FR-7: Git Submodule 集成

将 xyz-pi-extensions 和 xyz-harness 作为 git submodule 添加到 xyz-agent 仓库：

```
vendor/xyz-pi-extensions  → https://github.com/zhushanwen321/xyz-pi-extensions
vendor/xyz-harness         → https://github.com/zhushanwen321/xyz-harness
```

CI 和本地构建脚本从 submodule 复制 extension/skill 到 `resources/pi/agent/`。

### FR-8: CI 构建流程

在 `release.yml` 的每个平台 build job 中，`npm run build` 之前增加步骤：

1. **下载 pi binary**：`gh release download v${{ env.PI_VERSION }} -R earendil-works/pi -p "pi-{platform}-{arch}.{ext}" -D src-electron/resources/pi/`（PI_VERSION 通过 env 环境变量配置，硬编码为 spec 约定的版本号）
2. **解压**：tar/unzip，删除压缩包
3. **设置可执行权限**：`chmod +x`
4. **复制 extension/skill**：从 submodule 的 vendor/ 目录 cp -RL 到 `src-electron/resources/pi/agent/`

本地开发时的资源准备通过 scripts/ 脚本完成（见下方）。

### FR-9: 本地开发脚本

新增 `scripts/prepare-pi-resources.sh`，用于本地构建时准备 resources/pi 目录：

1. 下载当前平台 pi binary
2. 从 vendor/ submodule 复制 extension/skill
3. 开发模式不使用 bundled pi（保持原有 PATH 搜索），但脚本方便验证打包内容

## Acceptance Criteria

### AC-1: 打包后 pi 可启动

打包的 xyz-agent（DMG/NSIS/AppImage）启动后，Sidecar 能成功 spawn bundled pi binary，pi 进入 RPC 模式，正常响应 prompt 命令。

**验证方式**：打包后首次启动 xyz-agent，发送一条消息，确认 AI 正常回复。

### AC-2: 预装 Extension 可用

打包后，pi 的 `/subagent`、`/goal`、`/todo` 命令直接可用，无需用户手动安装。

**验证方式**：在打包的 xyz-agent 中发送 `/subagent task="echo hello"` 或 `/goal` 命令，确认 extension 正常加载。

### AC-3: 预装 Skill 可用

打包后，pi 能发现并加载 xyz-harness 的全部 19 个 skill。

**验证方式**：在打包的 xyz-agent 中使用任一 xyz-harness skill，确认正常触发。

### AC-4: 三平台构建通过

CI 的 macOS、Windows、Linux 三个 build job 均成功打包，产物中包含 pi binary + agent 目录。

**验证方式**：GitHub Release 上的 3 平台产物均正常上传。

### AC-5: 开发模式不受影响

开发模式下（`npm run dev`），pi 的发现和启动逻辑与当前行为一致（PATH/nvm 搜索），不依赖 resources/pi 目录。

**验证方式**：`npm run dev` 正常启动并发送消息。

### AC-6: 不与系统 pi 冲突

系统上已安装 pi（npm global）时，打包的 xyz-agent 使用自己的 bundled pi，不受系统 pi 影响。

**验证方式**：在有系统 pi 的机器上安装打包的 xyz-agent，确认使用 bundled 版本。

### AC-7: Provider 配置通过 UI 注入

用户在 xyz-agent Settings 中配置的 API key 和 provider 信息正常工作。bundled pi 不读取 `~/.pi/` 目录。

**验证方式**：配置 provider 后发送消息，确认 API 调用正常。

## Constraints

| 约束 | 值 |
|------|---|
| 支持平台 | macOS arm64, Windows x64, Linux x64（与当前 electron-builder 配置一致） |
| pi binary 来源 | `earendil-works/pi` GitHub Release 预编译 Bun binary |
| Extension 来源 | `zhushanwen321/xyz-pi-extensions` git submodule |
| Skill 来源 | `zhushanwen321/xyz-harness` git submodule |
| 包体积增加 | 约 70-120MB（pi binary）+ 600KB（extension + skill） |
| 运行时依赖 | 无（Bun binary 内嵌运行时，无需 Node.js） |
| pi 配置隔离 | 不读 `~/.pi/`，所有配置通过 xyz-agent UI + 环境变量注入 |
| 与系统 pi 的关系 | 严格隔离，不 fallback |

## Decisions Made

| 决策 | 选项 | 理由 |
|------|------|------|
| Binary 形态 | Bun 编译的独立 binary（非 npm install） | 体积小（70MB vs 179MB），无需 Node.js |
| Fallback 策略 | 严格只用 bundled pi，不 fallback | 版本一致性保证，避免用户环境差异 |
| Provider 配置 | 全部通过 xyz-agent UI，不打包 models.json | 不硬编码 API key，用户换机器只需重配 UI |
| Extension/Skill 来源 | Git submodule | 版本关系明确，CI 可复现 |
| 打包位置 | extraResources（非 asar 内） | pi 是独立可执行文件，不能在 asar 内运行 |

## 补充说明

### CI 构建矩阵与 pi binary 的关系

pi 提供 6 种平台/架构 variant（darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-arm64, windows-x64），但 xyz-agent 当前 CI 矩阵与 electron-builder 配置一致，仅构建 3 种：macOS arm64、Windows x64、Linux x64。每个 CI job 仅下载对应平台的 pi binary。

## Out of Scope

- 运行时自动更新 pi binary（升级 pi = 升级 xyz-agent）
- 用户自定义 extension/skill 的安装管理
- pi 的 settings.json 配置迁移
- 开发模式下使用 bundled pi
- macOS universal binary（仅 arm64）
- Windows arm64 支持（当前 electron-builder 仅配置 x64）
