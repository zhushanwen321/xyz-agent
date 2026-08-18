# xyz-agent 问题排查

Runtime 日志落盘到 `<数据目录>/logs/`（`runtime-YYYY-MM-DD.log`，按天轮转 + 大小滚动），pi 子进程 stdout 的 JSONL 事件流独立落盘为 `pi-<date>-<sessionId>.jsonl`（pi 卡死类问题的决定性证据）。console 输出同步 tee 到终端。以下是各层的日志获取方式。

## 日志获取

| 层级 | 开发模式 | 打包模式 |
|------|---------|---------|
| **Electron 主进程** | 终端直接看 | 终端启动 `/Applications/太极.app/Contents/MacOS/TaiJi` 或 `log show --process TaiJi` |
| **Runtime** | 终端 `[runtime:out]` / `[runtime:err]` 前缀 + `~/.xyz-agent-dev/logs/runtime-*.log` | 同主进程转发 + `~/.xyz-agent/logs/runtime-*.log` |
| **pi 子进程** | 终端 pi 自身输出 + `~/.xyz-agent-dev/logs/pi-<date>-<sessionId>.jsonl` | `~/.xyz-agent/logs/pi-<date>-<sessionId>.jsonl` + pi 日志目录 `~/.xyz-agent/pi/agent/logs/` |
| **前端 DevTools** | Cmd+Option+I 打开 | 同左 |

**打包模式启动应用获取完整日志**：

```bash
# 方法 1：终端启动（推荐，直接看到所有 console 输出）
/Applications/太极.app/Contents/MacOS/TaiJi

# 方法 2：macOS 系统日志（过滤 TaiJi 和 runtime 子进程）
log stream --predicate 'process == "TaiJi"' --level debug

# 方法 3：Console.app → 搜索 TaiJi
```

## 关键诊断路径

**打包后应用结构** (`/Applications/太极.app/Contents/Resources/`)：

```
Resources/
├── app.asar.unpacked/dist/runtime/   # runtime bundle（必须在 unpacked 目录）
│   ├── index.cjs                      # runtime 入口
│   └── plugin-bootstrap.cjs           # plugin Worker 入口
├── pi/                                # bundled pi 二进制 + agent 资源
│   ├── pi-darwin-arm64                # pi 可执行文件
│   ├── agent/                         # agent skills/extensions
│   └── assets/                        # agent 资源文件
├── extensions/                        # builtin pi extensions
│   └── @zhushanwen/<pkg>/             # 10 个 @zhushanwen/pi-*（esbuild bundle 产物）
└── xyz-agent-extension.js             # xyz-agent 定制 pi extension
```

> **注**：builtin pi extensions（10 个 `@zhushanwen/pi-*`）随应用打包内置在 `Resources/extensions/@zhushanwen/` 下，离线可用、无需安装。其中 infrastructure 级 3 个（`pi-pending-notifications` / `pi-session-reader` / `pi-structured-output`）不可禁用，feature 级 7 个可在 Settings → Extensions 中禁用/启用。第三方扩展（任意 npm 包 / 本地目录 / git）经 Settings → Extensions 安装到数据目录。

**数据目录** (`~/.xyz-agent/`)：

```
~/.xyz-agent/
├── config.json           # 运行时配置（API key 等）
├── config.toml           # pi 配置
├── runtime.port          # runtime 端口号（文本文件）
├── session-data/         # session 持久化数据
├── pi/agent/logs/        # pi 日志
└── plugins/              # 插件数据
```

**开发模式差异**：数据目录 `~/.xyz-agent-dev/`，端口 +100（3310-3320），Electron userData 隔离。

## 常见问题排查清单

### 1. pi 启动失败："Failed to start bundled pi process"

