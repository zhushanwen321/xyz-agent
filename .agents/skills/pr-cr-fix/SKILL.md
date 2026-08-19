---
name: pr-cr-fix
description: >-
  PR 完整生命周期 skill：开 PR → 多维 review → 修 must-fix → pre-merge → 推 PR。
  触发词："review and open PR"、"review 完开 PR"、"把 review 问题修了开 PR"、
  "pr-cr-fix"、"review → PR"、"提交 PR"、"创建 PR"、"push"、"提交代码"、
  "push 前检查"、"pre-push"、"review"、"审查代码"、"code review"、"帮我看看代码"。
  不用于 仅提交/推送不建 PR 的纯 git 操作（直接 git commit + git push）、
  或 push 失败排查/CI 故障诊断。
---

# PR 完整生命周期 Skill

开 PR → 多维 review → 修 must-fix → pre-merge → 推 PR。本 skill 是 PR 工作流的唯一入口，内化了原 pull-request / code-review / pre-push-checks / trim-cot-leakage 四个 skill 的能力。

## 前置条件 [MANDATORY]

- xyz-agent git worktree 中
- 当前分支相对 main 有 commits（`git log main..HEAD` 非空）
- 有 GitHub CLI（`gh`）认证

## 调用约定

- `cwd`：git 根目录绝对路径（`git rev-parse --show-toplevel`）
- 阶段 1 / 3a 派 subagent 执行；阶段 2 由主 agent 直接派 workflow（不经 subagent 封装）
- 主 agent 全程只做编排 + Gate 校验 + push 前用户授权确认

---

## 阶段 1：开 PR

### 1.1 Pre-merge 硬 gate

在当前 feature worktree 内执行（不是 main worktree），验证待 PR 的代码。

```text
agent: "general-purpose"
cwd:   <git 根>
task:  "跑 bash scripts/pr-pre-merge.sh --quiet
        （按序 typecheck → lint → test：extensions + runtime + renderer；全绿写 .review/premerge-result marker result=PASS；任意 FAIL 写 result=FAIL 非零退出）。
        禁止 --no-verify / SKIP_LINT=1 / SKIP_EXTENSION_LINT=1。
        完成后返回 JSON { result: 'PASS'|'FAIL', failed_step?, changeset_missing? }"
```

**Gate-1a**（硬 gate）：`result === 'PASS'` 才继续。FAIL 按 `failed_step` 对应工种重派 worker 修复后重跑。build 默认跳过（`PR_PRE_MERGE_SKIP_BUILD=1`），全量打包由 CI 跑。

**Gate-1a.5**（changeset 软提醒）：`changeset_missing` 非空（改了 `extensions/*/src/` 但无 changeset，WARN 不 FAIL）→ AskUserQuestion：需要发布则 `pnpm changeset` 创建声明（推荐）；纯文档/测试改动可跳过（建议 `pnpm changeset add --empty` 防 merge 误报）。缺失 changeset 的后果：merge 时 `changeset version` 不 bump → publish 不发 → bug fix 静默丢失。

### 1.2 自动生成 PR title 和 body

**[MANDATORY] 从分支所有 commit 自动生成，英文，无需用户提供。**

1. 收集分支所有 commit：`git log main..HEAD --format="%s%n%b---"` + `git diff main..HEAD --stat`
2. 生成 PR title：conventional commit 风格（`fix(scope): short summary`；多 scope 取最核心的，或省略 scope）
3. 生成 PR body：`## Summary`（改动目的）+ `## Changes`（逐条列各 commit 关键改动，合并相关条目；有 `.changeset/*.md` 一并展示）+ `## Test plan`（typecheck/test/lint 结果）。breaking changes 必须标明

### 1.3 Push 并创建 PR

**bare repo workspace 注意**：`origin` 指向本地 bare repo，GitHub 的 remote 叫 `github`。

```bash
# 方式 A：用 pr-submit.sh（自动检测 PR 是否已存在、仅内容变化时更新）
bash scripts/pr-submit.sh --title "$PR_TITLE" --body "$PR_BODY" --base main

# 方式 B：直接 gh 命令
git push github HEAD
gh pr create --repo zhushanwen321/xyz-agent \
  --head "zhushanwen321:$(git branch --show-current)" \
  --title "$PR_TITLE" --body "$PR_BODY"
```

**Gate-1**：`pr_url` 匹配 `^https://github\.com/.+/pull/\d+$`。`force_push=true` 时，阶段 3b 推 PR 加 `--force-with-lease`。

