---
name: npm-prerelease
description: >-
  发布 npm 预发布版本（dev dist-tag）用于测试。创建 dev-npm-* 分支，
  changeset 生成 prerelease 版本号，push 触发 CI 发布到 npm @dev tag，
  轮询验证后还原代码。触发词："npm 预发布"、"发 npm beta"、"npm prerelease"。
  仅用于 xyz-agent 项目的 npm 包发布（@xyz-agent/extension-protocol 等）。
  不用于 Electron 打包预发布——那个用 prerelease-test skill。
---

# npm-prerelease

## 概述

发布 npm 包的预发布版本（`-dev.*` 后缀），发布到 npm `dev` dist-tag。
消费者通过 `npm install @xyz-agent/extension-protocol@dev` 安装测试版本。
测试通过后自动还原代码版本，不占用正式版本号。

**与 prerelease-test skill 的区别**：

| 维度 | npm-prerelease（本 skill） | prerelease-test |
|------|---------------------------|-----------------|
| 发布目标 | npm 包（@xyz-agent/extension-protocol） | Electron 产物（DMG/EXE/AppImage） |
| 触发 CI | release-npm-dev.yml（push dev-npm-* 分支） | release.yml（push v*-beta tag） |
| 版本号 | changeset prerelease（0.1.1-dev.0） | 手动 beta（0.7.1-beta） |
| 验证 | npm view 确认版本可见 | dmg/AppImage 产物存在 |

## 核心流程

1. 确认工作区干净
2. 创建 `dev-npm-*` 分支
3. changeset 生成 prerelease changeset → `changeset version` 产出 `-dev.*` 版本号
4. commit + push → 触发 `release-npm-dev.yml` CI
5. 轮询 CI 直到 npm 版本可见
6. 验证：`npm view @xyz-agent/extension-protocol@dev` 版本号更新
7. 用户确认测试通过后，还原代码（切回原分支，删 dev-npm-* 分支）

## AI 操作步骤

### [MANDATORY] 1. 执行预发布脚本

```bash
cd /Users/zhushanwen/Code/xyz-agent-workspace/main
bash scripts/npm-prerelease.sh
```

脚本自动执行所有阶段。AI 只需执行这一步，等待脚本完成。

**脚本 exit 0 前不得宣布"已完成"。** 脚本内部已包含 CI 轮询和 npm 版本验证。

### [MANDATORY] 2. 通知测试安装方式

脚本完成后输出安装命令：

```bash
# 消费者安装 beta 版
npm install @xyz-agent/extension-protocol@dev
# 或
pnpm add @xyz-agent/extension-protocol@dev
```

### [MANDATORY] 3. 确认还原

脚本最后会询问"测试通过？输入 yes 还原版本"。
AI 必须等待用户明确确认后再输入 `yes`。

## 前置条件

| 条件 | 检查方式 |
|------|---------|
| npm 已创建 `@xyz-agent` scope | `npm view @xyz-agent/extension-protocol` 不报 404（首次发布前需手动创建 scope） |
| GitHub repo 有 `NPM_TOKEN` secret | `gh secret list --repo zhushanwen321/xyz-agent` 含 NPM_TOKEN |
| changeset 已初始化 | `.changeset/config.json` 存在 |

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 手动 `npm version` + `npm publish` | 运行 `bash scripts/npm-prerelease.sh`，走 changeset 流程 |
| 脚本还在跑 CI 轮询就说"已完成" | 必须等脚本 exit 0 |
| 跳过 npm 版本验证直接说"应该发布了" | 脚本自动 `npm view` 验证，等它输出结果 |
| 在 feature 分支运行而非创建 dev-npm-* 分支 | 脚本自动从 main 创建 dev-npm-* 分支 |

## 故障恢复

脚本失败后，检查 dev-npm-* 分支状态：

```bash
# 查看 CI 日志
gh run list --workflow=release-npm-dev.yml --repo zhushanwen321/xyz-agent --limit 3

# 手动验证 npm 版本
npm view @xyz-agent/extension-protocol@dev version

# 手动还原（如果脚本中途失败）
git checkout main
git branch -D dev-npm-*
git push github --delete dev-npm-* 2>/dev/null || true
```
