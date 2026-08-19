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

## pi 行为观察项（未验证风险登记，2026-08-20 pi-assumption-remediation W6）

pi 升级（`PI_VERSION` bump）或触碰相关模块时逐条重验；锚点均为实装版（当前 0.84.1，核对方式见 AGENTS.md pi 段查阅规则）。来源：审计报告 A/B（`.xyz-harness/2026-08-19-pi-assumption-audit/`）。

### 1. F8：subagent-workflow SIGINT re-raise 在 pi 挂起窗口可能失效

- **pi 锚点**：`modes/interactive/interactive-mode.js:3193-3223`（handleCtrlZ 挂起期间注册空 `ignoreSigint`，SIGCONT 才移除）
- **机制**：`extensions/subagent-workflow/src/index.ts:654-680` 的 sigintHandler 收割后 re-raise SIGINT，依据「移除自身后无其他 SIGINT listener（pi 不注册）→ 默认终止」。该断言在 interactive 挂起（Ctrl-Z suspend）窗口不成立——re-raise 的 SIGINT 被 pi 的 `ignoreSigint` 吞掉，进程不死且本 extension listener 已移除，Ctrl+C 永久失效（直到 SIGCONT）
- **触发条件**：本地 pi CLI interactive 模式 + subagent-workflow extension 激活 + 进程挂起态（suspend to background）收到 SIGINT。xyz-agent 桌面链路不走这条（runtime supervisor 用 SIGTERM，pi rpc-mode 自带 SIGTERM handler）
- **处置建议**：re-raise 前检查 `process.listenerCount("SIGINT")`，移除自身后仍 >0 时不依赖默认终止，改用 `process.exit(exitCode)` 兜底。升级 pi 后若 interactive 模式信号处理有变，重测 Ctrl-Z 挂起 + Ctrl-C 组合

### 2. F10：jsonl-run-store「首写立即可见」在 pi 延迟首写窗口内不成立

- **pi 锚点**：`dist/core/session-manager.js:724-752`（`_persist` 无 assistant message 且未 flush 时仅内存记账不落盘；首条 assistant 到达才 `openSync("wx")` 全量写出）
- **机制**：`extensions/subagent-workflow/src/orchestration/jsonl-run-store.ts` 期望「run entry 写入即跨 session 重启可从 jsonl 发现」。新 session 经 /wf 命令启动 workflow（主 session 尚无 assistant）的窗口内 crash，run entry 只在内存，盘上无文件
- **触发条件**：全新 session + 首条 assistant 产出前 + 窗口内进程 crash/被杀 的三重组合（概率低，未实测可达性）
- **处置建议**：现有兜底已生效——读序 entry > state 文件（store 自写）> 空，crash 恢复仍可发现 run，无需改动。升级 pi 时核对 `_persist` 的 hasAssistant 延迟首写分支是否仍在；若 pi 改为立即落盘，此观察项可关闭

### 3. U1：pi-ai/compat 入口是上游自声明的临时模块（时间炸弹）

- **pi 锚点**：`pi-ai dist/compat.js` 头注释——"This module is deleted with the coding-agent ModelManager migration"（随 coding-agent ModelManager 迁移完成而删除）
- **机制**：`extensions/shared/llm-shared/src/call.ts:16-20` 顶层静态 `import { completeSimple, ... } from "@earendil-works/pi-ai/compat"`。上游删除该入口后加载期即炸，波及所有经 llm-shared 调 LLM 的 pi-* extension（goal / scheduler / structured-output 等）
- **触发条件**：升级到「ModelManager 迁移完成」版本的 pi-ai（无明确时间表，以 changelog / package.json exports 为准）
- **处置建议**：每次 pi 升级 PR 必查两项——`node -e "require.resolve('@earendil-works/pi-ai/package.json')"` 的 exports 是否仍含 `./compat`、pi-ai changelog 是否提及 ModelManager 迁移；命中时将 llm-shared 迁移到新 API（`createModels()` + provider factories），迁移前禁止发布依赖旧入口的 extension 版本

### 4. thinking 档位按模型族钳制且 pi 静默（final gate P2，2026-08-20）

- **pi 锚点**：`pi-ai models.js clampThinkingLevel`（不支持的档就近回落）；`types.d.ts:257`「xhigh/max 仅部分模型族支持」；`agent-session.js setThinkingLevel` 钳制后 isChanging=false → 不写 entry 不发事件
- **机制**：UI 思考档全集（off~max 7 档，W2 SSOT）对所有模型一视同仁——mimo 族实际止于 high，选「最高(max)」被 pi 钳到 high，用户无感知实际生效档位（session 建立后 UI 芯片会回落显示 pi 实际值 high，但选中瞬间的「最高」与实际不符）。reply/缓存已改回生效值（P3 修复），剩余缺口在 UI 侧无「该模型最高支持 X」提示
- **触发条件**：模型族 supported levels 不含所选档（mimo 族 + xhigh/max；其他族见 `get_available_thinking_levels` RPC）
- **处置建议**：UI 侧调 `get_available_thinking_levels`（pi RPC，按当前模型过滤档位或禁用置灰 + 提示「该模型最高支持 high」）。涉及 renderer 新 RPC 通路，未随 P3 顺手实施（scope 控制），需要时立项

### 5. fork 路径 spawn 仍可能带 --model 压过 fork 源模型终态（P1 同族，final gate 观察项）

- **机制**：restoreSession 已改 `inheritSessionModel: true`（P1 修复，模型终态由 pi 从 model_change entry 恢复）；forkSession 的 createSession 仍透传 presetClientOptions.model——fork 文件内若含 model_change entry（截断点之前有切换记录），附着后被 preset model（或全局默认兜底）压过，分叉会话模型 ≠ 源会话模型
- **触发条件**：fork 一个会话内切换过模型的 session（截断点在 model_change entry 之后）
- **处置建议**：与 P1 修复方向相同（fork 附着路径设 inheritSessionModel），但 fork 语义「launch 配置 vs 源终态谁优先」需产品裁决（fork 时用户可能正想换 launch 配置），且截断点早于首条 model_change 时无 entry 可恢复——登记待裁决，未随 P1 一并修（gate 只实证了 restore 路径）
