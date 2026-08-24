---
name: dev-merge
description: >-
  Use when 将当前 feature worktree 的分支合并到兄弟 dev-x.x.x 集成 worktree 并清理源
  worktree。触发词："dev-merge"、"/dev-merge"、"合并到 dev"、"合并 worktree"。
  不用于 合并到 main 并发布（用 merge skill）、创建/管理 worktree（用 worktree-manipulate）。
---

# dev-merge

把**当前 feat worktree** 的分支合并到 `../dev-x.x.x` 集成 worktree（bare repo + 兄弟 worktree 布局），合并完成后清理源 worktree 与分支。

**输入**：一个参数 = 目标 dev 分支名（同时是 worktree 目录名），如 `dev-0.9.6`。无参数时列出 `../dev-*` 让用户选择，不要猜。

**边界**：
- 只做本地集成合并，**不 push**（push 必须用户明确授权）
- 合并到 main 并走发布流程 → `merge` skill
- worktree 的创建/其他管理 → `worktree-manipulate` skill

## 流程

### 第 1 步：处理未提交改动（AI 决策，脚本不代劳）

脚本预检发现未提交改动会以 exit 1 停下。此时**不要**用 `git add -A && git commit` 盲提交：

- 本次会话产生的改动 → 按全局提交策略正常 commit（完成即提交）
- 非本次会话产生的认知外改动 → **不提交、不修改、不丢弃**，先询问用户

处理完再进第 2 步。

### 第 2 步：合并

```bash
bash .agents/skills/dev-merge/dev-merge.sh merge <dev-branch>
```

cwd 必须在待合并的 feat worktree 内（脚本用 `git rev-parse --show-toplevel` 定位当前）。脚本自动完成：两侧干净预检 → 已合并短路 → `git merge --no-ff`（保留 feature 分支历史，与项目 PR 合并策略一致）。

三种结果：

| 输出 | 含义 | 下一步 |
|---|---|---|
| `OK:` | 合并成功 | 直接进第 4 步 cleanup（默认自动清理） |
| `SKIP:` | 已是祖先，无需重复合并 | 直接进第 4 步 |
| exit 2 + `CONFLICT:` | 冲突，dev worktree 停在 merge 中间态 | 进第 3 步 |

### 第 3 步：解决冲突（exit 2 后）

冲突清单已在脚本输出中。在 **dev worktree**（`../<dev-branch>`）内处理，每条命令自包含 cd（bash cwd 不跨调用持久）：

```bash
cd /Users/zhushanwen/Code/xyz-agent-workspace/<dev-branch> && git status --short   # 全量冲突态
# 逐个解决冲突文件后：
cd /Users/zhushanwen/Code/xyz-agent-workspace/<dev-branch> && git add <files> && git commit
```

解决原则：按改动意图合并而非机械取一侧；冲突两侧都看不懂时**停下来问用户**，不要猜。merge commit 会走 dev worktree 的 pre-commit hooks，检出的问题按全局规则全部正面修复。

### 第 4 步：清理源 worktree（默认自动清理）

合并成功后**自动执行清理**（删除 worktree + 分支）。用户不特别说明时默认清理，无需逐次确认。仅当用户明确说「不清理」时才跳过。

```bash
bash .agents/skills/dev-merge/dev-merge.sh cleanup <dev-branch>
```

脚本内置安全闸：分支未合并进 dev 拒绝清理；worktree 有未跟踪且未 ignore 的文件时 git 拒绝删除——**不要擅自 `--force`**，先看那些文件是什么（认知外的问用户），确认后由用户/显式决策强删。

**[关键] cleanup 成功后**：原 worktree 目录已不存在，而 bash 调用的默认 cwd 可能仍指向它（目录悬空）。后续所有 bash 命令会报 ENOENT / cwd 错误——**这是清理已成功的正常信号，不是错误**。与 merge skill 阶段 7 一致：脚本删掉该目录后，后续 bash 调用的 cwd 指向已删除目录 → ENOENT。此时立即输出合并总结收尾，不要再尝试调 bash 做确认。

例外：如果脚本本身因业务原因（如分支未合并、worktree 被占用）**明确 exit 非 0**，那是另一回事，需按脚本输出排查。
