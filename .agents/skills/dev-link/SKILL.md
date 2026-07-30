---
name: dev-link
description: >-
  Manage XYZ_EXTENSION_PATHS for local pi extension development in xyz-agent.
  Switch between local source (live edit) and npm-published versions of
  @zhushanwen/pi-* extensions. Triggers: "link local", "dev link", "switch to
  local", "symlink extension", "unlink extension", "restore npm", "extension
  link". Not for installing new packages or managing non-pi extensions.
---

# Dev Link

管理 `XYZ_EXTENSION_PATHS` 环境变量，在本地源码（live edit）和 npm 已发布版本之间切换 `@zhushanwen/pi-*` extension。

> **与源仓 dev-link 的区别**：源仓（xyz-pi-extensions）的 dev-link 操作 pi CLI 的 `~/.pi/agent/extensions/` symlink + `pi install`。xyz-agent 是 Electron 应用，extension 加载机制不同——通过 `XYZ_EXTENSION_PATHS` 环境变量指向源码目录（live link，改源码→新建 session 即生效），不经 `~/.pi/agent/`。本 skill 基于此机制重新设计。

## When to Use

- 开发 `extensions/` 目录下的 `@zhushanwen/pi-*` 包，想在运行的 xyz-agent 中即时测试源码改动
- 用户说"link 到本地"、"切换到本地开发"、"用本地版本"
- 用户说"恢复 npm"、"用 npm 版本"、"unlink extension"
- 开发结束，清理 link 状态

## 机制

xyz-agent 通过 `ExtensionResolver` 的 **user 源**（优先级仅次于 npm）扫描 `XYZ_EXTENSION_PATHS` 环境变量指向的 extension 源码目录。设了环境变量后，改源码 → **新建 session** 即加载最新代码（不需要重启 xyz-agent）。

```
XYZ_EXTENSION_PATHS=~/Code/.../extensions/goal pnpm dev
         ↓
ExtensionResolver user 源扫描 → isValidPiExtension 校验 → --extension <path> 注入 pi
         ↓
新建 session → pi jiti loader 加载最新 .ts 源码（live link）
```

环境变量经 `ENV_WHITELIST_PREFIXES`（`XYZ_` 前缀）自动通过 main → runtime → pi 白名单，无需额外配置。

## 两个脚本

```bash
# 脚本位置（resolve against skill 目录）
./link-local.sh <package> [package2 ...]  # 添加到 XYZ_EXTENSION_PATHS（本地源码，live edit）
./link-npm.sh <package> [package2 ...]     # 从 XYZ_EXTENSION_PATHS 移除（恢复走 npm 或不加载）
./link-list.sh                              # 查看当前 link 状态
```

`<package>` 支持三种格式：
- 短名：`model-switch`
- pi-前缀：`pi-model-switch`
- npm 全名：`@zhushanwen/pi-model-switch`

支持多包一次操作：`./link-local.sh goal todo ask-user`

### link-local.sh — 切换到本地开发

1. 读取 `.env.dev-extensions`（如不存在则创建）
2. 验证每个包在 `extensions/` 目录下存在且有 `package.json`
3. 把包的源码绝对路径追加到 `XYZ_EXTENSION_PATHS`（用 `:` 分隔，幂等：已存在则跳过）
4. 输出启动命令提示

### link-npm.sh — 移除本地 link

1. 读取 `.env.dev-extensions`
2. 移除指定包的路径（支持 glob 前缀匹配，如 `pi-goal` 匹配含 `/extensions/goal` 的条目）
3. 如果移除后 `XYZ_EXTENSION_PATHS` 为空，删除整行（避免空值覆盖）
4. 输出结果

### link-list.sh — 查看当前状态

显示 `.env.dev-extensions` 中已 link 的包列表 + 对应源码路径，以及每个包是否已被改动（`git status` 检测）。

## 用法示例

```bash
# 1. link 一个 extension 到本地源码
bash .agents/skills/dev-link/link-local.sh goal

# 2. 启动带 link 的 dev（source .env.dev-extensions 注入环境变量）
set -a && source .env.dev-extensions && set +a && pnpm dev

# 3. 改 extensions/goal/src/index.ts 源码

# 4. 在 xyz-agent 中新建 session → 即时生效（无需重启）

# 5. 开发完，移除 link
bash .agents/skills/dev-link/link-npm.sh goal
```

## 关键约束

- **`.env.dev-extensions` 不进 git**（已覆盖在 `.gitignore` 的 `.env.*` 规则下）
- **link 后必须新建 session 才生效**（运行中的 session 不重扫 extension 路径）
- **多 worktree 注意**：脚本用 `$(git rev-parse --show-toplevel)` 定位 extensions/ 目录，确保在正确 worktree 根目录执行。worktree 切换后路径会变，需重新 link
- **dev vs prod 数据目录**：`pnpm dev` 自动用 `~/.xyz-agent-dev/`，与生产的 `~/.xyz-agent/` 隔离。link 操作只影响 dev 模式
- **与 merge skill 的关系**：merge 阶段 7 删除 worktree 前，如果有 active link 指向该 worktree 的 extensions/，需先 `link-npm.sh` 清理（否则 link 指向已删除目录，pi 加载报 ENOENT）

## 常见错误

| 错误 | 原因 |
|------|------|
| link 后 xyz-agent 看不到 extension | 没新建 session；或 `.env.dev-extensions` 没 source 进环境 |
| source 报 `command not found` | 路径含空格未加引号；或 `.env.dev-extensions` 格式错误 |
| pi 启动报 ENOENT extension path | worktree 已删除但 link 未清理；跑 `link-npm.sh <pkg>` 或 `link-npm.sh --all` 清理 |
| quota-providers 不应 link | 它是库包（shared lib），不是 pi extension，不进 `XYZ_EXTENSION_PATHS`。脚本会自动跳过 |
