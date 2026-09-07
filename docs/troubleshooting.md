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
│   └── @zhushanwen/<pkg>/             # 13 个 @zhushanwen/pi-*（esbuild bundle 产物）
└── bin/xyz-settings                   # xyz-settings CLI（pi Skill 引用）
```

> **注**：builtin pi extensions（13 个 `@zhushanwen/pi-*`）随应用打包内置在 `Resources/extensions/@zhushanwen/` 下，离线可用、无需安装。其中 infrastructure 级 6 个（`pi-pending-notifications` / `pi-session-reader` / `pi-structured-output` / `pi-agent-ext` / `pi-system-prompt` / `pi-msg-id-mapper`）不可禁用，feature 级 7 个可在 Settings → Extensions 中禁用/启用。第三方扩展（任意 npm 包 / 本地目录 / git）经 Settings → Extensions 安装到数据目录。

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

builtin pi extensions（13 个 `@zhushanwen/pi-*`）随应用打包内置，不经过 npm 安装，离线可用：

```bash
# 检查打包产物中的 builtin extensions
ls /Applications/太极.app/Contents/Resources/extensions/@zhushanwen/

# builtin 扩展不生效时，检查是否被禁用（infrastructure 级 6 个不可禁用）
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

### 6. subagent 没走 relay 通道：先查首启执行器探针（2026-08-25 relay 通道）

relay 激活前有一个执行器探针（spawn 执行器跑 `--eval "process.exit(0)"`，验证能以纯 node 语义执行 JS）。**探针失败会被缓存到 runtime 重启为止**（模块级 Map，key = 执行器路径），之后每次 spawn 主 pi 都直接回落现状直连、不再重试——所以「subagent 为什么没走 relay」第一件事是翻 runtime 启动后**首次**主 pi spawn 的日志：

```bash
grep "node executor probe failed" ~/.xyz-agent/logs/runtime-*.log   # dev 用 ~/.xyz-agent-dev
# 命中即：[relay] node executor probe failed for <execPath> (isElectron=...) — relay deactivated, spawning direct
```

另两个静默不激活的常态路径：staged 代理脚本缺失（`resources/extensions/@zhushanwen/pi-subagent-workflow/relay/relay.mjs`，bundle 登记未就绪属预期）、socket server 未监听。三者都不报错，只表现为回落直连。

### 7. bash 工具里启动 Electron 二进制被静默降级纯 node 模式（ELECTRON_RUN_AS_NODE=1）

打包模式下 relay 激活时会给**主 pi 进程 env 注入 `ELECTRON_RUN_AS_NODE=1`**（与 `XYZ_SUBAGENT_RELAY_*` 三 env 同点注入——代理 CLI 复用 Electron 二进制当纯 node 跑必需此变量）。该变量经握手帧原样透传给 relay 子进程及其后代，于是 **subagent 的 bash 工具里启动任何 Electron 二进制**（如 `npx electron .`、直接执行 .app 内的二进制）会被 Electron 静默切到纯 node 模式——无窗口、无报错，看起来像「命令没反应」。

定位：在 bash 工具里 `env | grep ELECTRON` 确认；这是 relay 通道的刻意设计（dev 模式执行器是独立 node、不注入）。终端服务不受影响（TerminalService 独立构造 env，已剥离该变量）。

### 8. runtime 启动即退出："fatal: relay server init failed"

relay socket server 在 runtime listen 后同步初始化，失败是 **fatal**（`console.error('[runtime] fatal: relay server init failed')` + exit 1，fail-fast 语义对齐 initLogger 先例）——覆盖/复用 socket 会劫持他人注册表，宁可不起。常见原因：

```bash
# <dataDir>/run 不可写（registry mkdirSync 抛错会走到这）
ls -la ~/.xyz-agent/run/          # dev 用 ~/.xyz-agent-dev
# 残留 socket 文件被活实例持有（实例冲突）
lsof | grep relay-.*\.sock
```

### 9. agent 会话内执行 validate-runtime-bundle 失败："Bundled pi binary not found"