```bash
# 检查 pi 二进制是否存在
ls -la /Applications/太极.app/Contents/Resources/pi/pi-darwin-*

# 检查 pi 二进制是否可执行
file /Applications/太极.app/Contents/Resources/pi/pi-darwin-arm64
chmod +x /Applications/太极.app/Contents/Resources/pi/pi-darwin-arm64  # 如果权限丢失

# 检查是否架构不匹配（Intel Mac 上只有 arm64 二进制）
uname -m  # arm64 还是 x86_64

# 终端启动看完整错误
/Applications/太极.app/Contents/MacOS/TaiJi
```

常见原因：
- pi 二进制缺失（打包时 `extraResources` 配置错误或 `resources/pi/` 内容不完整）
- 权限丢失（`chmod +x`）
- 架构不匹配（Intel Mac 安装了 arm64-only DMG）
- symlink 问题（`resources/pi/` 中有指向外部绝对路径的 symlink，打包后目标不存在）

### 2. Runtime 启动失败："Runtime bundle not found" 或 "Runtime health check timed out"

```bash
# 检查 runtime bundle 是否存在于 unpacked 目录
ls -la /Applications/太极.app/Contents/Resources/app.asar.unpacked/dist/runtime/

# 手动启动 runtime 做冒烟测试
XYZ_AGENT_PACKAGED=1 ELECTRON_RUN_AS_NODE=1 \
  /Applications/太极.app/Contents/MacOS/TaiJi \
  /Applications/太极.app/Contents/Resources/app.asar.unpacked/dist/runtime/index.cjs \
  --port=9999
# 然后 curl http://localhost:9999/health
```

常见原因：
- `asarUnpack` 失效（`files` 排除了 `dist/runtime`，导致无文件可 unpack）
- `tsup.config.ts` 的 `noExternal` 缺少新依赖，运行时 `Cannot find module`
- 端口范围 3210-3220 全部被占用

### 3. 端口冲突

```bash
# 检查 runtime 端口
cat ~/.xyz-agent/runtime.port

# 检查端口占用
lsof -i :3210 -P | grep LISTEN

# 清理残留进程
lsof -i :3210-3220 -P | grep LISTEN | awk '{print $2}' | sort -u
```

### 4. Extension 相关问题

builtin pi extensions（10 个 `@zhushanwen/pi-*`）随应用打包内置，不经过 npm 安装，离线可用：

```bash
# 检查打包产物中的 builtin extensions
ls /Applications/太极.app/Contents/Resources/extensions/@zhushanwen/

# builtin 扩展不生效时，检查是否被禁用（infrastructure 级 3 个不可禁用）
cat ~/.xyz-agent/pi/agent/settings.json
```

第三方扩展（任意 npm 包 / 本地目录 / git）经 Settings → Extensions 页面安装，走 `npm install` 到数据目录，安装失败最常见原因是网络：

```bash
# 检查用户级 npm extension 安装目录
ls ~/.xyz-agent/pi/agent/npm/node_modules/@zhushanwen/

# 检查 settings.json 的 packages[] 是否记录了该 extension
cat ~/.xyz-agent/pi/agent/settings.json | grep '@zhushanwen/pi'

# 检查 npm registry 可达性
npm view @zhushanwen/pi-goal version
```

若安装失败，在 Settings · Extensions 页面会有错误提示，错误码来自 npm installer：`not_found`（包名错误）、`network`（npm registry 不可达）、`extract` / `integrity`（下载内容异常）。

### 5. Dev 模式 Vite 不更新

```bash
# 确认 1420 端口属于当前 worktree
lsof -i :1420 -P | grep node
# 检查进程 cwd 是否指向当前 worktree 的 renderer 目录
```

## 环境变量速查

| 变量 | 用途 | 生产默认值 | 开发默认值 |
|------|------|-----------|------------|
| `XYZ_AGENT_DATA_DIR` | 数据目录 | `~/.xyz-agent` | `~/.xyz-agent-dev` |
| `XYZ_AGENT_PORT_OFFSET` | 端口偏移 | `0` | `100` |
| `XYZ_AGENT_PACKAGED` | 打包标记 | `1` | 未设置 |
| `ELECTRON_RUN_AS_NODE` | Node 模式 | `1`（runtime 子进程） | 未设置 |
| `VITE_MOCK=true` | Mock 模式 | — | 可选 |

