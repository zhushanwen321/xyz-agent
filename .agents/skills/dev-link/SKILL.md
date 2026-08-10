# Dev Link

管理 `@zhushanwen/pi-*` extension 在**本地源码（live edit）**与**已发布版本**之间切换。两种模式，按测试目标选——选错模式是常见错误（link 了但不生效）。

## 两种模式（关键区别）

| 模式 | 测试目标 | 机制 | 安装脚本 | 卸载脚本 |
|---|---|---|---|---|
| **pi 模式** | **原版 pi**（当前 pi CLI session、`pi` 命令直接跑） | `pi install/remove`（pi 原生，改 `~/.pi/agent/settings.json`） | `pi-link.sh` | `pi-unlink.sh` |
| **xyz-agent 模式** | **xyz-agent dev**（Electron app，runtime 注入给 pi 子进程） | `XYZ_EXTENSION_PATHS` 环境变量（`.env.dev-extensions`） | `link-local.sh` | `link-npm.sh` |

**一句话区分**：pi 模式让**你现在跑的这个 pi** 加载本地源码；xyz 模式只影响 **xyz-agent app 的 dev 模式**（它 spawn 的 pi 子进程），当前 pi session 不读这个 env。

## pi 模式（原版 pi）

```bash
bash .agents/skills/dev-link/pi-link.sh subagent-workflow      # symlink 本地到 ~/.pi/agent/extensions/
bash .agents/skills/dev-link/pi-unlink.sh subagent-workflow    # rm symlink
```

**机制**：symlink 本地源码 → `~/.pi/agent/extensions/pi-<short>`（globalExtDir，loader 第 2 步扫描，pi-statusline 同模式）。同时清 settings.json `packages` 里该 extension 的残留（`npm:` 源 + 旧 configuredPaths 本地路径），避免 globalExtDir + configuredPaths 两源冲突。

**生效**：新建 pi session（当前 session 已加载旧版，不重扫）。**注意 pi list 不显示** globalExtDir symlink——pi list 只列 `packages` 配置的，不列自动发现源，但 loader 会加载（正常现象）。

## xyz-agent 模式（Electron dev）

```bash
bash .agents/skills/dev-link/link-local.sh cw-tool             # 加到 XYZ_EXTENSION_PATHS
bash .agents/skills/dev-link/link-npm.sh cw-tool               # 移除
# 启动带 link 的 dev：
set -a && source .env.dev-extensions && set +a && pnpm dev
```

**机制**：`XYZ_EXTENSION_PATHS` 经 `ENV_WHITELIST_PREFIXES`（`XYZ_` 前缀）注入 xyz-agent runtime → pi 子进程。改源码后 xyz-agent 内新建 session 即生效（无需重启 app）。

**生效**：xyz-agent dev 模式 + 新建 session。**当前 pi CLI session 不受影响**（不读这个 env）。

## 何时用哪个

- 改了 extension 源码，想**在当前 pi 直接验证**（派 subagent、调工具、跑 `pi` 命令）→ **pi 模式**
- 改了 extension 源码，想**在 xyz-agent app 里端到端验证**（UI、Electron 流程）→ **xyz-agent 模式**
- 不确定 → **pi 模式**（更直接，当前环境就是 pi）

## 查看状态

```bash
bash .agents/skills/dev-link/link-list.sh
# 显示 pi 模式（pi list 本地源）+ xyz-agent 模式（.env.dev-extensions）两者的当前 link
```

## 包名格式

三种都支持：短名 `subagent-workflow` / pi-前缀 `pi-subagent-workflow` / npm 全名 `@zhushanwen/pi-subagent-workflow`。多包一次：`pi-link.sh goal todo ask-user`。

## 约束

- `.env.dev-extensions` 不进 git（xyz 模式，`.gitignore` 的 `.env.*` 覆盖）；pi 模式改 `~/.pi/agent/settings.json`（pi 自己管理）
- **两模式都需新建 session 生效**（运行中的 session 不重扫 extension 源）
- **pi 模式 `pi-unlink` 需联网**（`pi install npm:` 恢复要 npm install）；离线恢复会失败
- **merge/删 worktree 前清理**：两模式 link 都指向 worktree 的 `extensions/` 源码，worktree 删了 pi 加载报 ENOENT。pi 模式 `pi-unlink.sh <pkg>`、xyz 模式 `link-npm.sh <pkg>` 清理
- **quota-providers 是库包不是 extension**，脚本自动跳过
- 多 worktree：脚本用 `git rev-parse --show-toplevel` 定位 `extensions/`，worktree 切换后路径变，需在该 worktree 重新 link

## 常见错误

| 错误 | 原因 |
|------|------|
| pi 模式 link 后 pi 仍用旧版 | 当前 session 已加载旧版，**需新 session**；或没 remove npm（两源冲突，pi resolver 不知选谁）|
| xyz 模式 link 后 xyz-agent 看不到 extension | 没 `source .env.dev-extensions`；或没新建 session |
| pi 启动报 ENOENT extension path | worktree 删了但 link 未清理 → 对应模式 unlink |
| **link 了但不生效（最常见）** | **模式选错**：想测当前 pi 却用 xyz 模式（`XYZ_EXTENSION_PATHS` 当前 pi 不读）；想测 xyz-agent 却用 pi 模式。按"何时用哪个"选 |
| source 报 command not found | 路径含空格未加引号；或 `.env.dev-extensions` 格式错 |
