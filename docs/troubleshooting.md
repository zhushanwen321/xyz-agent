# xyz-agent 问题排查

项目没有文件日志系统，所有日志通过 console 输出。以下是各层的日志获取方式。

## 日志获取

| 层级 | 开发模式 | 打包模式 |
|------|---------|---------|
| **Electron 主进程** | 终端直接看 | 终端启动 `/Applications/xyz-agent.app/Contents/MacOS/xyz-agent` 或 `log show --process xyz-agent` |
| **Runtime（原 Sidecar）** | 终端 `[runtime:out]` / `[runtime:err]` 前缀 | 同主进程，stdout/stderr 转发到主进程 console |
| **pi 子进程** | 终端 pi 自身输出 | pi 日志目录 `~/.xyz-agent/pi/agent/logs/` |
| **前端 DevTools** | Cmd+Option+I 打开 | 同左 |

**打包模式启动应用获取完整日志**：

```bash
# 方法 1：终端启动（推荐，直接看到所有 console 输出）
/Applications/xyz-agent.app/Contents/MacOS/xyz-agent

# 方法 2：macOS 系统日志（过滤 xyz-agent 和 runtime 子进程）
log stream --predicate 'process == "xyz-agent"' --level debug

# 方法 3：Console.app → 搜索 xyz-agent
```

## 关键诊断路径

**打包后应用结构** (`/Applications/xyz-agent.app/Contents/Resources/`)：

```
Resources/
├── app.asar.unpacked/dist/runtime/   # runtime bundle（必须在 unpacked 目录）
│   ├── index.cjs                      # runtime 入口
│   └── plugin-bootstrap.cjs           # plugin Worker 入口
├── pi/                                # bundled pi 二进制 + agent 资源
│   ├── pi-darwin-arm64                # pi 可执行文件
│   ├── agent/                         # agent skills/extensions
│   └── assets/                        # agent 资源文件
└── xyz-agent-extension.js            # xyz-agent 定制 pi extension
```

> **注**：builtin pi extensions（`@zhushanwen/pi-*`）不再打包进产物。用户首次使用时在 Settings → Extensions 页面的「推荐扩展」区一键安装，安装到 `~/.xyz-agent/pi/agent/npm/node_modules/`。

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
ls -la /Applications/xyz-agent.app/Contents/Resources/pi/pi-darwin-*

# 检查 pi 二进制是否可执行
file /Applications/xyz-agent.app/Contents/Resources/pi/pi-darwin-arm64
chmod +x /Applications/xyz-agent.app/Contents/Resources/pi/pi-darwin-arm64  # 如果权限丢失

# 检查是否架构不匹配（Intel Mac 上只有 arm64 二进制）
uname -m  # arm64 还是 x86_64

# 终端启动看完整错误
/Applications/xyz-agent.app/Contents/MacOS/xyz-agent
```

常见原因：
- pi 二进制缺失（打包时 `extraResources` 配置错误或 `resources/pi/` 内容不完整）
- 权限丢失（`chmod +x`）
- 架构不匹配（Intel Mac 安装了 arm64-only DMG）
- symlink 问题（`resources/pi/` 中有指向外部绝对路径的 symlink，打包后目标不存在）

### 2. Runtime 启动失败："Runtime bundle not found" 或 "Runtime health check timed out"

```bash
# 检查 runtime bundle 是否存在于 unpacked 目录
ls -la /Applications/xyz-agent.app/Contents/Resources/app.asar.unpacked/dist/runtime/

# 手动启动 runtime 做冒烟测试
XYZ_AGENT_PACKAGED=1 ELECTRON_RUN_AS_NODE=1 \
  /Applications/xyz-agent.app/Contents/MacOS/xyz-agent \
  /Applications/xyz-agent.app/Contents/Resources/app.asar.unpacked/dist/runtime/index.cjs \
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

### 4. Extension 推荐安装失败

builtin pi extensions（`@zhushanwen/pi-goal` / `pi-todo` / `pi-subagents` / `pi-workflow` / `pi-structured-output`）不再打包进产物，用户在 Settings → Extensions 页面的「推荐扩展」区一键安装（走 `npm install` 到数据目录）。

```bash
# 检查用户级 npm extension 安装目录
ls ~/.xyz-agent/pi/agent/npm/node_modules/@zhushanwen/

# 检查 settings.json 的 packages[] 是否记录了该 extension
cat ~/.xyz-agent/pi/agent/settings.json | grep '@zhushanwen/pi'

# 检查 npm registry 可达性（安装失败最常见原因是网络）
npm view @zhushanwen/pi-goal version
```

若安装失败，在 Settings · Extensions 页面会有错误提示（红色横幅），含错误码：`not_found`（包名错误）、`network`（npm registry 不可达）、`not_extension`（包不是有效 pi extension）。

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