### 1.4 [OPTIONAL] YAML / extension 规范校验

修改了 `.agents/skills/` 或 `extensions/*/package.json` 时，PR 创建前运行本 skill 内置校验脚本：

```bash
# 校验 skill SKILL.md 的 frontmatter（name/description 必填，description 双引号包裹或块标量）
python3 .agents/skills/pr-cr-fix/scripts/validate-skill-yaml.py <skill-paths>

# 校验 extension package.json 的 pi 字段（pi.extensions/keywords/type）
python3 .agents/skills/pr-cr-fix/scripts/validate-extensions-yaml.py <extension-dirs>
```

---

## 阶段 2：review + fix

### [MANDATORY] 双路径选择

#### 路径 1：pi 环境（有 pi workflow 能力）

**适用条件**：当前主 agent 是 pi agent，且能调用内置 workflow（`pi workflow list` 中名为 `review-fix-loop`、无 `.js` 路径后缀的条目即内置版；解析顺序：内置 → npm 包 → 项目 `.pi/workflows/`）。

主 agent 直接用 workflow 工具跑内置 `review-fix-loop`（8 维并行 review → 聚合 → fix → 重审直到 clean/converged/stuck）：

> **[MANDATORY] 主 agent 直接派，禁止 subagent 封装**：workflow 工具 `action:"run"` 是异步后台运行 + notifyDone 自动注入结果，主 agent 直接拿 `terminated/rounds/aggregated_file`。workflow 自己会派 review agent + fix agent，subagent 封装只是多一层中转，白耗 context。

```bash
# ⚠️ batch1 必须传 **.md 绝对路径**（/ 或 ~/ 开头），禁止相对路径/裸名：
#   resolveAgentDefs 要求每项 ^/ 或 ^~/ 开头 + .md 结尾，否则抛「无效 agent 引用」
# targetType=git-diff + target=main：审查 git diff main...HEAD（base 启动时锁 hash 防 ref 漂移），含未提交工作区改动
# autoCommit=true：fix 后自动 commit；skipCleanAgents=true：单轮 clean 的 agent 下轮跳过
# recheckAfterFix 默认 false（省 token）；担心 fix 引入回归时传 true 开强回归重审
pi workflow run review-fix-loop --args '{
  targetType: "git-diff",
  target: "main",
  batch1: "<repo>/.agents/skills/pr-cr-fix/agents/review-arch-boundary.md,<repo>/.agents/skills/pr-cr-fix/agents/review-business-logic.md,<repo>/.agents/skills/pr-cr-fix/agents/review-extension-api.md,<repo>/.agents/skills/pr-cr-fix/agents/review-monorepo-impact.md,<repo>/.agents/skills/pr-cr-fix/agents/review-type-safety.md,<repo>/.agents/skills/pr-cr-fix/agents/review-electron-build.md,<repo>/.agents/skills/pr-cr-fix/agents/review-test-coverage.md,<repo>/.agents/skills/pr-cr-fix/agents/review-data-governance.md",
  maxRounds: 10,
  autoCommit: true,
  recheckAfterFix: false,
  skipCleanAgents: true
}'
```

内置行为要点：某 agent `must_fix === 0` 判 clean；连续 3 轮 must_fix 不降 → `terminated=stuck`；问题经 2 次修复未收敛 → `terminated=needs-redesign`；聚合器内置（合并去重为 `aggregated.md` + must_fix 计数，不依赖 `review-aggregator.md`）。

**Gate-2**：workflow `terminated` ∈ {`clean`, `converged`, `stuck`} → 进阶段 3。`terminated=needs-redesign` = 结构性问题需人工介入，**停手上报用户**。

#### 路径 2：非 pi 环境（手工编排，固定 2 轮）

**适用条件**：无 pi workflow 能力（ZCode / 其他 agent 框架）。这是最常见路径。

##### 第 1 轮

**Step 1 — 确认变更范围**（主 agent 自己跑）：
```bash
git diff main...HEAD --stat
```

**Step 2 — 并行派 reviewer subagent**：8 个维度按「维度 → Agent 映射」表全派。**并行上限 ≤5**（全局 AGENTS.md subagent 约束）：分两批派发（batch1: arch-boundary / business-logic / type-safety / electron-build / test-coverage，batch2: extension-api / monorepo-impact / data-governance），或按全局规则「一般用 3 个」分三批。每个 subagent 的 task 必须包含：

