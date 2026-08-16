---
name: pre-push-checks
description: >-
  Use when push 前需要跑最小验证。触发词："push 前检查"、"pre-push"、
  "提交前验证"、"要 push 了"、"检查再推"。
  不用于 push 失败排查/CI 故障诊断、或开 PR 的完整门禁（用 pull-request）。
---

# pre-push-checks

push 前把覆盖 outgoing diff 的最小相关证据跑一遍：按 `git diff` 定位改动
包，只跑该包的 lint/vitest/build；改动 docs 只跑文档检查。拒绝反射性跑
全量套件。CI 拥有穷尽覆盖与平台矩阵；本地验证是「我的改动是否把对应包弄
挂了」的最小证据，不是 CI 的替代。push 前相关检查失败就停下修复或说明，
不要 push 后指望 CI 兜底。

项目没有 pre-push hook（bare repo + worktree 模式下 hook 装在
`.bare/hooks/`，全 worktree 共享，目前只有 pre-commit）。pre-commit 覆盖
staged 改动的 eslint 与项目特定检查器（CSS token、路径白名单、服务循环、
工具 schema 等）；push 前的证据完全靠本 skill 的流程。

## 与 pull-request skill 的分工

- **pull-request** = 开 PR 前的完整门禁：lint + 各 workspace vitest +
  build + changeset 检查 + PR 创建/更新。提交 PR 时按它走。
- **本 skill** = 日常每次 push 前的最小检查：按改动面选包、只跑相关证据。
- push 到已存在的 PR 分支：用本 skill 选最小范围即可，完整套件由 CI 在
  PR 上跑（`gh pr checks` 查看）；不要为了 push 反射性重复 pull-request
  的全量验证。

## 检查 outgoing diff

1. 确认 checkout 与分支：

```sh
git status --short --branch
git rev-parse --show-toplevel
```

2. 确定 base 并核对范围。默认 base 是 `main`（worktree 开发模式）；
   stacked 分支用其 PR 的 base。fetch 后看完整范围：

```sh
git fetch github
git diff main...HEAD --stat
git diff main...HEAD --name-only
```

（bare repo workspace 注意：`origin` 指向本地 bare repo，GitHub 的 remote
是 `github`。多 worktree 时确认 `git status --short --branch` 显示的是当前
worktree 的分支。）

## 按包路径选择测试范围

`git diff --name-only <base>...HEAD` 的路径决定跑什么，按以下规则归类，
同类里能聚焦就聚焦：

- **packages/<pkg>/** → 进该 workspace 跑 vitest（可加 `-t <name>` 聚焦
  单个测试）与针对改动文件的 eslint：
  ```sh
  cd packages/runtime && npx vitest run            # 或 npx vitest run -t <name>
  npx eslint <改动的文件>
  ```
- **extensions/*/** → 跑 extensions 的三个脚本（覆盖全部扩展包）：
  ```sh
  pnpm run extensions:typecheck
  pnpm run extensions:lint
  pnpm run extensions:test
  ```
- **apps/electron/** → `pnpm run build`（构建验证）+ 针对改动文件的 eslint。
- **docs/、.agents/、*.md** → 文档检查：`git diff --check`、通读改动、
  核对文档与实现的 SSOT 一致性（如 design-tokens）。xyz 没有独立文档
  gate，文档改动至少过 review，不静默合并。
- **共享包（packages/shared、packages/extension-protocol、
  packages/plugin-sdk）** → 跑该包测试 + 依赖它的包（runtime/renderer/
  extensions）测试；共享契约改动才加相邻包，不跑全仓。
- **跨包/横跨全仓** → 这是全量本地预演的正当理由，见下节。

只跑改动面够得着的证据。共享契约没改就不加相邻包；同一 diff 刚跑过的检查
不要手动重复一次。

## 全量本地预演

仅当用户明确要求、诊断 CI 失败、或改动横跨全仓到没有更小的可信子集时，
才跑完整本地近似。用现有脚本当清单：`pnpm run lint`、各 workspace
`npx vitest run`（packages/runtime、packages/renderer、packages/shared、
packages/extension-protocol）、`pnpm run extensions:test`、`pnpm run build`。

## 保护历史重写 push

rebase 允许（worktree 分支）。重写前 fetch 远端分支并记录确切 OID，发布用
`--force-with-lease`，远端被并发更新时 push 会中止。裸 `--force` 禁止。

```sh
git fetch github
git push github HEAD --force-with-lease
```

重写后重新 fetch 远端 heads，重审未解决的 review 线程、approval 与合并性。
重写前的 commit hash 与行内评论锚点不是当前证据。

## 失败处理

push 前相关检查失败：停下，修复或说明阻塞原因。不要 push 后指望 CI 不同。

环境特异性失败要证明：

- 记录确切命令、失败内容、平台差异。
- 确认非平台相关证据。
- 必要检查优先修跨平台不确定性。
- 仅当用户明确要求/同意才绕过本地 hook，并报告确切失败与 CI 预期差异。

## push 流程

1. 跑选中检查一次（上面按路径选的证据）。
2. 正常 commit（pre-commit hook 跑 staged 检查；commit 后查看 hook 改动
   的文件再继续）。
3. push 或按授权用 `--force-with-lease`：
   ```sh
   git push github HEAD
   ```
4. 验证远端 ref 等于本地 HEAD：
   ```sh
   git rev-parse HEAD github/$(git branch --show-current)
   ```
5. 查远端 CI（已有 PR 时）：
   ```sh
   gh pr checks
   ```
   pending 报 pending；失败先查归属再归因分支或环境。push 了发布 tag
   （`v*`/`npm-*`）时，必须等 CI 构建完成并验证产物存在，不能 push 后
   直接宣布完成（见根 AGENTS.md「发布与 CI 验证」）。

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[HISTORICAL]` | 历史经验总结的规则。来自实际事故和教训 | **不允许删除或削弱**，只能在原有基础上补充 |
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
