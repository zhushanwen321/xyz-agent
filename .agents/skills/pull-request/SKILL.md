---
name: pull-request
description: >-
  提交 Pull Request。触发词："提交 PR"、"创建 PR"、"push"、
  "提交代码"、"pr-worktree"。仅用于 xyz-agent 项目。
---

# pull-request

提交代码并创建 Pull Request 的完整流程。

## 前置条件

- 当前在 worktree 分支上(不在 main/master)
- 所有改动已 stage(`git add`)
- 有 GitHub CLI(`gh`)认证

## 流程

### [MANDATORY] 1. Pre-merge 验证

```bash
cd /Users/zhushanwen/Code/xyz-agent-workspace/main

# Lint 检查
npm run lint

# 单元测试
npm test

# 构建验证(确认 build 不报错)
npm run build
```

**Electron 特化说明**:
- 构建产物在 CI 产生,本地只需确认 `npm run build` 不报错
- 本技能目录包含 `scripts/preflight-check.sh`,可用作更全面的预检

```bash
# 可选:使用 preflight-check.sh 做全面预检
bash scripts/preflight-check.sh
```

### 2. 提交改动

```bash
# 查看当前改动
git status
git diff --stat

# 提交(确保 message 清晰描述改动内容)
git commit -m "<描述性 commit message>"
```

### 3. Push 并创建 PR

```bash
# Push 到远程分支
git push origin HEAD

# 创建 PR(使用 gh CLI)
gh pr create \
  --title "<PR 标题>" \
  --body "<PR 描述,包含改动摘要和测试说明>"
```

## 项目特化约束

- **Electron 打包验证**:本地 build 通过即可,全量 DMG/EXE 产物由 CI 生成
- **构建产物路径**:`src-electron/dist/`,`.agents/skills/` 不参与构建
- **预发布检查脚本**:
  - `scripts/preflight-check.sh` - 综合预检
  - `scripts/postbuild-validate.sh` - 构建后验证
  - `scripts/validate-runtime-bundle.sh` - 运行时 bundle 验证

## 注意事项

- PR 描述中应列出改动文件和改动原因
- 如有 breaking changes 必须在描述中标明
- 确保 `.agents/skills/` 目录的改动也纳入提交

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
