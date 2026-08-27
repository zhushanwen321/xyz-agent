---
name: merge
description: >-
  Use when 合并分支并发布（GitHub Release 交付 Electron 产物 + 可选 npm 发布）。
  触发词："合并"、"merge"、"发布"、"release"、"上线"。
  不用于 纯分支合并（不发布）、日常编码中的合并操作（合并数组/对象等）、
  或 npm 预发布 / 测试版发布（用 prerelease skill，仓库脚本 scripts/npm-prerelease.sh / prerelease-test.sh）。
---

# merge

执行 9 阶段合并发布流程，最终通过 GitHub Release 交付 Electron 产物（DMG/EXE/AppImage）。

> **双发布线**：本项目同时维护两条独立的发布线：
> - **Electron 发布线**（`v*` tag → `release.yml` → DMG/EXE/AppImage）—— 阶段 4
> - **npm 发布线**（`npm-*` tag → `release-npm.yml` → @xyz-agent/* + @zhushanwen/pi-* npm 包）—— 阶段 4N（可选）
>
> 两套 tag 前缀（`v*` vs `npm-*`）互不干扰，CI concurrency group 隔离。阶段 4N 仅在本次 PR 含 `extensions/` 改动时执行（人工版本判定机制，详见阶段 4N）。

## 前置条件

- **`WS_ROOT` 变量约定**：`WS_ROOT` = workspace root（bare repo 模式，含 `.bare/`，所有 worktree 均为其直接子目录），本项目为 `/Users/zhushanwen/Code/xyz-agent-workspace`。`.agents` 只存在于各 worktree 内、**`$WS_ROOT` 本身没有 `.agents`**——skill 脚本一律经 `cd $WS_ROOT/main && bash .agents/skills/merge/scripts/<脚本>` 调用（main worktree 恒存在不可删），禁止 `cd $WS_ROOT` 后直接相对调用
- feature 分支有已创建的 PR
- GitHub CLI 已认证

## 9 阶段流程

### 阶段 0: 初始化

⚠️ **关键**：第一个参数是 **feature worktree 目录名**（如 `feat-new-feature`），不是 `main`。脚本会自动检测 `$WS_ROOT/main` 用于 bump/tag/push。传 `main` 会导致阶段 7 删除 main worktree。

⚠️ **cwd 隔离 [MANDATORY]**：bash 工具每次调用都是独立 shell，cwd **不跨调用持久**——每次 reset 到 session 启动目录（通常是 feature worktree，即被合并的分支目录），前序 bash 调用或脚本内部的 `cd` 对后续调用**无效**（与 AGENTS.md §8 一致）。

**强制规则**：所有操作 main worktree 的 bash 调用，必须在**当条命令开头**自包含 `cd $WS_ROOT/main && <cmd>`，不能依赖代码块里前一行的 `cd`，更不能假设"上一步 cd 过了"。操作 workspace root 同理自包含 `cd $WS_ROOT && <cmd>`。受影响阶段：3 / 3.5 / 4 / 4N / 5 / 6（都在 main worktree 操作）。

**为什么不能在 feature worktree 操作**：阶段 2 起 feature 分支已合并，阶段 7 会删除 feature worktree；version bump / commit / tag / push 等写操作落在 feature worktree 会污染已合并分支、导致 main 实际未变更。详见阶段 7 的 [HISTORICAL] 说明。

**事故背景**：阶段 4 `pnpm version patch` 因 bash 调用未自包含 `cd $WS_ROOT/main`，cwd reset 到 feature worktree，把 version bump 写进了 feature worktree 的 package.json（main worktree 未动），直到 `git branch --show-current` 检查才暴露。根因是旧版本文档误称"cwd 按调用持久"，AI 据此以为阶段 3 的 `cd main` 对后续调用仍有效。

```bash
cd $WS_ROOT/main && bash .agents/skills/merge/scripts/init.sh <worktree-dir>
```

参数说明：
- `<worktree-dir>` — feature worktree 目录名（basename），如 `feat-extensions-widget`

脚本输出 `WS_ROOT`、`BRANCH_NAME`、`PR_NUMBER`，后续阶段需要这些值。

### 阶段 1: 本地验证

```bash
cd $WS_ROOT/main && bash .agents/skills/merge/scripts/pre-merge-check.sh "$WS_ROOT/<worktree-dir>"
```

阶段 1 调用项目内 pre-merge-check.sh（依赖安装、类型检查、lint、测试、构建，以及第 5 步 Git 状态检查——有未提交变更或未推送 commits 会 FAIL 阻塞合并）。脚本自包含在项目 skill 目录内，不依赖全局脚本。

ℹ️ **pnpm workspace 单步安装**：项目使用 pnpm workspace（`packages/* + apps/*`），`pnpm install` 一次装完所有依赖，无需手动 cd 子目录。如果 pre-merge-check.sh 未自动处理依赖安装，需手动执行：

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install
```

### 阶段 1.5: Dev-Link 清理

> **无条件执行**。跨 worktree 扫描所有 `.env.dev-extensions`，移除 `XYZ_EXTENSION_PATHS` 中指向即将删除的 feature worktree 的路径条目（dev-link 写入的是环境变量路径，不是 symlink）。

```bash
cd $WS_ROOT/main && bash .agents/skills/merge/scripts/prune-dev-link.sh "$WS_ROOT/<worktree-dir>"
```

`<worktree-dir>` 是阶段 0 传给 init.sh 的 feature worktree 目录名。脚本自己向上查找 `.bare` 定位 workspace root，无需手动算路径。

**为什么要清理**：dev-link 让 pi 通过 `XYZ_EXTENSION_PATHS` 加载本地源码 extension。标准用法下 link 指向当前 worktree 自己的 `extensions/`，删 worktree 时该 worktree 内的 `.env.dev-extensions` 随之删除——不会残留。但存在**跨 worktree 残留**场景（用户在 main worktree 里 link 指向 feature worktree 测改动、手动编辑/复制 `.env.dev-extensions` 跨 worktree）：这些残留 link 在 feature worktree 删除后指向不存在的路径，下次 `pnpm dev` 时 pi 加载报 ENOENT。本阶段在删 worktree 前兜底清理所有这类残留。

**输出语义**：无残留时输出「无残留 link」并 exit 0；有残留时逐个列出被移除的路径并 exit 0。两种情况都不阻塞后续阶段。

> 历史背景：旧版阶段 1.5 标 `[OPTIONAL]` 且让在 workspace root 跑 `link-list.sh`——但 workspace root 不是 git repo，脚本 `git rev-parse --show-toplevel` 直接 exit 2，命令根本无法执行；且 AI 靠「记不记得用过 dev-link」决定是否跳过，残留风险高。现改为无条件执行 + 跨 worktree 精确清理。

### 阶段 2: PR CI + 合并

```bash
cd $WS_ROOT/main && bash .agents/skills/merge/scripts/pr-merge.sh <branch-name> <pr-number>
```

检查 PR CI 状态并通过 PR 合并（`gh pr merge --merge --delete-branch`，使用 merge commit 绝不 squash）。

**空 checks 防误判**：PR 的 `statusCheckRollup` 为空（CI checks 尚未注册）时，脚本不判「CI 通过」，而是每 15s 重查、最多 4 次；仍为空则 exit 1 并输出排查指引（确认 PR head commit 是否触发 CI / 人工核实），不会在 CI 完全未运行时开始合并。

脚本内部自动 sync 本地 main（`git fetch github && git reset --hard github/main`），无需手动执行。

### 阶段 3: Post-merge CI

```bash
cd $WS_ROOT/main
git fetch github
MAIN_SHA=$(git rev-parse github/main)
bash .agents/skills/merge/scripts/wait-for-ci.sh "$MAIN_SHA"
```

等待 main 分支 CI 通过。wait-for-ci.sh 在项目 skill 目录内（CI 轮询），需传入 commit SHA。

> ⚠️ **边界**：commit 在约 30s 内无任何 workflow run 时，wait-for-ci.sh 视为「无 CI」直接放行（exit 0）——merge commit 因 ci.yml 路径过滤可能未触发任何 run。此时 exit 0 ≠「CI 通过」，须先用 `gh run list --commit "$MAIN_SHA" --repo zhushanwen321/xyz-agent` 人工确认是否存在 run；确认无 run 属预期（如纯 docs 改动）才可继续，不得把该放行误判为「CI 通过」。

### [MANDATORY] 阶段 3.5: 版本校验

在 bump 版本之前，必须确认代码版本与最新正式 release 一致。
此校验防止版本号被跳过（例如从 v0.4.6 直接跳到 v0.4.8）。

```bash
cd $WS_ROOT/main
bash scripts/check-version-bump.sh
```

- **Exit 0（通过）**：代码版本 == 最新正式 release，可以安全 bump
- **Exit 1（失败）**：版本不匹配，或 pi 协议契约测试失败（W25 接线），会输出具体原因

失败时需要检查：
1. 是否有 prerelease（`-beta.N`）占用了目标版本号？清理后重试
2. 是否已经手动 bump 过版本？执行 `cd $WS_ROOT/main && pnpm version <latest_release_version> --no-git-tag-version` 回退
3. 可能是之前的 pre-release 测试未还原？运行 `cd $WS_ROOT/main && git reset --hard github/main` 重置
4. 版本号一致仍 exit 1？是 pi 协议契约测试失败（W25 接线：pi 依赖版本变更时先跑
   `packages/runtime/src/__tests__/equivalence/pi-protocol-contract.test.ts`，红 = 上游协议漂移）——
   先处理协议漂移再 bump，不要动版本号

### 阶段 4: 版本 bump + 发布

```bash
cd $WS_ROOT/main

# ⚠️ 本代码块每条 bash 调用必须自包含 `cd $WS_ROOT/main &&`（见阶段 0 cwd 隔离）。
#    bash 工具 cwd 不跨调用持久，会 reset 到 feature worktree，导致 bump 落错分支。
# ⚠️ 先确认当前分支是 main（pr-merge.sh 的 sync 会强制 checkout main，
#    但阶段 4 执行前必须二次确认，防止意外）
git branch --show-current  # 必须输出 main，否则 git checkout main

# ⚠️ 必须使用 --no-git-tag-version：所有 package.json 的变更必须在同一个
#    commit 中，否则第二次 version 因 tag 已存在而失败，导致 apps/electron
#    的版本号未提交，CI 从 apps/electron/package.json 读取到旧版本号。

# 1. 纯修改文件，不创建 commit 和 tag。
#    注意：pnpm@10 在 root 执行（不带 -r）只 bump root 包，并非递归 bump 所有包；
#    实际变更 = 本行根 package.json + 下一行 apps/electron/package.json，共两个文件
pnpm version patch --no-git-tag-version
cd apps/electron && pnpm version patch --no-git-tag-version && cd ../..

# 2. 原子提交：两个 package.json 在同一个 commit
VERSION=$(node -p "require('./package.json').version")
git add package.json apps/electron/package.json
git commit -m "chore: bump version to ${VERSION}"

# 3. 手动打 tag，确保指向包含两个文件变更的 commit
git tag "v${VERSION}"

# 4. 推送 commit + tag
git push github HEAD
git push github "v${VERSION}"

# [MANDATORY] 等待 CI 完成并验证产物
# 此命令会轮询 CI 直到完成，验证 dmg/exe/AppImage 全部存在
# exit 非 0 则必须修复直到通过
bash scripts/verify-ci-release.sh "v$(node -p "require('./package.json').version")"
```

**Electron 特化说明**：
- Release CI（`release.yml`）由 tag push 触发
- DMG/EXE/AppImage 由 CI 构建，不在本地生成
- 本地构建验证是预防措施，不产生最终交付物

### 阶段 4N: npm Extension 发布（可选）

> **仅在本次 PR 含 extension 改动（`extensions/` 有变更）时执行。** 纯 Electron 改动（如只改 packages/ 或 apps/）跳过本阶段。
>
> npm 发布线与 Electron 发布线**完全独立**：
> - Electron 走 `v*` tag（阶段 4）→ `release.yml` → DMG/EXE/AppImage
> - npm 走 `npm-*` tag（本阶段，格式 `npm-<slug>-<date>-<time>`）→ `release-npm.yml` → npm registry（@xyz-agent/* + @zhushanwen/pi-*）
>
> **本阶段采用人工版本判定机制**（不再用 `changeset version` 自动推算 type，避免 shouldBumpMajor/applyLinks 把声明的 minor 误放大成 major）。完整设计见 docs（版本号人工判定机制）。脚本：`scripts/check-version-changes.sh` + `scripts/apply-version.sh`。
>
> **dev-npm 预发布线不受本阶段影响**：预发布（`dev-npm-*` 分支 → `release-npm-dev.yml`）仍走 `changeset version` + `changeset pre` 全流程，两条机制并存。

#### 4N.1 检查需要版本处理的包

```bash
cd $WS_ROOT/main && git fetch github && git reset --hard github/main
# ⚠️ merge 后本地 main == HEAD，「main..HEAD」range 为空，check-version-changes 会扫不到 PR 改动 →
# NEEDS_VERSION=false 误跳过 4N。必须用 PR 的 merge commit range（PR 前 main..PR merge commit，
# 即 merge commit 的 first-parent diff）：
PR_MERGE=$(gh pr view "$PR_NUMBER" --repo zhushanwen321/xyz-agent --json mergeCommit --jq '.mergeCommit.oid')
bash scripts/check-version-changes.sh "${PR_MERGE}^1..${PR_MERGE}"
```

脚本输出：
- `NEEDS_VERSION=true|false`（false = 本次无源码改动，跳过 4N）
- `CHANGED_PACKAGES`：已声明 changeset 的包 + 声明的 type（只显示不采纳）
- `UNDECLARED_PACKAGES`：改了 src 但无 changeset（PR 漏声明警告）—— 非空则补写 `.changeset/<slug>.md` 后重跑
- `DEPENDENTS_OF_CHANGED`：**传递闭包**，自己没改 src 但通过 workspace: 直接/间接引用了已 bump 包、须 patch 重发刷新 tarball 范围的包（标注层数与触发链路）
- `LINKED_GROUPS_AFFECTED`：linked 组受影响参考（不强制对齐）

**决策面 = `CHANGED_PACKAGES` ∪ `DEPENDENTS_OF_CHANGED`**，两者都要进 4N.2/4N.3。

#### 4N.2 人工定 type [MANDATORY 人工决策]

**人工只需对 `CHANGED_PACKAGES` 定 type**（自己 src 改了的包）。`DEPENDENTS_OF_CHANGED` 的 patch 由 4N.3 脚本自动执行（规则一确定性，无需人工传参）。

对 `CHANGED_PACKAGES` 的每个包，按准则定 major/minor/patch：

| type | 准则 |
|------|------|
| major | 多个重要功能，或架构升级 |
| minor | 少量功能，或单一功能新增 |
| patch | 纯问题修复 |

**dep 传播（两条规则）**：
- **规则一（机械，自动）**：`DEPENDENTS_OF_CHANGED` 的包由 apply-version.sh 自动 patch bump（刷新 tarball 里 workspace:* 解析后的范围，避免消费者 ERESOLVE 或被钉旧版本）
- **规则二（语义，人工）**：`CHANGED_PACKAGES` 里某包自身代码受 breaking 影响 → 在其 type 里直接体现（人工定 minor/major）
- linked 组不强制版本对齐；fixed 组（当前空）若启用则整组同步（apply-version.sh 兜底）

> 参考 `.changeset/*.md` 的 type 初判，但不绑死。可能出现「声明 minor 但实际该 patch」——以人工判断为准。

#### 4N.3 改 version + 生成 CHANGELOG

```bash
cd $WS_ROOT/main
# 人工只传 CHANGED_PACKAGES 的 type；DEPENDENTS_OF_CHANGED 由脚本自动 patch
# ⚠️ dependents-from 的 range 同 4N.1：用 PR merge commit range，不是「main..HEAD」（merge 后为空）
PR_MERGE=$(gh pr view "$PR_NUMBER" --repo zhushanwen321/xyz-agent --json mergeCommit --jq '.mergeCommit.oid')
bash scripts/apply-version.sh \
  --changed @zhushanwen/pi-<pkg-a>=minor @zhushanwen/pi-<pkg-b>=patch \
  --dependents-from <(bash scripts/check-version-changes.sh "${PR_MERGE}^1..${PR_MERGE}")
```

脚本：CHANGED_PACKAGES 按 type semver bump + DEPENDENTS_OF_CHANGED 自动 patch（规则一）+ 生成 CHANGELOG（CHANGED 用 changeset body，DEPENDENTS 用自动 `chore: refresh dependency range` 条目）+ 消费（删除）.changeset/*.md + fixed 组一致性校验。

验证：
```bash
cd $WS_ROOT/main
git diff -- extensions/*/package.json extensions/shared/*/package.json packages/*/package.json | grep '^[+-]  "version"'
git diff --name-only | grep CHANGELOG
ls .changeset/*.md 2>/dev/null | grep -v README.md && echo "⚠️ 未消费的 changeset 残留" || echo "✓ changeset 全消费"
```

> **不确定时可先 --dry-run**：`bash scripts/apply-version.sh --changed ... --dependents-from <(...) --dry-run` 预览将做的改动，不写文件。

#### 4N.4 commit + tag + push

```bash
cd $WS_ROOT/main
SLUG="<本次发布主题-kebab>"   # 人工定，来自 PR 标题
STAMP=$(date +%Y%m%d-%H%M)

git add extensions/*/package.json extensions/shared/*/package.json packages/*/package.json \
        '**/CHANGELOG.md'
