---
name: merge
description: >-
  合并分支并发布。触发词："合并"、"merge"、"发布"、"release"、
  "上线"。仅用于 xyz-agent 项目。
---

# merge

执行 8 阶段合并发布流程，最终通过 GitHub Release 交付
Electron 产物（DMG/EXE/AppImage）。

## 前置条件

- 当前在 worktree 分支上
- worktree 干净（无未提交改动）
- GitHub CLI 已认证

## 8 阶段流程

### 阶段 0: 初始化

```bash
cd /Users/zhushanwen/Code/xyz-agent-workspace/main
git status
git log --oneline -5
```

确认当前分支和最近提交。

### 阶段 1-3: 标准验证

```bash
# 阶段 1: 本地验证
bash ~/.agents/skills/merge-worktree/stages/1-local-check.sh

# 阶段 2: PR CI + 合并
bash ~/.agents/skills/merge-worktree/stages/2-pr-merge.sh

# 阶段 3: Post-merge CI
bash ~/.agents/skills/merge-worktree/stages/3-post-merge-ci.sh
```

### [MANDATORY] 阶段 4: Electron Builder 构建

```bash
cd /Users/zhushanwen/Code/xyz-agent-workspace/main

# 综合预检
bash scripts/preflight-check.sh

# Electron 全量构建
cd src-electron && npm run build
```

**关键点**：构建产物在 CI 也会生成，但本地构建验证能提前发现
打包问题。

### 阶段 5: 合并到 main 并发布

```bash
# 切换到 main 并合并
git checkout main
git merge --no-ff <feature-branch>

# 推送
git push origin main

# 创建 release tag
VERSION=$(node -p "require('./package.json').version")
git tag "v$VERSION"
git push origin "v$VERSION"
```

GitHub Actions 由 tag 推送触发，自动构建并创建 Release。

### 阶段 6: 交付物验证

```bash
cd /Users/zhushanwen/Code/xyz-agent-workspace/main

# 获取版本号
TAG="v$(node -p "require('./package.json').version")"

# 查看 Release
gh release view "$TAG" --json tagName,url,assets

# 验证 macOS DMG 存在
ASSETS=$(gh release view "$TAG" --json assets --jq '.assets[].name')
echo "$ASSETS" | grep -q "\.dmg$" && echo "macOS .dmg OK" || echo "MISSING .dmg"

# 验证 Windows EXE 存在
echo "$ASSETS" | grep -q "\.exe$" && echo "Windows .exe OK" || echo "MISSING .exe"

# 验证 Linux AppImage 存在
echo "$ASSETS" | grep -q "AppImage" && echo "Linux AppImage OK" || echo "MISSING AppImage"
```

本技能目录包含验证脚本：

```bash
# 构建后验证（基于 merge skill 本地目录）
bash ~/.agents/skills/merge/scripts/postbuild-validate.sh

# 运行时 bundle 验证
bash ~/.agents/skills/merge/scripts/validate-runtime-bundle.sh
```

### 阶段 7: 清理

```bash
# 删除已合并的本地分支
git checkout main
git branch -d <feature-branch>

# 如有远端分支也删除
git push origin --delete <feature-branch>
```

## 注意事项

- 版本号取自 `package.json` 的 `version` 字段（当前 `0.3.14`）
- DMG/EXE/AppImage 由 GitHub Actions 在 CI 生成
- 本地构建验证是预防措施，不产生最终交付物
- 如 GitHub Actions 失败，检查 Actions 日志后重新触发

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
