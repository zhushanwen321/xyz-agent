---
name: prerelease
description: >-
  发布预发布版本用于测试。支持两种 target：
  Electron 产物（DMG/EXE/AppImage，触发词："发测试版"、"构建测试 DMG"、
  "生成测试包"、"pre-release test"、"beta release"、"draft release"、"测版"）
  和 npm 包（触发词："npm 预发布"、"发 npm beta"、"npm prerelease"）。
  不用于 正式发布——用 merge skill。
---

# prerelease

预发布测试统一入口。创建临时预发布版本，触发 CI 构建，验证产物，测试通过后还原代码。

## Target 路由

| Target | 触发词 | 脚本 | CI Workflow | 版本号 | 验证方式 |
|--------|--------|------|-------------|--------|---------|
| **electron**（默认） | "发测试版"、"beta release"、"测版"、"构建测试 DMG" | `scripts/prerelease-test.sh` | release.yml（push v*-beta tag） | 手动 beta（0.7.1-beta） | dmg/exe/AppImage 产物存在 |
| **npm** | "npm 预发布"、"发 npm beta"、"npm prerelease" | `scripts/npm-prerelease.sh` | release-npm-dev.yml（push dev-npm-* 分支） | changeset prerelease（0.1.1-dev.0） | npm view 确认版本可见 |

npm target 支持两类包：`@xyz-agent/*`（位于 `packages/`）和 `@zhushanwen/pi-*`（位于 `extensions/`），脚本按包名自动定位 workspace 目录。

AI 根据触发词自动判断 target。不确定时问用户。

## 核心流程（两 target 共用）

1. 确认工作区干净
2. 临时 bump 版本号 + commit + tag/push → 触发 CI
3. 轮询 CI 直到完成
4. 验证产物完整性
5. **用户确认测试通过后**，还原代码版本

## AI 操作步骤

### [MANDATORY] 1. 执行预发布脚本

```bash
# <workspace-root> = bare-repo workspace 根目录
cd <workspace-root>/main

# Electron target（默认）
bash scripts/prerelease-test.sh

# npm target
bash scripts/npm-prerelease.sh                          # 默认 @xyz-agent/extension-protocol
bash scripts/npm-prerelease.sh @zhushanwen/pi-goal      # 指定包名
```

脚本自动执行所有阶段。AI 只需执行这一步，等待脚本完成。

**脚本 exit 0 前不得宣布"已完成"。** 脚本内部已包含 CI 轮询和产物验证。

### [MANDATORY] 2. 产物通知

**Electron target**：脚本阶段 5 完成后输出产物链接。
- macOS: 下载 `.dmg`，拖入 Applications 安装测试
- Windows: 下载 `.exe` 安装测试
- Linux: 下载 `.AppImage` 运行测试

**npm target**：脚本完成后输出安装命令：
```bash
npm install <pkg>@dev
```

### [MANDATORY] 3. 确认还原

脚本最后会询问"测试通过？输入 yes 还原版本"。
AI 必须等待用户明确确认后再输入 `yes`。

### [OPTIONAL] 4. CI 失败时的处理

如果 CI 失败，脚本会自动还原版本。AI 应：
1. 打开 CI 链接查看失败日志
2. 修复问题后重新运行脚本

## npm target 前置条件

| 条件 | 检查方式 |
|------|---------|
| npm scope 已创建 | `npm view <pkg>` 不报 404 |
| GitHub repo 有 `NPM_TOKEN` secret | `gh secret list --repo zhushanwen321/xyz-agent` |
| changeset 已初始化 | `.changeset/config.json` 存在 |

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 手动 `npm version` + `git tag` + `git push` | 运行对应脚本，等它自己完成 |
| 脚本还在跑 CI 轮询就说"已完成" | 必须等脚本 exit 0 |
| 跳过产物验证 | 脚本会自动验证，等它输出结果 |

## 版本命名（Electron target）

| 操作 | 版本号 | 说明 |
|------|--------|------|
| 初始状态 | 代码 `0.4.6`，release `v0.4.6` | 最新正式版 |
| Bump 后 | 代码 `0.4.7-beta`，tag `v0.4.7-beta` | 测试版 |
| 还原后 | 代码 `0.4.6`，tag 已删除 | 回到初始状态 |
| 正式发布 | `v0.4.7` | 不受测试版影响 |

## 故障恢复（npm target）

```bash
# 查看 CI 日志
gh run list --workflow=release-npm-dev.yml --repo zhushanwen321/xyz-agent --limit 3

# 手动验证 npm 版本
npm view <pkg>@dev version

# 手动还原
git checkout main && git branch -D dev-npm-* && git push github --delete dev-npm-* 2>/dev/null || true
```

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤 | 可根据实际情况决定 |
