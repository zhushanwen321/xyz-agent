# xyz-pi-extensions 深度整合到 xyz-agent — 完整记录

> **日期**：2026-07-30
> **PR**：[#133](https://github.com/zhushanwen321/xyz-agent/pull/133)
> **分支**：`feat-merge-with-extensions`
> **规模**：749 文件，+145,259 行，15 个 commit
> **状态**：已完成，待 review/merge

---

## 1. 目标

将 `~/Code/xyz-pi-extensions-workspace/main` 下的所有 pi extension（16 个 `@zhushanwen/pi-*` 包 + 1 个共享库 `quota-providers`）**深度整合**到 xyz-agent 项目。

"深度整合"意味着：

1. **源码归位** — 在 xyz-agent 仓库开辟 `extensions/` 目录存放工程源码，不是 git submodule 或外部依赖
2. **发布迁移** — npm 发布流程从旧仓库迁移到 xyz-agent，旧仓库废弃归档，`@zhushanwen/pi-*` 包版本号延续（用户无感）
3. **工程体系融合** — lint / CI / 发布 / 文档 / skill / agent **不是简单文件挪动**，而是与 xyz-agent 现有体系深度合并，消除重复，统一规范
4. **开发工具链整合** — `.agents/` 下的 review agent、skill 深度改造适配 xyz-agent 架构

---

## 2. 设计思路

### 2.1 核心原则

| 原则 | 含义 | 在本次整合中的体现 |
|------|------|-------------------|
| **一致性 > 品味** | 遵守目标项目现有约定，不悄悄另起炉灶 | extensions 用 tab 缩进（pi 生态约定），eslint 关闭 indent 规则而非强制改 2 空格 |
| **深度整合非简单叠加** | 每个资产判断"合并/抽取/迁独立/丢弃"，不做机械复制 | 3 个重名 skill 逐个内容级合并，取两边互补内容 |
| **方案推荐优先长期合理性** | 标注长期/短期方案 | dev-link 重新设计而非迁移（短期多写代码，长期架构正确） |
| **认知外的改动绝不擅自处理** | 不碰非本次会话产物 | `tools/.zcode/` 全程未暂存、未修改、未删除 |

### 2.2 资产分类决策框架

迁移前对源仓每个资产做**内容级分析**，按 5 类处置：

```
资产 → ┌─ 源独有 + xyz-agent 需要     → 迁移（适配改造）
       ├─ 源独有 + xyz-agent 不需要   → 丢弃（旧仓归档后历史可查）
       ├─ 重名 + 内容互补             → 深度合并（取两边增量）
       ├─ 重名 + 内容冲突             → 保留当前版（目标项目优先）
       └─ 全局已有                    → 不重复持有
```

### 2.3 双发布线架构

整合后 xyz-agent 同时维护两条**互相独立**的发布管线：

```
                    ┌── v* tag ──→ release.yml ──→ DMG/EXE/AppImage（Electron 桌面应用）
                    │
xyz-agent 仓库 ─────┤
                    │
                    └── npm-v* tag ──→ release-npm.yml ──→ npm registry
                                                       （@xyz-agent/extension-protocol
                                                         + 16 个 @zhushanwen/pi-*
                                                         + quota-providers）
```

- **版本号独立** — Electron 是 `0.8.x`，extension 各自有版本（goal `0.2.13`、todo `0.1.5`）
- **tag 前缀隔离** — `v*` 只触发 Electron CI，`npm-v*` 只触发 npm CI，互不干扰
- **发版节奏独立** — 改了 extension 不一定要发 Electron 新版，反之亦然

---

## 3. 执行过程

按 6 个 Phase 推进，每个 Phase 独立 commit + 验证：

### Phase 1：源码迁移 + 工程骨架

**目标**：16 个 extension + quota-providers 源码迁入 `extensions/`，跑通 install + typecheck + test。

**关键决策**：
- 源码目录用顶层 `extensions/`（不与 `packages/` 混合，语义清晰）
- pi SDK 类型解析：根 devDependencies 安装真实 `@earendil-works/pi-coding-agent@0.82.1`（弃用旧仓的 `shared/types/` 类型桩——硬编码 nvm 路径违反 §16）
- `pnpm-workspace.yaml` 扩展包含 `extensions/*` + `extensions/shared/*`

**踩坑**：
- 31 个 SDK 偏差类型错误（源仓基于旧类型桩，真实 SDK 0.82.1 有 API 变更：ExtensionMode 未导出、SessionEntry 变联合类型、typebox 结构不匹配）→ 通过本地别名、类型守卫修复至 0 错误
- vite 8.1.3 oxc 解析器拒绝被继承 tsconfig exclude 的测试文件 → 6 个包制作独立 tsconfig

**Commit**：`e726711d0` feat(extensions): integrate pi-extensions source

### Phase 2：Lint 整合

**目标**：源仓 4 条独有 TS 规则合并进 taste-lint，extensions/ 的 ESLint 覆盖块。

**关键决策**：
- 4 条规则注册到 `taste-lint/base.mjs` 但**不加入默认 tasteRules**（不影响 renderer/runtime）
- eslint.config.mjs 新增 extensions 覆盖块：关闭 indent（tab 约定）、max-lines 放宽到 1000、启用 4 条 TS taste 规则
- pre-commit hook 增加 EXTENSION_FILES 检查 + manifest/约定校验

**踩坑**：
- 缩进冲突（21426 个 warning）：extensions 用 tab，目标强制 2 空格 → 关闭 indent 规则（一致性 > 品味）

**Commit**：`2388a033b` refactor(lint): merge pi-taste-lint rules

### Phase 3：发布流程整合

**目标**：changeset 配置 + release-npm.yml 改造，支持多包发布。

**关键决策**：
- changeset `ignore` 列表排除 6 个 internal 包（Electron 专属），16 个 extension + extension-protocol + quota-providers 自动可发布
- release-npm.yml 只做 `changeset publish`（version 在 merge skill 本地做，CI 只发布——与源仓模式一致）
- `.npmrc` 加 `access=public`（@zhushanwen scope）

**Commit**：`75458c5bc` ci: extend npm release workflows

### Phase 4：文档深度整合

**目标**：源仓文档按"合并/抽取/迁独立/丢弃"四类处置。

**关键产出**：
- `docs/extensions/development-guide.md`（2304 行）— 源仓 standards.md + production-guide.md 合并为一份
- `docs/extensions/extension-conventions.md` — 从源 CLAUDE.md 抽取的 pi extension 强约束
- `docs/extensions/glossary.md` — 从源 CONTEXT.md 抽取的 pi 平台术语（恢复 28 个遗漏术语）
- `docs/extensions/adr/` — 22 个 ADR（pi-ext- 前缀防撞号），17 条必须迁移 + 5 条选择性迁移 + 14 条丢弃
- 竞品逆向/设计研究文档全部整合到 docs（不丢弃）

**Commit**：`a573f26dc` + `70129b9ca` + `3b4be08ef`

### Phase 5：AGENTS.md 更新

**目标**：并入源仓 4 处互补增量。

**产出**：Git 规范章节、TS unsafe cast 防护、npm 发布子流程表格、§17 跨层排查交叉引用、pi 版本提升至 0.82.1、扩展命令、SKIP_EXTENSION_LINT。

**Commit**：`615e34cf9`（含审查修复）

### Phase 6：深度审查 + 修复

**目标**：4 个 subagent 并行审查迁移完整性、文档遗漏、lint 配置、CI 缺口。

**发现并修复**：tsconfig 回归、ADR 交叉引用失效、glossary 术语遗漏、CI 缺口。

**Commit**：`615e34cf9` fix(extensions): address review findings

---

## 4. 第二轮深化：CI 修复 + .agents 迁移

第一轮完成后，用户要求进一步审查发布配置 + 深度迁移 .agents 目录。

### 4.1 CI/发布配置审查与修复

派 background reviewer 审查，发现 2 critical + 3 major。**逐一核验后修正了 reviewer 的 C2 误判**：

| 问题 | reviewer 判定 | 核验结果 | 修复 |
|------|-------------|---------|------|
| C1 release-npm.yml 缺 changeset version | critical | **修正**：CI 只 publish 是正确设计（本地 version + CI publish）。真正 gap 是 merge skill 缺 npm 发布线 | merge skill 加阶段 4N |
| C2 typebox peerDep 写错 | critical | **推翻**：源码 import `typebox`（v1.3.8 新版），不是 `@sinclair/typebox`。reviewer 误判 | 修 model-switch 冗余声明 + vision 写反 |
| M1 预发布 dist-tag 脆弱 | major | 确认 | release-npm-dev.yml 加 pre.json 存在性检查 |
| M2 npm-prerelease 只 bump extension-protocol | major | 确认 | 脚本改为接受包名参数 |
| M3 跨包版本漂移 | major | 确认 | changeset 加 2 个 linked 组 |

**教训**：reviewer 的结论不能盲信——C2 的 typebox 判断基于"裸 typebox 是笔误"的假设，但实际是两个不同的包（v1.3.8 新版 vs v0.34 经典版，结构不兼容）。**必须读源码验证 import 语句**。

### 4.2 .agents 目录迁移

#### review agent 补全（新增 2 维度）

当前项目 6 个 review-*.md agent 是**孤立资产**（没有任何 skill 调度它们）。迁移源仓 2 个独有维度：

- `review-extension-api.md` — Tool/Command schema、pi manifest、向后兼容（适配指向 docs/extensions/）
- `review-monorepo-impact.md` — workspace 依赖、循环依赖、公共 API（适配 pnpm workspace 结构）

迁移后 8 个 agent：aggregator + 7 维（arch-boundary / business-logic / electron-build / extension-api / monorepo-impact / test-coverage / type-safety）。

#### pr-cr-fix skill 深度改造

源仓 pr-cr-fix 是 review→fix→PR 统一编排，**正好能激活上述孤立的 review agent**。深度改造：

| 改造点 | 原文 | 改为 |
|--------|------|------|
| 项目名 | xyz-pi-extensions | xyz-agent |
| review 维度 | 5 维全并行 | **7 维 5+2 分批**（subagent 并行上限 5） |
| .pi/workflows 分支 | 保留 | **删除**（当前项目无 .pi/workflows） |
| pre-merge | pnpm -r | **适配多线命令**（extensions:typecheck + 各 vitest） |

配套迁移 3 个 pr-*.sh 脚本 + 2 个 validate-*.py。

#### dev-link skill 重新设计（非迁移）

**根本性不匹配**：源仓 dev-link 操作 pi CLI 的 `~/.pi/agent/extensions/` symlink + `pi install` 命令。xyz-agent 是 Electron 应用，extension 加载机制完全不同：

| 维度 | 源仓 dev-link | xyz-agent 实际 |
|------|--------------|----------------|
| extension 目录 | `~/.pi/agent/extensions/` symlink | 不存在此目录 |
| 注册方式 | `pi install` 写 settings.json | 无 pi install，用 NpmInstaller + ExtensionResolver 五源扫描 |
| 官方机制 | symlink + settings.json | **`XYZ_EXTENSION_PATHS` 环境变量**（live link） |

**重新设计为 `XYZ_EXTENSION_PATHS` 管理工具**：
- `link-local.sh <pkg>` — 写入 `.env.dev-extensions`（多包、跳过库包）
- `link-npm.sh <pkg>` — 移除指定包（`--all` 全清）
- `link-list.sh` — 显示状态 + git-dirty 检测

**踩坑**（两个 bash 经典陷阱）：
1. `set -e` 下 `((var++))` 在 var=0 时表达式值为 0（false），被 set -e 捕获退出 → `((var++)) || true`
2. `node -e "..." VAR=val` 中 `VAR=val` 在 command 后被当 argv → 必须写 `VAR=val node -e "..."`（环境变量前缀在 command 前）

#### 重名 skill 深度合并（非覆盖）

3 个重名 skill 两边各有对方没有的内容，以当前版为基底并入源仓增量：

| skill | 并入的增量 | 保留的当前版特化 |
|-------|-----------|----------------|
| **code-review** | Pi Extension SDK 接口契约 checklist（handler 签名、ctx.mode rpc、spec 偏差、schema 一致性、类型断言 guard）+ pr-cr-fix 关系说明 | Electron/Vue 9 维度 checklist |
| **pull-request** | 自动从 conventional commit 生成 PR title/body + 集成 pr-submit.sh + force-push 指引 | bare repo workspace 特化（github remote） |
| **merge** | 阶段 1.5 dev-link 清理（防 worktree 删除后 symlink dangling） | 9 阶段脚本驱动 + Electron 双发布线 + cwd 隔离 [HISTORICAL] |

#### changeset 完整性检查

**问题**：PR 改了 `extensions/*/src/` 但忘了创建 changeset → merge 时 `changeset version` 不 bump → bug fix 静默丢失。

**三处协同防护**：
- `pr-pre-merge.sh` Step 5：git diff 检测改了 src/ 的包，与 `.changeset/*.md` 交叉比对，缺失时 WARN（不阻断）
- `pull-request` SKILL.md：说明检查逻辑 + 补救方式
- `pr-cr-fix` Gate-3a.5：subagent 返回 `changeset_missing` 时主 agent 用 AskUserQuestion 让用户决策

---

## 5. 执行结果

### 5.1 最终目录结构

```
xyz-agent/
├── extensions/                          # 【新增】16 个 pi extension + shared
│   ├── ask-user/                        # @zhushanwen/pi-ask-user
│   ├── context-engineering/
│   ├── evolve-daily/
│   ├── goal/
│   ├── model-switch/
│   ├── pending-notifications/
│   ├── permission/
│   ├── plan/
│   ├── rename-session/
│   ├── scheduler/
│   ├── statusline/
│   ├── structured-output/
│   ├── subagent-workflow/
│   ├── todo/
│   ├── unified-hooks/
│   ├── vision/
│   ├── shared/
│   │   └── quota-providers/             # 共享库（被 model-switch/statusline 依赖）
│   └── tsconfig.json                    # extensions 独立类型检查配置
│
├── docs/extensions/                     # 【新增】文档深度整合
│   ├── development-guide.md             # 合并自 standards + production-guide（2304 行）
│   ├── extension-conventions.md         # 从 CLAUDE.md 抽取的强约束
│   ├── glossary.md                      # 从 CONTEXT.md 抽取的术语表
│   ├── local-dev-guide.md               # 本地开发指南（XYZ_EXTENSION_PATHS）
│   ├── gui-protocol-guide.md
│   ├── pi-tui-development-guide.md
│   ├── adr/                             # 22 个 pi-ext- ADR
│   ├── permission/                      # 权限扩展设计文档
│   ├── subagents/                       # 子代理设计文档
│   ├── scheduler/                       # 调度器设计文档
│   └── research/                        # 竞品逆向研究
│
├── .agents/                             # 【深度整合】skill + agent
│   ├── agents/                          # 8 个 review agent（7 维 + 聚合器）
│   │   ├── review-aggregator.md
│   │   ├── review-arch-boundary.md
│   │   ├── review-business-logic.md
│   │   ├── review-electron-build.md
│   │   ├── review-extension-api.md      # 【新增】extension 接口维度
│   │   ├── review-monorepo-impact.md    # 【新增】monorepo 影响维度
│   │   ├── review-test-coverage.md
│   │   └── review-type-safety.md
│   └── skills/
│       ├── code-review/                 # 【深度合并】+SDK 契约 checklist
│       ├── dev-link/                    # 【重新设计】XYZ_EXTENSION_PATHS 管理
│       ├── merge/                       # 【深度合并】+阶段 1.5 dev-link 清理 + 阶段 4N npm 发布
│       ├── pr-cr-fix/                   # 【深度改造】7 维 review→fix→PR 编排
│       ├── pull-request/                # 【深度合并】+自动生成 PR title/body + changeset 检查
│       ├── code-link/                   # 原有
│       ├── npm-prerelease/              # 原有
│       ├── prerelease-test/             # 原有
│       └── zcommit -> ~/.agents/...     # 全局 symlink
│
├── .changeset/config.json               # 【修改】linked 组 + ignore 列表
├── .github/workflows/
│   ├── release-npm.yml                  # npm 发布（npm-v* tag）
│   ├── release-npm-dev.yml              # npm 预发布（+pre.json 防护）
│   ├── release.yml                      # Electron 发布（v* tag，不变）
│   └── ci.yml                           # +extensions typecheck/test
│
├── taste-lint/rules/                    # 【新增】4 条 TS 规则
│   ├── no-unbounded-while-true.mjs
│   ├── no-inline-import-type.mjs
│   ├── no-eslint-disable.mjs
│   └── no-unsafe-cast.mjs
│
├── scripts/
│   ├── pr-pre-merge.sh                  # 【新增】pre-merge 一体化（+changeset 检查 Step 5）
│   ├── pr-status.sh                     # 【新增】PR 状态查询
│   ├── pr-submit.sh                     # 【新增】PR 创建/更新
│   └── npm-prerelease.sh                # 【修改】支持指定包名
│
└── AGENTS.md                            # 【深度合并】+Git 规范 + npm 发布线 + dev-link + review 工作流
```

### 5.2 量化结果

| 维度 | 数量 |
|------|------|
| commit 总数 | 15 |
| 文件变更 | 749 文件，+145,259 行 |
| 迁入 extension 包 | 16 个 + quota-providers |
| 文档整合 | development-guide（2304 行）+ conventions + glossary + 22 ADR + 研究文档 |
| review agent | 8 个（新增 2） |
| skill 整合 | 6 个（新增 dev-link + pr-cr-fix，深度合并 code-review/pull-request/merge） |
| 新增脚本 | pr-pre-merge.sh / pr-status.sh / pr-submit.sh / dev-link × 3 |
| CI 修复 | 2 critical + 3 major + 4 minor |
| taste-lint 规则 | 新增 4 条 TS 规则 |

### 5.3 验证状态

| 检查项 | 结果 |
|--------|------|
| `pnpm extensions:typecheck` | 0 错误 |
| `npx eslint extensions/` | 0 errors（150 warnings，均为已知代码品味，非本次引入） |
| extensions 测试（vitest） | 全绿 |
| runtime 测试（2061） | 通过 |
| renderer 测试（2572） | 通过 |
| pre-commit hook（含新 manifest/convention 检查） | 通过 |
| 8 个 review agent frontmatter | 格式一致 |
| dev-link 脚本功能测试 | link/unlink/list/idempotent/lib-skip/all-clear 全通过 |
| pr-pre-merge.sh changeset 检查 | 检测准确（当前分支 17 个包缺 changeset，正确 WARN） |

### 5.4 待办（用户手动）

| 事项 | 说明 |
|------|------|
| GitHub Archive 旧仓 | Settings → Archive（xyz-pi-extensions） |
| NPM_TOKEN 权限确认 | 确认 token 对 @zhushanwen scope 有 publish 权限 |
| 首次 npm-v* tag 发布验证 | 验证 release-npm.yml 是否成功发布所有包 |

---

## 6. 关键教训

### 6.1 reviewer 的结论不能盲信

CI 审查的 C2（typebox peerDep）被 reviewer 判为 critical，实际是**误判**——源码 import 的是 `typebox`（v1.3.8 新版），不是 `@sinclair/typebox`（v0.34 经典版）。reviewer 基于错误假设（"裸 typebox 是笔误"）下了结论。

**教训**：审查发现的问题必须读源码验证根因，不能直接采信结论。特别是涉及"这个写法是错的"类判断时。

### 6.2 深度整合 ≠ 文件迁移

`.agents/` 的迁移最能体现这点：
- dev-link **不能迁移**（底层机制完全不同），必须重新设计
- 重名 skill **不能覆盖**（会丢失当前版特化），必须内容级合并
- pr-cr-fix **不能原样迁**（维度数变了、.pi/workflows 不存在），必须改造

每个资产都要问：它在目标项目的语境下，机制是否还成立？语义是否匹配？

### 6.3 bash 陷阱在自动化脚本中高频出现

dev-link 的 3 个 bug 全是 bash 经典陷阱：
1. `set -e` + `((var++))` — 算术表达式值为 0 时返回非零退出码
2. `VAR=val command` 语法 — 环境变量前缀必须在 command 前，不是后
3. `$var` 后紧跟全角字符 — bash 把全角字符当变量名一部分，需 `${var}` 界定

**教训**：bash 脚本写完必须实际跑一遍测试，不能只靠语法检查（`bash -n`）。

### 6.4 "孤立资产"需要激活才有价值

当前项目 6 个 review agent 在迁移前是孤立资产（写了 prompt 但没人调用）。pr-cr-fix 的迁移正好激活了它们——7 维并行 review → aggregator 聚合 → cr-fix 修复 → 推 PR。

**教训**：迁移资产时要看它是否形成完整闭环。孤立的 prompt/配置如果没接入执行链路，等于没有。