## 历史排查规则 [HISTORICAL]（从 AGENTS.md 外移 2026-08-17）

### git status untracked 目录展开

`GitService.getStatus` 执行 `git status --porcelain=v1 -z -b` **必须带 `--untracked-files=all`**。

- 根因：默认 git 把整个 untracked 目录折叠成一行 `?? dir/`（**带尾斜杠**）。文件树 `FileNode.path` 无尾斜杠，两者失配 → overlay key 查不到 → 目录徽章误显（前缀匹配命中自身那条带斜杠记录）、展开后子文件无角标无行数
- 修复：`--untracked-files=all`（`-uall`）强制展开每个 untracked 文件到文件级，与 `FileNode.path` 格式一致。`.gitignore` 仍生效，不会因 node_modules 等爆量
- 修改位置：`packages/runtime/src/services/git-service.ts` getStatus。测试基线：`git-service.test.ts` 断言了命令参数

### 禁止写死项目绝对路径

runtime 代码禁止出现特定项目的绝对路径或硬编码假设，所有 workspace / bare repo / 数据目录路径必须从运行时上下文动态推导（xyz-agent 是通用工具，用户会在任意 bare repo + worktree 项目中使用）。

- workspace 根 / bare repo：`WorkspaceDetector.detect(currentCwd)` 向上查找 `.bare`（`workspace-detector.ts`）
- 数据目录：`getDataDir()` / `getConfigDir()`（`packages/shared/src/paths.ts`）
- 检查：`grep -rn "xyz-agent-workspace\|/Users/zhushanwen" packages/runtime/src/` 不得在逻辑代码中出现硬编码绝对路径
- 关联教训（spawn 权限）：git 跟踪的脚本默认 644 无 x 位，直接 `spawn(scriptPath)` 会 EACCES；执行外部脚本用 `spawn('bash', [scriptPath, ...args])` 包装

### 跨层机制排查必须穷尽所有层（pi extension ↔ xyz-agent runtime）

分层架构里，每层只看自己视角，「我这层没做」≠「没发生」。涉及 pi extension ↔ xyz-agent runtime 的跨层机制排查，必须穷尽所有可能发起方，不能只看 xyz-agent runtime 侧就下结论。

- 事故：排查「background subagent 完成后主 agent 是否续跑」，explorer 只看 xyz-agent runtime 就断言「不续跑」，差点设计出「永不响」的错方案。真相：续跑由 pi 进程内的 extension 发起（pi-subagent-workflow notifier 调 `pi.sendMessage(..., {triggerTurn:true, deliverAs:'steer'})`，pi 核心收到后开新 turn），xyz-agent runtime 只是旁观转发
- 排查步骤：① xyz-agent runtime 侧（event-interpreter / session-service / message-dispatcher）只是旁观转发；② pi extension 机制（pi 进程内）——开发期源码在本项目 `extensions/`，用户机器运行时安装在 `~/.xyz-agent/pi/agent/npm/node_modules/@zhushanwen/pi-*/src/`；③ pi 私有协议（`triggerTurn`/`deliverAs`）语义见 `packages/shared/src/message.ts` 注释；④ 设计文档：`docs/page-design/archive/v3/` + `docs/extensions/extension-conventions.md`
- 判断依据：涉及 pi 的 session loop / turn 调度 / LLM 调用的行为，发起方几乎一定在 pi 进程内；xyz-agent 的职责是 UI 状态同步 + 用户命令转发
- 教训：当用户的领域知识与 explorer 结论冲突时，**优先怀疑 explorer 排查范围不全**，而非怀疑用户