- worktree cwd（绝对路径，避免 multi-worktree cwd 陷阱）
- focus（见下方「维度 → Agent 映射」表对应审查焦点）
- agent 定义文件路径（`<repo>/.agents/skills/pr-cr-fix/agents/review-<维度>.md`，subagent 须复读原文获得完整 checklist）
- `output 路径：<绝对路径>` + `Write report to: <绝对路径>`（双措辞兼容 agent 约定）
- 「审查 `git diff main...HEAD` 的全部变更」
- 「输出格式：YAML frontmatter（verdict/must_fix）+ Findings 表格（优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向），优先级用 MUST_FIX/SUGGESTION/INFO」
- 「完成后用 structured-output 返回 `{report_file, must_fix, suggestion}`」

**Step 3 — 主 agent 手工聚合**：
- 收集各 subagent 的结构化结果
- 按 (file, line, description) 三元组去重
- 按优先级排序（MUST_FIX → SUGGESTION → INFO）
- 写 `aggregated.md`（含 `## Summary` + `- Must-fix: N` + `- Suggestions: N` 行，便于核对）

**Step 4 — 修复 MUST_FIX**（条件触发，`must_fix > 0` 时）：
- 按文件归属分组，每组派 1 个 `worker` subagent 并行修复（≤5）
- worker task 含：review 报告原文路径（worker 必须复读）+ 本组问题清单 + 「全部修复，不挑 level」+ 「修复后 `pnpm -r typecheck` 通过」
- 修复后 commit：`fix: review round 1 — N must-fix`

##### 第 2 轮（强制）

**不管第 1 轮是否 clean，第 2 轮都必须跑**——验证修复未引入回归。重复第 1 轮的 Step 2-4。第 2 轮结束即终止；残留 MUST_FIX 报告给用户决策。

> 为什么固定 2 轮：第 1 轮发现问题，第 2 轮验证修复，是回归防护的最小完整单元。更多轮需要自动化编排支撑（即路径 1 的 workflow），手工派发边际收益递减。

### 维度 → Agent 映射（两路径共用）

Agent 定义位于本 skill 目录 `agents/review-<维度>.md`（不全局暴露，仅本 skill 内部引用）。