**症状**：从 agent 会话内跑 `bash scripts/validate-runtime-bundle.sh` 报
`[runtime] fatal: relay server init failed: Error: Bundled pi binary not found at <root>/pi/pi-darwin-arm64`
被 commit 卡住；或 agent 会话内其它依赖「打包态判定」的行为异常（如 `isPackaged()` 返回错误结果）。

**根因**：agent 会话的 shell 环境里泄漏了本不该存在的 `XYZ_AGENT_PACKAGED=1`（打包标记只在 main→runtime
注入链上有意义；它一且出现在 agent 会话 env 里，会话内再起的 runtime 子进程就会误判自己运行在打包态，按打包路径解析捆绑二进制 → 必然找不到而 fatal）。历史受害链：runtime→pi 的 spawn 曾用整体替换式白名单 env 但未剥出站 deny 键，标志随继承链下潜到所有后代进程。

**治理现状**：已由子进程 env 出站契约治理（C-proc-09）——六个 spawn 点接线经 `buildOutboundChildEnv`
构建器组装（deny 剥 `XYZ_AGENT_PACKAGED` / `XYZ_RUNTIME_TOKEN`），pre-commit 守卫
`.githooks/check_spawn_env_boundary.py` 拦截未接线的新增调用点。

**如何确认**：
```bash
# 会话内直接查泄漏
# 会话内直接查泄漏：有输出 = 泄漏确认（出站契约只保证会话内再 spawn 的子进程
# 不再携带该标志，不影响本会话自身的 env 快照）
printenv | grep XYZ_AGENT_PACKAGED
# 旁证对照：剥除后重跑原命令应恢复正常
env -u XYZ_AGENT_PACKAGED bash scripts/validate-runtime-bundle.sh
```
若仍命中，说明该调用点未经出站契约构建器（守卫漏网或存量豁免），带着报错文件行号去
`.githooks/check_spawn_env_boundary.py` 豁免名单核对。
### 10. 升级中断手动恢复（升级脚本 staging 状态机残余窗口）

自动升级在换装阶段（备份 mv 与原子换装 mv 之间，毫秒级窗口）被断电/强杀命中时，app 无法自愈（自愈代码运行在 app 进程内，此时无执行机会）：**双击图标无反应、`/Applications` 下 `太极.app` 缺失，同时存在 `太极.app.old` / `太极.app.new`**。`(.old 与 .new 均为完整可用副本，缺失的只是正式位置的名字。)

识别残留：

```bash
ls -la /Applications/ | grep '太极.app'
# 典型残留形态：太极.app 不在列表，太极.app.old 与 太极.app.new 同时存在
```

二选一恢复（执行后 app 即可正常启动）：

```bash
# 回到旧版（丢弃未装完的新版）
mv /Applications/太极.app.old /Applications/太极.app