git commit -m "chore: version bump — <包与版本摘要>"

# npm-* tag（不绑单一版本号，多包不同步时不误导；release-npm.yml 不从 tag 解析版本）
git tag "npm-${SLUG}-${STAMP}"

git push github HEAD
git push github "npm-${SLUG}-${STAMP}"
```

#### 4N.5 验证 npm 发布

`npm-*` tag push 触发 `release-npm.yml` CI：
1. `pnpm install --frozen-lockfile`
2. **Verify NOT in prerelease mode**（检查 `.changeset/pre.json` 不存在；若残留会整批误发 dev tag，CI hard fail）
3. `pnpm --filter @xyz-agent/extension-protocol build` + `pnpm extensions:typecheck`
4. `pnpm changeset publish`（预查 registry，只发未发布版本；extensions 直接发 .ts 源码）

验证 CI 完成 + npm 上线：
```bash
cd $WS_ROOT/main
# 轮询 CI
gh run list --workflow=release-npm.yml --repo zhushanwen321/xyz-agent --limit 3
gh run watch <run-id> --repo zhushanwen321/xyz-agent

# 必须带具体版本号查（packument 任何版本都返回 200，验不出新版本发布）
for entry in "@zhushanwen/pi-<pkg> <version>"; do
  pkg=${entry% *}; ver=${entry##* }
  scoped=$(echo "$pkg" | sed 's|/|%2f|')
  code=$(curl -s -o /dev/null -w "%{http_code}" "https://registry.npmjs.org/${scoped}/${ver}")
  [ "$code" = "200" ] && echo "✓ ${pkg}@${ver} 已发布" || echo "✗ ${pkg}@${ver} 未发布 (${code})"
done
```

**[MANDATORY] 禁止本地 `pnpm changeset publish` / `npm publish`**：npm 发布由 CI 完成（NPM_TOKEN 认证）。本地只做 version bump + tag push。

### 阶段 5: Release Notes + Release

```bash
cd $WS_ROOT/main && bash .agents/skills/merge/scripts/release.sh
```

从 conventional commits 自动生成 Release Notes 草稿（双语三节结构：feat → 新增功能、perf → 功能优化、fix → 修复缺陷、breaking → 重大变更；条目为 commit 原文，须按 docs/release-notes.md 定稿）并创建/更新 GitHub Release。也可指定 tag 和 notes 文件：`cd $WS_ROOT/main && bash .agents/skills/merge/scripts/release.sh v0.6.5 --notes ./my-notes.md`。

> ⚠️ **release.sh 自动 notes 在 merge 末尾常不准**：脚本用 `git describe HEAD^` 找上一个 tag，但 merge 流程末尾 HEAD 已远超当前 tag（经过 bump + skill 更新 + 4N bump 等 commits），`git describe HEAD^` 会返回**当前 tag**，导致 range = `<当前tag>..HEAD` 几乎为空、自动 notes 退化。实际执行中建议跳过自动生成，直接按 docs/release-notes.md 手写双语 notes 后用 `gh release edit <tag> --notes-file <双语文件>` 覆盖（见下方 [MANDATORY] 要求）。

**[MANDATORY] 撰写 Release Notes 前必须先读 [docs/release-notes.md](../../../docs/release-notes.md)**

Release note 面向应用使用者（升级按钮 hover 浮层是唯一 UI 展示位），写作规范 SSOT 在该文档，要点：

- 三节结构：新增功能（「新增」开头）/ 功能优化（「优化」开头，含性能）/ 修复缺陷（「修复」开头，按重要程度排序）
- 每条一行、约 30 字以内，面向用户模糊化；extension / workflow 能力变化也要写（如「优化 review-fix-loop workflow 流程」）
- 工程细节（测试、CI、内部重构、构建脚本）不进 note，放 PR 描述；修复超过 10 条时第 11 条起合并为「修复其他缺陷」

**[MANDATORY] Release Notes 必须中英双语**

Release Notes 需要同时包含中文和英文版本，使用 `<!-- LANG:zh -->` 和 `<!-- LANG:en -->` 标记分隔。前端会根据用户语言偏好自动提取对应部分。

格式示例（完整示例见 docs/release-notes.md）：
```markdown
<!-- LANG:en -->
## New Features
- Add feature Y

## Bug Fixes
- Fix bug X

<!-- LANG:zh -->
## 新增功能
- 新增功能 Y

## 修复缺陷
- 修复 bug X
```

注意事项：
- 英文在前，中文在后（便于 GitHub 默认显示英文）
- 每个语言部分保持独立的 markdown 结构
- 标记必须独占一行，前后可有空行
- 向后兼容：无标记的 release 仍正常显示完整内容

**[MANDATORY] 校验 Release Notes 双语格式**

在创建 Release 后，必须校验 Release Notes 包含双语标记：

```bash
cd $WS_ROOT/main

# 本代码块独立取版本（shell 变量不跨代码块持久，不会从阶段 4 的代码块带过来）
VERSION=$(node -p "require('./package.json').version")

# 获取刚创建的 release body
RELEASE_BODY=$(gh release view "v${VERSION}" --json body -q '.body')

# 校验是否包含中英双语标记
if ! echo "$RELEASE_BODY" | grep -q '<!-- LANG:en -->'; then
  echo "ERROR: Release Notes 缺少英文标记 <!-- LANG:en -->"
  exit 1
fi

if ! echo "$RELEASE_BODY" | grep -q '<!-- LANG:zh -->'; then
  echo "ERROR: Release Notes 缺少中文标记 <!-- LANG:zh -->"
  exit 1
fi

echo "✓ Release Notes 双语格式校验通过"
```

如果校验失败，需要编辑 release 添加双语标记：
```bash
# shell 变量不跨代码块持久，先取版本
VERSION=$(node -p "require('./package.json').version")

# 编辑 release body（保留原有内容，添加语言标记）
gh release edit "v${VERSION}" --notes-file ./release-notes-bilingual.md
```

### 阶段 6: 交付物验证（Electron 特化）

⚠️ **不可跳过**。这是阶段 7 的硬性前置条件。

```bash
cd $WS_ROOT/main
bash scripts/verify-ci-release.sh "v$(node -p "require('./package.json').version")"
```

脚本会自动：
- 轮询 CI workflow 直到完成
- 等待 GitHub Release 创建
- 验证所有平台产物（dmg + exe + AppImage）完整性

**exit 0 前不得进入阶段 7。** exit 非 0 必须修复。

可选的本地验证脚本（项目根目录 `scripts/` 下）：

```bash
cd $WS_ROOT/main
bash scripts/postbuild-validate.sh
bash scripts/validate-runtime-bundle.sh
```

### 阶段 7: 清理（终结阶段）

⚠️ **终结步骤**：阶段 7 是整个 merge 流程的**最后一步**。`remove-worktree.sh` 执行完毕后**立即输出合并总结收尾**，禁止再调用任何 bash 工具做"删除确认"或执行额外任务。

如果执行后 bash 工具报 ENOENT / cwd 不存在——这是删除 worktree **已成功**的最强确认（当前 shell 的 cwd 落在被删目录内），不是错误。详见底部 [HISTORICAL] 阶段 7 后 bash 工具失效处理。

调用本 skill 的 remove-worktree.sh 清理 feature worktree 和本地分支（命令全文见下方「自动化执行」代码块，本阶段只此一个命令版本，避免出现不一致的两个副本）。`--force` 跳过已合并检查并强制删除（含未提交/未跟踪内容，删除前会列出将销毁的清单）——分支已删除（远程 delete-branch）时本地 `git branch --merged` 检查会误判，故恒用 `--force`。`--skip-sync` 因为 pr-merge.sh 已 sync 过 main。

门禁：阶段 7 启动前**必须**确认阶段 6（`verify-ci-release.sh`）已 exit 0。

⚠️ **cwd 隔离 [HISTORICAL]**：bash 工具每次调用都是独立 shell，cwd **不跨调用持久**，reset 到 session 启动目录（通常是 feature worktree 内）。`remove-worktree.sh` 内部有 `cd "$WORKSPACE_ROOT"` 自我保护，但那只对脚本当次执行有效——脚本退出后，下次 bash 调用的 cwd 又 reset 回 session 启动目录。

若 session 启动目录就是即将删除的 feature worktree，脚本删掉该目录后，后续 bash 调用的 cwd 指向已删除目录 → ENOENT。

**自动化执行阶段 7 时，调用 remove-worktree.sh 的那条 bash 命令必须自包含 `cd $WS_ROOT/main &&`**（见阶段 0 cwd 隔离）。即便如此，删除后 session 启动目录已不存在，**后续任何 bash 调用仍可能 ENOENT**——因此阶段 7 必须是流程最后一步，删除后立即收尾，不再调 bash（手动终端执行则脚本内部的 cd 足够，因为终端 shell 的 cwd 会跟随 cd）。这与 AGENTS.md §8「multi-workspace cwd 不跨调用持久」是同一类陷阱。

```bash
cd $WS_ROOT/main && bash .agents/skills/merge/scripts/remove-worktree.sh <branch-name> --force --skip-sync
```

## AI 操作步骤

### 1. 创建 todo 清单

收到合并指令后立即创建 todo：

| # | 文本 | 命令 |
|---|------|------|
| 1 | 初始化环境（阶段 0） | |
| 2 | 本地验证（阶段 1） | |
| 2.5 | ⚠️ Dev-Link 清理（阶段 1.5） | `cd $WS_ROOT/main && bash .agents/skills/merge/scripts/prune-dev-link.sh "$WS_ROOT/<worktree-dir>"` |
| 3 | PR CI + 合并（阶段 2） | |
| 4 | Post-merge CI（阶段 3） | |
| 5 | ⚠️ 版本校验（阶段 3.5） | `bash scripts/check-version-bump.sh` |
| 6 | Electron 版本 bump + 发布（阶段 4） | `bash scripts/verify-ci-release.sh ...` (在 push 后调用) |
| 6N | ⚠️ npm 发布（阶段 4N，可选） | 仅含 extensions/ 改动时执行：人工定 type（check + apply 脚本）+ npm-* tag |
| 7 | 创建 Release（阶段 5） | |
| 8 | ⚠️ 确认交付物（阶段 6） | `bash scripts/verify-ci-release.sh ...` |
| 9 | 清理 worktree（阶段 7，终结步骤） | 删除后直接输出总结，不再调 bash |

### 2. 执行约束

- 所有阶段脚本必须在 workspace root 或其子目录（非目标 worktree）内执行
- 阶段 1 和阶段 6 的检查**零容忍**，所有错误必须正面修复
- bash timeout >= 1200s（Release CI 含 Electron build 可能耗时 10 分钟以上）

### 3. 故障恢复

每个阶段独立执行。失败后修复重跑同一阶段即可。

## [HISTORICAL] 禁止跳过检查

所有 githooks 和自动化检查（lint、ruff、脚本检查、pre-commit hook、CI 检查等）报告的问题，**必须正面修复**。绝不允许通过 `SKIP_*` 环境变量、`--no-verify`、`eslint-disable`、`# noqa` 等方式绕过或静默。检查不通过 = 流程中止，唯一的出路是修复代码让检查通过。

此规则来源于多次事故：跳过检查掩盖了真实 bug，上线后才发现问题，修复成本远高于当时正面解决。

## [HISTORICAL] 阶段 7 后 bash 工具失效处理

阶段 7 `remove-worktree.sh` 删除的是 feature worktree 目录。如果在执行该脚本时，主 agent 的 bash 工具 cwd 恰好在该目录内，删除后 **bash 工具会失效**（后续命令报 ENOENT "No such file or directory" 或类似 cwd 错误）。

**这是删除已成功**的最强确认信号——**不是错误**。原因：

1. bash 工具每个命令在新 shell 内执行，shell 的 cwd 继承自某处（具体继承语义取决于 harness 实现）
2. 目标 worktree 目录已被 `git worktree remove` + `rmdir` 真实删除
3. 现有 shell 的 cwd 指向不存在的目录 → 新命令的 bash 进程启动即失败

**正确处理**：

- 删除 worktree 这一步**必须是 merge 流程的最后操作**
- 执行完 `remove-worktree.sh` 后**立即输出合并总结收尾**，不再调用任何 bash 工具做"再次确认"或执行其他任务
- 如果 bash 失效已发生，**不要再尝试调用 bash**——这只会循环报错
- 此时不需要（也不可能）做 git status / ls / pwd 等确认；删除本身的成功（无论脚本 exit 0 还是 bash 后续失效）已经说明清理完成
- 例外：如果脚本本身因业务原因（如分支未合并、worktree 被占用）**明确 exit 非 0**，那是另一回事，需按脚本输出排查；bash 失效仅在删除**已执行**后发生

**反模式**：删除后为"确认"再跑 `git worktree list` / `ls <worktree-dir>` → bash ENOENT → 误判为"删除失败"或"流程出错"→ 尝试 `cd $WS_ROOT` 重试 → 可能进一步混乱。

## 项目特化

- **交付方式**：GitHub Release + Electron 产物（DMG/EXE/AppImage）
- **版本管理**：根 `package.json` + `apps/electron/package.json`（阶段 4 内联命令原子 bump 两个文件）
- **构建验证**：本地 `pnpm run build` + CI 全量构建

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[HISTORICAL]` | 历史经验总结的规则。来自实际事故和教训，经验证有效后固化为规则 | **不允许删除或削弱**。修改时只能在原有基础上补充，不能降低要求 |
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