| 维度 | Agent 实体 | 审查焦点 |
|------|-----------|---------|
| 架构边界 | `agents/review-arch-boundary.md` | Electron 分层（main/preload/renderer/shared）、runtime 三层（transport/services/infra）、WS session 隔离、IPC/emit 规范、数据目录隔离、路径白名单动态化、ENV SSOT、Extension vs Plugin 边界、v3 视图拓扑 |
| 业务逻辑 | `agents/review-business-logic.md` | 逻辑正确性、边界条件、异常路径、回归风险、错误状态重置（isGenerating/streamingMessage）、emit 单 payload、Promise.allSettled、streaming 生命周期、session 双状态、文件持久化与 Store 同步 |
| 类型安全 | `agents/review-type-safety.md` | 完整类型标注、禁止 any（显式/隐式）、类型守卫、tsc/vue-tsc、Pi* 类型分层约束（仅 infra 层可见） |
| Electron 打包 | `agents/review-electron-build.md` | tsup 配置（noExternal/Worker entry/CJS 兼容）、electron-builder（files/asarUnpack/symlink）、子进程启动、打包验证三阶段 |
| 测试覆盖 | `agents/review-test-coverage.md` | 新增逻辑有测试、边缘情况覆盖、vitest 合规（禁 node:test）、领域测试点（session 双状态/Extension vs Plugin/ports 接口） |
| 扩展接口 | `agents/review-extension-api.md` | Pi 扩展 tool/command schema 完整性、向后兼容性、扩展规范合规（docs/extensions/extension-conventions.md + development-guide.md） |
| Monorepo 影响 | `agents/review-monorepo-impact.md` | workspace 包间依赖（packages/* + apps/* + extensions/* + extensions/shared/*）、循环依赖、公共 API 变更对下游影响 |
| 数据治理 | `agents/review-data-governance.md` | pi 文件直写（绝对写规则）、第二写入者、事件直写状态、renderer 零派生、未登记缓存、扩展数据通道（appendEntry/get_entries）、登记表同步。准绳：docs/architecture/data-source-governance.md + data-source-registry.md |

### 严重度分级

- **MUST_FIX** — 必须修复，阻塞合并。对应架构约束违规、会导致 bug、违反 [HISTORICAL] 规则的问题
- **SUGGESTION** — 强烈建议修复。不阻塞但影响代码质量、可维护性
- **INFO** — 可选改进。代码风格、文档、轻微品味问题

每条条目格式：`[SEVERITY] file:line — 问题描述` + `→ 建议修复方式`

### [OPTIONAL] 降级 checklist（无 subagent 能力时主 agent 自查）

改动极小或不值得编排时，主 agent 按以下 checklist 自行审查。覆盖深度不如双路径编排。

**1. Vue 3 组件规范**
- [ ] Composition API + `<script setup>`（禁止 Options API）
- [ ] 模板中禁止直接调用方法做副作用，用 `computed` / `watch` 替代
- [ ] props 用 `defineProps<T>()`，不用无类型版
- [ ] 无内联 styles，用 scoped CSS（仅 Transition/伪元素等 escape hatch）或 Tailwind 类
- [ ] `<template>` ≤ 400 行，`<script setup>` ≤ 300 行

**2. TypeScript 类型安全**
- [ ] 禁止 `any`，用 `unknown` 或具体类型
- [ ] 事件回调参数有明确类型注解
- [ ] 接口定义完整，不在运行时拼凑类型

**3. Event Bus 防重复注册**
- [ ] listener 注册使用 refCount 保护（`addEventListener` / `on` 配对）
- [ ] 组件 unmount 时清理所有 listener；无遗漏的 `removeEventListener` / `off`

**4. Emit 规范**
- [ ] `emit` 只传单个 payload 对象：`emit('update', { id, value })`
- [ ] 禁止 `emit('event', arg1, arg2)` 多参数模式
- [ ] payload 类型用 interface 定义

**5. UI 状态错误重置**
- [ ] 错误路径必须重置 `isGenerating` / `streamingMessage` 等加载状态
- [ ] `finally` 块或显式 error handler 中清理状态；无可能的无限加载态

**6. 代码质量**
- [ ] 无死代码（unused imports / variables）、无 console.log 残留
- [ ] 无硬编码 magic numbers / strings
- [ ] 可先跑 fallow 静态分析取基线：`fallow scan $(git diff main...HEAD --name-only)`，关注复杂度热点（函数 > 80 行 / 圈复杂度 > 15）、重复代码、未使用导出、循环依赖

**7. Electron IPC 安全**
- [ ] 通过 preload 桥接，渲染进程不直接 `require('electron')`
- [ ] contextBridge 暴露的 API 最小化；无 IPC 通道暴露敏感操作

**8. 测试覆盖**
- [ ] 新增功能有对应测试；关键路径有边界条件测试
- [ ] 测试描述清晰，不依赖顺序执行

### [OPTIONAL] 文档/prompt 质量审查（CoT Leakage）

审查范围：`.agents/skills/`、`.agents/agents/`、AGENTS.md、`docs/`、`.cw/` 中的 prompt 文本（排除 node_modules/构建产物/记录的模型输出与 fixture）。

**唯一测试**：对每段可疑文字问——**一个只读 HEAD、没有任何会话记录/PR 线程/未提交草稿的读者，能否解析每个引用、验证每个断言？** 不能 → 从仓库视角重述幸存事实，删其余。

**八类 taxonomy**（命中后按处理指导修复）：
1. **死设计会话引用** — `(decision 7)`、`(audit C2)`、`设计 §4.7`、阶段标签（T4、W3、P-I）。决定有已提交的主人时按名字和路径引用，否则删引用、事实条款重述到能独立成立
2. **stack/PR 视角** — 「这个 PR 加了」「本分支之后」「上一个 commit」。改为陈述已落地的机制；推迟的工作移到 TODO 或 issue
3. **改动叙述与版本戳** — 「以前」「不再」「旧的 X」、索引性戳（v1、本版、这次 cut）。陈述当前行为；已修复的回归写成现在时反事实（「没有 X 时会发生 Y」）
4. **review 编排** — 「评审时被否」「reviewer 确认了」。保留幸存的决定与理由作为事实，删掉谁在何时说了什么
5. **面向 reviewer 的自辩** — 「这个转换是安全的——它只是…」。陈述使代码安全的不变量；代码本身可见时删注释
6. **复述与推导记录** — 控制流叙述（「先 X 再 Y」）、显然分支的证明。删；只留不显然的契约或不变量
7. **模糊与规划残留** — 「暂时应该没问题」「应该够了」。升级为 TODO/FIXME，或重述为实际边界
8. **创作语言残留** — 中文正文里的英文草稿片段（或反向），「---- 私有 ----」分隔线。翻译或删除

**什么不是 leakage（保留，禁止误删）**：issue 引用（`#1470`、`TODO(name):`）；抑制理由（`eslint-disable -- reason`、空 catch 解释）；反事实现在时回归钉（「没有 X 时会发生 Y」）；实测边界（「实测：512 层嵌套 ≈ 0.15s」的「实测」承重）；运行时新旧状态（「旧连接排空后新连接才接受」）；外部引用（RFC 章节号）；设计文档的备选方案章节。

**过度修剪陷阱**（删任何东西前枚举该句所有命题，逐条对照）：
1. **义务翻转成背书** — 「待迁移到 slots」删成「受认可的例外」，把义务变成祝福现状；删法不能改变句子的情态
2. **假想提升为已发布功能** — 删掉「未来的」变成声称已发布；明确标记假想，不是只去掉未来标记
3. **连叙述带真事实一起删** — 半句叙述半句承重耦合时，删子句不删整句
4. **保留数字丢了出处** — 「4 MiB 上限是实测的」删成「上限 4 MiB」，数字从观察变成定义

### Pi Extension 接口契约 Checklist

审查 `extensions/` 目录下的 pi extension 代码时 `[MANDATORY]` 逐条核对。

**1. SDK 接口契约核对**
- [ ] `pi.on(...)` handler 对照真实 SDK 的 `ExtensionHandler<E> = (event: E, ctx: ExtensionContext)` **两个参数**签名——`modelRegistry`/`cwd`/`ui`/`sessionManager` 在第二个参数 `ctx` 上，不在 event 上
- [ ] 打开 `node_modules/@earendil-works/pi-coding-agent/dist/` 对照真实类型，不凭记忆写签名
- [ ] xyz-agent 以 `--mode rpc` 运行 pi（`ctx.mode === "rpc"`），TUI API（`ctx.ui.setWidget` 等）失效；GUI 渲染参阅 `docs/extensions/gui-protocol-guide.md`

**2. spec 偏差记录**
- [ ] 无 spec 的功能不应直接实现；实现与 spec 有偏差必须在 spec 末尾「实现偏差说明」补 D 编号记录——未记录的偏差等于违反 spec

**3. schema / 描述一致性**
- [ ] `registerTool` 的 `parameters` schema 必填字段在所有执行模式下都真的必填；被忽略的参数不应 schema 层必填（否则 LLM 被迫传占位值）
- [ ] 条件必填场景：schema 设 Optional，`execute()` 内按模式做运行时校验（抛清晰错误）
- [ ] `description` 中 "Ignores X/Y/Z" 描述与 schema 实际行为一致

**4. 类型断言（配合 taste/no-unsafe-cast）**
- [ ] 每处 warn 的断言确认有不可替代的理由（跨 tsconfig 泛型冲突、SDK 类型 stub 缺失）
- [ ] 不可替代的断言必须有配套运行时 guard（参数判空抛错）或契约测试兜底——类型断言不能是唯一防线

---

## 阶段 3：pre-merge + push

### 3a — pre-merge 验证

```text
agent: "general-purpose"
cwd:   <git 根>
task:  "跑 bash scripts/pr-pre-merge.sh --quiet
        禁止 --no-verify / SKIP_LINT=1 / SKIP_EXTENSION_LINT=1。
        完成后返回 JSON { result: 'PASS'|'FAIL', failed_step?, changeset_missing? }"
```

**Gate-3a**（硬 gate）：`result === 'PASS'` 才继续。FAIL 按 `failed_step` 对应工种重派 worker 修复后重跑。

### 3b — push（需用户授权）

**[MANDATORY] push 前必须获得用户明确授权。** pre-merge 通过后，告知用户结果，等待用户确认后再 push。

```bash
git push github HEAD:<branch>
# force_push=true 时
git push github HEAD:<branch> --force-with-lease
```

PR 已在阶段 1 开好，同分支 push 即自动更新 PR。push 后验证远端 ref 等于本地 HEAD（`git rev-parse HEAD github/<branch>`），可选跑 `scripts/pr-status.sh` 确认 PR 健康，已有 PR 时 `gh pr checks` 看 CI。

push 了发布 tag（`v*`/`npm-*`）时必须等 CI 构建完成并验证产物存在，不能 push 后直接宣布完成（见根 AGENTS.md「发布与 CI 验证」）。

### 按包路径选择测试范围（日常 push 场景）

当用户只需要 push 到已有 PR 分支（不走完整 PR 流程），按 `git diff` 定位改动包，只跑相关证据，拒绝反射性跑全量套件（CI 拥有穷尽覆盖；本地是「我的改动是否把对应包弄挂了」的最小证据）：

- **packages/<pkg>/** → 进该 workspace 跑 `npx vitest run`（可 `-t <name>` 聚焦）+ 改动文件的 eslint
- **extensions/** → `pnpm run extensions:typecheck && pnpm run extensions:lint && pnpm run extensions:test`
- **apps/electron/** → `pnpm run build` + 改动文件的 eslint
- **docs/、.agents/、*.md** → 文档检查（`git diff --check` + 通读 + SSOT 一致性核对）
- **共享包**（packages/shared 等）→ 该包测试 + 依赖它的包测试；共享契约改动才加相邻包
- **跨包横跨全仓** → 全量本地预演的正当理由

同一 diff 刚跑过的检查不重复跑。push 前相关检查失败：停下修复或说明，不要 push 后指望 CI 兜底。仅当用户明确要求、诊断 CI 失败、或改动横跨全仓时才跑完整本地预演（`pnpm run lint` + 各 workspace vitest + `pnpm run extensions:test` + `pnpm run build`）。

### Gate-3 双层判定

| 层 | 判定 |
|----|------|
| 硬 gate | `pr_exists && local_ahead_of_origin == 0 && premerge.result == "PASS"` |
| 软 gate | 阶段 2 `terminated` 非 `needs-redesign` + 阶段 3a PASS |

---

## 关键约束 [MANDATORY]

1. **阶段顺序不可调换**：1 (PR) → 2 (review+fix) → 3 (pre-merge + push)
2. **主 agent 不跑 review/fix 实现命令**：review 委托 workflow（路径 1）或 subagent（路径 2）。PR 生命周期操作（commit / push / pr-status.sh / pr-pre-merge.sh）主 agent 可直接跑
3. **push 必须用户授权**：任何 push 操作前必须告知用户结果并获得确认
4. **force-push 决策传递**：阶段 1 `force_push=true` → 阶段 3b 必须用 `--force-with-lease`；裸 `--force` 禁止
5. **禁止 skip 开关**：`SKIP_LINT=1` / `SKIP_EXTENSION_LINT=1` / `--no-verify` / `eslint-disable` 静默。检查不通过 = 流程中止，唯一出路是修复代码让检查通过
6. **pr-pre-merge.sh 是 stage marker 唯一写入方**：阶段 3a 必须调它，不能直接跑 `npx vitest run` 替代（marker 不写则 Gate-3 恒 not_run）

## 反模式

| 反模式 | 后果 |
|--------|------|
| 主 agent 自己跑 review 代码 | 越权，review 应委托 |
| pi 环境下阶段 2 手写 review subagent 并行/分批（绕过 workflow） | 复现 review-fix-loop 已有能力，漂移风险 |
| 阶段 2 派 subagent 封装 workflow | 多一层无增益中转 |
| 阶段 3a 直接跑 vitest 替代 pr-pre-merge.sh | marker 不写 |
| 未获用户授权就 push | 违反 push 授权约束 |
| 删/改 pr-cr-fix/agents/ 下的 review agent | 破坏 review 维度完整性 |

## 失败恢复

| 失败 | 动作 |
|------|------|
| Gate-1 拿不到 URL | 重试阶段 1；gh 认证问题先 `gh auth login` |
| Gate-2 `terminated=needs-redesign` | 结构性问题，上报用户决策（不自动重试） |
| Gate-2 `terminated=stuck` | 看 aggregated.md 判断是 reviewer 误报还是真问题；误报可人工 ack 后进阶段 3，真问题上报用户 |
| Gate-3a pre-merge FAIL | 按 `failed_step` 重派 worker 修复后重跑 |
| 阶段 3b push 冲突 | `git fetch && git rebase` 后重试；重写历史后重审未解决的 review 线程 |

## 本 skill 目录结构

```
.agents/skills/pr-cr-fix/
├── SKILL.md              # 本文件
├── agents/               # review agent 定义（不全局暴露，仅本 skill 内部引用）
│   ├── review-arch-boundary.md
│   ├── review-business-logic.md
│   ├── review-type-safety.md
│   ├── review-electron-build.md
│   ├── review-test-coverage.md
│   ├── review-extension-api.md
│   ├── review-monorepo-impact.md
│   ├── review-data-governance.md
│   └── review-aggregator.md
└── scripts/              # 校验脚本
    ├── validate-skill-yaml.py
    └── validate-extensions-yaml.py
```

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤 | 可根据实际情况决定 |
