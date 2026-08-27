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

**调用约束**：cwd 必须在待合并 feat worktree 根目录（脚本靠 `git rev-parse --show-toplevel` 定位源 worktree）。旧 base 的 feat worktree 分支历史可能不含本 skill 文件（相对路径调用会 No such file or directory），脚本调用一律用本文写死的绝对路径，禁止 `.agents/skills/...` 相对路径写法。

### 第 1 步：处理未提交改动（AI 决策，脚本不代劳）

脚本预检发现未提交的 **tracked** 改动会以 exit 1 停下（untracked 不触发预检，cleanup 阶段由 git 拒删 worktree 兜底）。此时**不要**用 `git add -A && git commit` 盲提交：

- 本次会话产生的改动 → 按全局提交策略正常 commit（完成即提交）
- 非本次会话产生的认知外改动 → **不提交、不修改、不丢弃**，先询问用户

处理完再进第 2 步。

### 第 2 步：合并

```bash
bash /Users/zhushanwen/Code/xyz-agent-workspace/dev-0.9.10/.agents/skills/dev-merge/dev-merge.sh merge <dev-branch>
```

脚本自动完成：两侧干净预检 → 已合并短路 → `git merge --no-ff`（保留 feature 分支历史，与项目 PR 合并策略一致）。

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
bash /Users/zhushanwen/Code/xyz-agent-workspace/dev-0.9.10/.agents/skills/dev-merge/dev-merge.sh cleanup <dev-branch>
```

脚本内置安全闸：分支未合并进 dev 拒绝清理（`is_merged` 闸门通过后脚本直接 `git branch -D`，不依赖 `git branch -d`——feat 分支 upstream 是 origin/main，`-d` 校验的是 upstream 包含性，即便已合入 dev 也必拦）；worktree 有未跟踪且未 ignore 的文件时 git 拒绝删除——**不要擅自 `--force`**，先看那些文件是什么（认知外的问用户），确认后由用户/显式决策强删。

**`OK:` 输出 = 全部完成的权威证明**（worktree 与分支都已删）。此后不要再调用任何 bash——包括 `git worktree list` / `git log` 复核确认。直接输出合并总结收尾。

**[MANDATORY] bash 会话报废信号解码**：cleanup 之后（无论脚本输出 `OK:` 还是 `ERROR:`），若 bash 调用返回以下**工具层错误**（没有任何命令输出）：

```
Working directory does not exist: <feat-worktree 路径>
Cannot execute bash commands.
```

1. **命令没有被执行**——工具在 spawn shell 前就因 cwd 目录不存在而拒绝，`cd <别处> &&` 前缀救不了（拒绝发生在命令文本被解释之前）。重试无意义，立即停止一切 bash 调用
2. 它同时是 **worktree 删除已成功的证明**（目录已从磁盘消失），不是失败信号
3. 这是**会话级永久状态**：本会话后续所有 bash 调用都会得到同样错误。收尾判断——脚本输出过 `OK:` → 全部完成，正常输出总结；脚本在删 worktree 之后输出过 `ERROR: 分支 ... 删除失败` → 分支是唯一残留，在总结里写明一条待执行命令 `git -C /Users/zhushanwen/Code/xyz-agent-workspace/<dev-branch> branch -D <feat-branch>` 交给用户/下次会话

同类陷阱与反模式的完整记录见 merge skill 阶段 7。

例外：如果脚本在删 worktree **之前** exit 非 0（预检失败 / 分支未合并 / 脏 worktree），目录仍在、bash 正常，按脚本输出排查。