# 改用手动装新版（丢弃备份的旧版；若 .new 版本异常可再换回旧版命令）
mv /Applications/太极.app.new /Applications/太极.app
```

补充：`.old` 或 `.new` 单独残留（`太极.app` 在位且可启动）属良性残留，下次启动自动清理，无需手动处理；从 DMG 只读卷运行时升级会被拒绝（update-result 写 `read-only volume`），请先将 `太极.app` 拖入「应用程序」文件夹再触发升级。

### 11. pnpm install 报 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY（间歇，单跑却成功）

**现象**：commit / e2e 脚本里 `pnpm install` 间歇失败：`Aborted removal of modules directory due to no TTY`；同一命令单独重跑有时成功（假象：管道里 `| tail` 后 `$?` 是 tail 的退出码，`--silent` 还会吞掉真实报错）。pre-commit 的插件端到端验收随机红，`CI=true` 可"治愈"但会复发。

**根因**（2026-09-03 PR #196 实战定位）：pnpm store 路径默认随 **HOME** 解析。zsw 引擎 worker 覆写 HOME（`~/.zcode/zsw/engines/*/home-appserver`）→ 引擎侧 pre-commit 内 verify-*.sh 自含 install 把**引擎侧 store** 写进 `node_modules/.modules.yaml` 的 `storeDir`；本地（正常 HOME）install 发现 storeDir 与自身解析不一致 → 判定 node_modules 布局过期 → 要求删除重建 → 非 TTY abort。**双向翻转**：谁最后 install 谁的 storeDir 生效，另一侧下次 install 就崩。

排障口诀：

```bash
grep storeDir node_modules/.modules.yaml
# ~/.pnpm-store/v10 = 本地布局（健康）；~/.zcode/zsw/... = 被引擎侧翻转（先恢复再 commit）
```

恢复：

```bash
CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install   # 约 6-7s 重建本地布局，然后重试 commit
```

**防护与根治**：护栏 `.githooks/check_pnpm_store_layout.sh` 挂在 pre-commit 第 0 段（install-hooks.sh 生成）与 validate-runtime-bundle.sh Gate 0，翻转即红并输出 [FIX] 指引——同时也兼作引擎侧「不覆写 HOME」修复的验收探针（修复落地后护栏应恒绿，红 = 回退信号）。根治在引擎侧不覆写 HOME（2026-09-03 开发中）；备选方案 `.npmrc` pin `store-dir` 评估结论：`~` 展开仍 HOME 相对（无效）、相对路径解析基准未验证（有 per-package store 撕裂风险）、写死绝对路径不可移植——均不采用。

## 环境变量速查

| 变量 | 用途 | 生产默认值 | 开发默认值 |
|------|------|-----------|------------|
| `XYZ_AGENT_DATA_DIR` | 数据目录 | `~/.xyz-agent` | `~/.xyz-agent-dev` |
| `XYZ_AGENT_PORT_OFFSET` | 端口偏移 | `0` | `100` |
| `XYZ_AGENT_PACKAGED` | 打包标记 | `1` | 未设置 |
| `ELECTRON_RUN_AS_NODE` | Node 模式 | `1`（runtime 子进程） | 未设置 |
| `VITE_MOCK=true` | Mock 模式 | — | 可选 |
| `XYZ_RUNTIME_BASH_RPC_TIMEOUT_MS` | bash RPC 超时逃生门（0=不限时） | 未设置（默认 1h） | 可选 |

> 注意：`XYZ_RUNTIME_BASH_RPC_TIMEOUT_MS` 在 runtime 进程生命周期内**读一次即缓存**（`rpc-client.ts` resolveBashRpcTimeoutMs——中途改 env 不生效且无提示，超时决策须进程内稳定）。改后必须重启应用/`pnpm dev` 才生效。

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

### closedReason:"gc" 是统一终态占位，不是故障（2026-08-27 事故 A）

pi 的 session close 事件把 done/failed/crashed 等全部终态统一坍缩为 `closed + closedReason:"gc"`——**"gc" 是「非用户主动关闭」的占位终态，不代表垃圾回收、不代表异常**。看到它先别当故障查。

- 判读指引：**看 outcome 字段**（completed / failed / cancelled 一等字段，切片 1 subagent-dispatch-reliability 已保证向后兼容输出）——不要对 closedReason 做 switch 推导成败；历史上下游三处同构各自重新推导成败，是「写入时坍缩」问题类的温床
- 排查「subagent 为什么显示 gc」时：先查该 subagent 的 outcome 与退出码；closedReason 本身恒无信息量；若消费方还在读 closedReason 判成败，改为消费 outcome

### 模型名大小写漂移致 429：「昨天能用今天炸」的排查路径（2026-08-27 事故 A）

pi 的 models-store.json 远端目录周期刷新（PS-11）可引入大小写家族条目，`--model` pattern 匹配结果随时间漂移——同一串昨日全等命中、今日掉进模糊分支命中无权限模型，表象是「昨天能用的模型今天 429」。

- 排查路径：① 查 `<agentDir>/models-store.json` 的 mtime/新增条目（大小写变体家族）；② 派发侧走 G4 孪生守卫复现——start 同步期对含歧义大小写变体的 registry 拒单并报「registry 含歧义大小写变体」；③ 确认派发模型入参是全等 id（`assertCanonicalModelRef`），禁裸串拼 `--model`（`check_subagent_channels.py` 拦截）
- 预防：新代码不拼 `--model` 字符串（shared/model-ref.ts 唯一入口）；能力面一律消费注册表 supportedLevels（C-pi-12）；机制详情见观察项 #6（PS-01）

### 共享 pre-commit hook 被旧版 install-hooks.sh 覆盖（2026-09-04 流写护栏事故复发）

bare repo + worktree 结构下，`.bare/hooks/pre-commit` 是全部 worktree 共享的运行时副本，由各 worktree 自己的 `.githooks/install-hooks.sh`（SSOT 在各自分支）在 `pnpm install` 的 prepare 阶段生成。**任一旧分支 worktree 跑 `pnpm install`，都会用它分支的旧版源无条件覆盖共享副本**——护栏段静默消失（旧版源既没有护栏段也没有安装后自检，覆盖时零告警）。

- 现象：本地 commit 不再触发流写逃逸护栏（或整套 pre-commit 检查行为变旧）；曾两次实际发生（2026-09-04 S2 验收发现 SSOT 缺口、当晚 design-code-sync R3 发现被旧源覆盖复发）
- 检测：`grep -c 'UNSAFE_STREAM_CHECKER=' <bare>/hooks/pre-commit`（bare 目录用 `git rev-parse --git-common-dir` 推导）——结果为 0 即被旧源覆盖；新版 install-hooks.sh 安装后自带同款自检（源缺段时 exit 1），但拦不住旧源覆盖（旧源无自检）
- 恢复：在含最新护栏段的分支（≥ 4ecea728f）worktree 里跑 `bash .githooks/install-hooks.sh` 重装共享副本
- 根治：旧 worktree 的分支更新到含护栏段与自检的基线后自然消除；在合并前，任何 worktree 的 `pnpm install` 后建议复跑上面的检测命令。CI invariant（ci.yml 独立跑护栏脚本）在本地失效窗口期兜底拦新增裸写点

## 周期轮询/兜底定时器的合法性判定（2026-08-28）

新增任何周期定时器（setInterval / 递归 setTimeout 循环 / 轮询兜底）前，必须按下表归类并回答该类的问题；处置台账与外部对照证据见 [design/pi-boundary-reliability.md 附录 C](design/pi-boundary-reliability.md#附录-c轮询定时器处置全清单2026-08-28d9-执行台账)。**判定原则：变化时对方会主动 push 的信息，禁止用周期 pull 兜底**——兜底轮询会掩盖主链路 bug（事故 B 的 30s 轮询就让「回执丢失」隐性存在了很久）。

| 类 | 判据 | 规则 | 实例 |
|---|---|---|---|
| ① 自有状态对账 | 状态变化 100% 经由自身请求/事件路径 | **禁止周期轮询**。主链路 = 回执 + 事件失效；周期 pull 会掩盖主链路 bug | thinkingLevel 30s 轮询（已随设计定案删除，附录 C.4） |
| ② 活性探测 | 对端死掉/卡死时无法自报 | 允许，但**优先升级式触发**（事件静默超时 / 请求失败再探），无条件周期须论证 | pingPi 60s、WS 15s ping+45s watchdog、Electron 30s /health |
| ③ 外部世界 | 数据源在外部、无 push 通道 | 允许轮询；频率 = 外部约束（API 限额 / 下游缓存 TTL），不做无依据加密 | 应用更新检查（GitHub 限额 60 次/h → 60min 间隔） |
| ④ 空转 | 有 push 通道仍轮询，或产出数据无消费者 | **删除或事件化** | plugin-host 30s memory monitor（lastActiveAt 只写不读，已删）、handoff 2s 轮询（onExit 多播化后已事件化） |

新增定时器必须自答三个问题（写进代码注释）：**这个信息会变吗？变的时候对方为什么不 push？轮询周期掩盖的是什么主链路缺口？** 答不出第三个问题 = 该定时器在代偿某个未修的主链路 bug，先修主链路。

历史锚点：2026-08-28 D9 处置前全仓 12 处常规定时机制，经 ZCode / deepseek-harness / opencode 源码对照后 5 项当日删减或降频、1 项定案删除——「兜底轮询保平安」哲学被实证推翻，外部实现靠「被动信号 + 有界预算 + 便宜重建」达到同等可靠性。

## pi 行为观察项（未验证风险登记，2026-08-20 pi-assumption-remediation W6）

pi 升级（`PI_VERSION` bump）或触碰相关模块时逐条重验；锚点均为实装版（当前 0.84.4，核对方式见 AGENTS.md pi 段查阅规则）。来源：审计报告 A/B（`.xyz-harness/2026-08-19-pi-assumption-audit/`）。

**机器登记互链（2026-08-28 pi-boundary-reliability）**：本节是人读处置层，每条对应 [docs/pi-semantics.json](pi-semantics.json) 的 PS-xx 条目（唯一机器源：probe 型配探针测试，observe 型即本节处置建议）；pi 升级时 `node scripts/check-pi-semantics.mjs`（pre-commit + CI）自动门禁版本漂移。机制描述不双写——语义断言与 pi 锚点的权威源是 json，本节只留处置建议。

### 1. F8：subagent-workflow SIGINT re-raise 在 pi 挂起窗口可能失效（PS-13）

- **pi 锚点**：`modes/interactive/interactive-mode.js:3193-3223`（handleCtrlZ 挂起期间注册空 `ignoreSigint`，SIGCONT 才移除）
- **机制**：`extensions/subagent-workflow/src/index.ts:654-680` 的 sigintHandler 收割后 re-raise SIGINT，依据「移除自身后无其他 SIGINT listener（pi 不注册）→ 默认终止」。该断言在 interactive 挂起（Ctrl-Z suspend）窗口不成立——re-raise 的 SIGINT 被 pi 的 `ignoreSigint` 吞掉，进程不死且本 extension listener 已移除，Ctrl+C 永久失效（直到 SIGCONT）
- **触发条件**：本地 pi CLI interactive 模式 + subagent-workflow extension 激活 + 进程挂起态（suspend to background）收到 SIGINT。xyz-agent 桌面链路不走这条（runtime supervisor 用 SIGTERM，pi rpc-mode 自带 SIGTERM handler）
- **处置建议**：re-raise 前检查 `process.listenerCount("SIGINT")`，移除自身后仍 >0 时不依赖默认终止，改用 `process.exit(exitCode)` 兜底。升级 pi 后若 interactive 模式信号处理有变，重测 Ctrl-Z 挂起 + Ctrl-C 组合

### 2. F10：jsonl-run-store「首写立即可见」在 pi 延迟首写窗口内不成立（PS-14）

- **pi 锚点**：`dist/core/session-manager.js:724-752`（`_persist` 无 assistant message 且未 flush 时仅内存记账不落盘；首条 assistant 到达才 `openSync("wx")` 全量写出）
- **机制**：`extensions/subagent-workflow/src/orchestration/jsonl-run-store.ts` 期望「run entry 写入即跨 session 重启可从 jsonl 发现」。新 session 经 /wf 命令启动 workflow（主 session 尚无 assistant）的窗口内 crash，run entry 只在内存，盘上无文件
- **触发条件**：全新 session + 首条 assistant 产出前 + 窗口内进程 crash/被杀 的三重组合（概率低，未实测可达性）
- **处置建议**：现有兜底已生效——读序 entry > state 文件（store 自写）> 空，crash 恢复仍可发现 run，无需改动。升级 pi 时核对 `_persist` 的 hasAssistant 延迟首写分支是否仍在；若 pi 改为立即落盘，此观察项可关闭

### 3. U1：pi-ai/compat 入口是上游自声明的临时模块（时间炸弹）（PS-15）

- **pi 锚点**：`pi-ai dist/compat.js` 头注释——"This module is deleted with the coding-agent ModelManager migration"（随 coding-agent ModelManager 迁移完成而删除）
- **机制**：`extensions/shared/llm-shared/src/call.ts:16-20` 顶层静态 `import { completeSimple, ... } from "@earendil-works/pi-ai/compat"`。上游删除该入口后加载期即炸，波及所有经 llm-shared 调 LLM 的 pi-* extension（goal / scheduler / structured-output 等）
- **触发条件**：升级到「ModelManager 迁移完成」版本的 pi-ai（无明确时间表，以 changelog / package.json exports 为准）
- **处置建议**：每次 pi 升级 PR 必查两项——`node -e "require.resolve('@earendil-works/pi-ai/package.json')"` 的 exports 是否仍含 `./compat`、pi-ai changelog 是否提及 ModelManager 迁移；命中时将 llm-shared 迁移到新 API（`createModels()` + provider factories），迁移前禁止发布依赖旧入口的 extension 版本

### 4. thinking 档位按模型族钳制且 pi 静默（final gate P2，2026-08-20）（PS-12）

- **pi 锚点**：`pi-ai models.js clampThinkingLevel`（不支持的档就近回落）；`types.d.ts:257`「xhigh/max 仅部分模型族支持」；`agent-session.js setThinkingLevel` 钳制后 isChanging=false → 不写 entry 不发事件
- **机制**：UI 思考档全集（off~max 7 档，W2 SSOT）对所有模型一视同仁——mimo 族实际止于 high，选「最高(max)」被 pi 钳到 high，用户无感知实际生效档位（session 建立后 UI 芯片会回落显示 pi 实际值 high，但选中瞬间的「最高」与实际不符）。reply/缓存已改回生效值（P3 修复），剩余缺口在 UI 侧无「该模型最高支持 X」提示
- **触发条件**：模型族 supported levels 不含所选档（mimo 族 + xhigh/max；其他族见 `get_available_thinking_levels` RPC）
- **处置建议**：UI 侧调 `get_available_thinking_levels`（pi RPC，按当前模型过滤档位或禁用置灰 + 提示「该模型最高支持 high」）。涉及 renderer 新 RPC 通路，未随 P3 顺手实施（scope 控制），需要时立项。**2026-08-28 更新**：档位可用集已由能力注册表结构性解决（C-pi-12：runtime 经 pi-ai 同源函数算 supportedLevels 下发，前端零推导；探针断言见 PS-12 条目）

### 5. fork 路径 spawn 仍可能带 --model 压过 fork 源模型终态（P1 同族，final gate 观察项）（PS-16）

- **机制**：restoreSession 已改 `inheritSessionModel: true`（P1 修复，模型终态由 pi 从 model_change entry 恢复）；forkSession 的 createSession 仍透传 presetClientOptions.model——fork 文件内若含 model_change entry（截断点之前有切换记录），附着后被 preset model（或全局默认兜底）压过，分叉会话模型 ≠ 源会话模型
- **触发条件**：fork 一个会话内切换过模型的 session（截断点在 model_change entry 之后）
- **处置建议**：与 P1 修复方向相同（fork 附着路径设 inheritSessionModel），但 fork 语义「launch 配置 vs 源终态谁优先」需产品裁决（fork 时用户可能正想换 launch 配置），且截断点早于首条 model_change 时无 entry 可恢复——登记待裁决，未随 P1 一并修（gate 只实证了 restore 路径）

### 6. `--model` 是 pattern 非精确 ID：大小写/包含匹配可静默换模（PS-01，2026-08-27 事故 A）

- **pi 锚点**：`dist/cli/args.js:245`（help 自述 "Model pattern or ID"）；`dist/core/model-resolver.js` findExactModelReferenceMatch（id 匹配为 toLowerCase 相等，canonical 双命中判歧义作废）→ 无 exact 命中时 contains 模糊 → `localeCompare` 降序取最大
- **机制**：「扩展层校验通过」不代表「子进程按此 id 执行」——两套匹配规则互不知晓；models-store 刷新引入小写变体家族后（PS-11），昨日全等命中的串今日可掉进模糊分支命中别的模型 → 429 无权限空转
- **触发条件**：派发用非全等 id + 合并清单含大小写家族条目
- **处置建议**：已由切片 1 全等裁决结构性拦截（`assertCanonicalModelRef`，start 同步期拒单 + 问句式纠错）；新扩展拼 `--model` 必须经 shared/model-ref.ts（G4 通道禁则拦裸串）；探针断言见 pi-semantics-model-resolution.test.ts

### 7. reasoning 是思考能力总开关，缺失即「仅关」（PS-02，2026-08-27 事故 B）

- **pi 锚点**：`pi-ai dist/models.js:546-557`——getSupportedThinkingLevels 在 `!model.reasoning`（含 undefined）时直接返回 `["off"]`，thinkingLevelMap 仅在开关打开后参与档位计算
- **机制**：同一字段缺失两侧语义相反——pi 解释 undefined 为「关」，历史上前端 resolveAvailableLevels 解释为「支持全档」；GUI 手动添加模型若无 reasoning 字段，思考等级设置恒被钳回 off（用户表象：「设了最高过一会自动变关」，实际从第一毫秒起就是关）
- **处置建议**：已由能力注册表结构性消除（C-pi-12：runtime 经 pi-ai 同源函数算 supportedLevels 下发，前端零推导；addModel 表单显式写 reasoning）——禁止任何域内代码复活「本地推断档位」

### 8. set_thinking_level RPC 响应无 data，生效值须补读（PS-03，2026-08-27 事故 B）

- **pi 锚点**：`dist/modes/rpc/rpc-mode.js:387-389`——set_thinking_level 分支 `session.setThinkingLevel(command.level)` 后 return success 无第三参
- **机制**：改状态 RPC 的返回不含生效值；pi 钳制档位时请求值 ≠ 生效值，读不到生效值就是显示假值（事故 B 的回执断在最后一跳）
- **处置建议**：runtime 的 set→get_state→effective 回执链是唯一正确姿势（已实装）；已登记 C-pi-13（改状态 RPC 一律回生效值，消费方禁乐观写请求值）

### 9. steer / nextTurn 是 at-most-once 内存队列，消费窗极窄（PS-05/06，2026-08-27 事故 A）

- **pi 锚点**：`pi-agent-core dist/agent.js:321/:243`（steeringQueue 全文仅 2 个 drain 点：run 轮询 getSteeringMessages / 手动 continue()，run 收尾后无补触发）；`dist/core/agent-session.js` `_pendingNextTurnMessages` 唯一 drain 点 = 用户驱动 prompt()（注入后立即清空）
- **机制**：投递内核重试的是「send 函数调用」而非「消息进入主会话」这一事实——依赖它们发终态通知 = 基线 session 十余次完成仅 1 次送达（事故 A 实测）
- **处置建议**：结果语义通知必须走确认式送达（C-ext-19：session-delivery 账本 + 幂等键，at-least-once）；steer/followUp 仅限交互式注入（非结果语义）；探针断言见 pi-semantics-steering-drain / agent-session.test.ts

### 10. settled 事件先复位再广播：边沿回调内 isIdle 恒真（PS-07）

- **pi 锚点**：`dist/core/agent-session.js:325-336`——`_emitAgentSettled` 首行复位 `_isAgentRunActive = false` 再发 agent_settled 事件
- **机制**：settled 边沿驱动的通知通道不会撞上残留 busy 态——notify-ledger 的 settled 边沿 courier 依赖此序；若 pi 未来调换次序，courier 投递时序需重验
- **处置建议**：探针守卫（pi-semantics-agent-session.test.ts）；消费 settled 边沿的新代码可假定回调内 idle，但 pi 升级时此条目自动进重验清单（verifiedWith 门禁）

### 11. plain appendEntry（type=custom）不进 LLM 上下文（PS-09）

- **pi 锚点**：`dist/core/session-manager.js:165-186`——sessionEntryToContextMessages 仅映射 message/custom_message/branch_summary/compaction，兑底返回 `[]`
- **机制**：appendEntry 写的 custom entry 是持久化状态记录，AI 看不到；想让 AI 看到必须走 custom_message（sendCustomMessage）或 sendUserMessage
- **处置建议**：这正是 extension 日志规范选 appendEntry 做「事后排查」通道的技术依据（不耗 token，见 logging-conventions.md）；反向地，靠 appendEntry「通知 AI」的代码是 bug——结果语义通知走账本 courier（C-ext-19）
