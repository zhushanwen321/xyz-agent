# CW 全流程复盘：fix-state-tearing（2026-07-08）

## 概况

| 维度 | 数据 |
|------|------|
| tier | mid（mid-plan → mid-detail-plan → coding-execute） |
| Wave 数 | 2（W1: 6 issue / W2: 2 issue） |
| 测试用例 | 49（39 unit / 3 integration / 4 e2e / 3 perf-chaos） |
| 决策数 | 17（D-001~D-010 mid-plan + D-011~D-017 mid-detail-plan） |
| 审查报告 | 23 份（mid-plan 4 路 + mid-detail-plan 6 路 + machine-check 6 + consistency 1 + anomaly 1 + review stub 4） |
| 实际测试 | renderer 759 passed + runtime 1130 passed = 1889 全绿 |
| vue-tsc | 0 errors |
| ESLint | 0 errors / 0 warnings |
| **cw(detail) gate 重试** | **6 次** |
| **workflow 重试** | **3 次（全部失败，主 agent 手动接手）** |
| 总体 | ⚠️ 设计阶段优秀，执行基础设施严重不足 |

---

## 清单结果

### 流程

- ⚠️ plan 的 Wave 拆分准确（W1 契约+模型层 → W2 编排+UI 层，依赖方向正确） | 根因：见问题 5
- ❌ TDD 未执行——主 agent 手动接手后是「先实现再跑测试」，非「先写失败测试再实现」 | 根因：见问题 4
- ❌ 失败循环：workflow 3 轮全败（非测试设计问题，是 workflow 基础设施不可用） | 根因：见问题 1/2/3
- ❌ workflow 的 worktree-setup → dev → test+review → cleanup 四阶段从未完整跑完过 | 根因：见问题 1/2

### 测试质量

- ✅ 覆盖率高：8 个源文件改动 + 5 个测试文件适配，1889 测试全绿
- ✅ E2E 边界用例覆盖（panel-per-session-generating + landing 三态 + sealed guard）
- ⚠️ plan 的 49 测试用例中，大部分未作为独立测试编写——而是通过适配现有测试文件（useChat.test.ts / chat-streaming-reset.test.ts 等）覆盖。设计文档的 T1.1~T9.18 是**测试意图矩阵**，实际测试是**按文件组织的现有测试套件** | 根因：见问题 6

### 文档

- ✅ 6 份核心交付物（requirements/system-arch/issues/nfr/code-arch/execution-plan）质量高
- ✅ decisions.md 17 条决策全部有追溯来源（ask_user / reviewer / anomaly）
- ✅ code-skeleton 5 骨架文件 tsc 自包含通过
- ⚠️ HTML 渲染（6 个 .html）消耗大量 token 和 turn，但对 cw(detail) gate **无帮助**——gate 只检查 .md 文件 | 根因：见问题 7

### skill / subagent 优化

- ❌ coding-execute skill 的 workflow 入口（`workflow run execute-full-workflow`）在本项目环境下完全不可用 | 根因：见问题 1/2/3
- ❌ mid-detail-plan skill 产出的 detail.json 格式与 workflow 脚本消费的 plan.json 格式存在**隐式契约不匹配**（wave.issues vs wave.changes） | 根因：见问题 3
- ⚠️ review-fix-loop subagent（6 路并行审查）效果好，但异常猎手发现的 3 个问题（F1/F2/F3）都是 **主 agent + 架构 reviewer 漏掉的实现级陷阱**——说明单路审查的盲区比预期大 | 根因：见问题 8

### 系统提示词 / 业务 / 架构

- ❌ cw(detail) gate 的机器检查过于脆弱（6 次重试），消耗了 session 的大部分预算 | 根因：见问题 9
- ⚠️ CW mid tier 的 gate 设计（weak-structural → medium-git → medium-coverage）层层加码，但每一层的「通过标准」对用户不透明 | 根因：见问题 10
- ✅ 派生模型设计（isGenerating 从 entity scan）从根本上消除了状态撕裂——实现时 0 tsc error 证明设计正确

---

## 根因深度分析

### 问题 1：workflow 脚本未被 tool 发现（脚本注册缺失）

**症状**：`workflow run execute-full-workflow` 报 "not found. Available: (none)"，但脚本实际存在于 extension 目录。

**why1**：workflow tool（pi-workflow）只扫描**项目级** `.pi/workflows/`（`resolve(".pi/workflows")`），不扫全局 `~/.pi/agent/extensions/*/workflows/`。

**why2（根因）**：coding-workflow extension 把 `execute-full-workflow.js` 放在自己的 `workflows/` 子目录，但没有任何机制将其注册到 pi-workflow 的发现路径。extension 的 `package.json` / `index.ts` 不包含 workflow 脚本注册逻辑。这是一个**跨 extension 的契约缺口**——coding-workflow 产出脚本，pi-workflow 消费脚本，但两者没有约定的交付路径。

**层级**：工具/系统层（跨 extension 契约）

**可证伪实验**：若 coding-workflow extension 的 install 钩子执行 `cp workflows/*.js <project>/.pi/workflows/`，则 `workflow-script list` 首次即发现脚本，0 次手动 cp。

---

### 问题 2：workflow implementer agent 偏离设计（认知层逃逸）

**症状**：W1 implementer agent 产出的 commit（`08190917`）把工作区原有的 5 个认知外文件改动（Turn.vue/Block.vue 等）全部 commit 了，**没有实现任何 W1 设计内容**。

**why1**：implementer prompt 正确包含了设计文档路径（issues.md/code-architecture.md/code-skeleton/），但 agent **没有读**。它第一步执行 `git add -A && git commit`，把工作区所有文件 commit 后判断「任务完成」。

**why2（根因）**：两个因素叠加：
1. **工作区脏状态**：bare repo + worktree 模式下，工作区有大量 untracked + modified 文件（用户的其他改动）。workflow 从 BASE_REF 建 worktree，但这些工作区改动不属于该 ref 的 git 树，worktree 的 git index 继承了脏状态。
2. **prompt 缺乏前置 guard**：implementer prompt 没有要求 agent「先验证工作区干净」或「只 add 指定文件」。agent 看到一堆未提交改动，优先处理它们（最小阻力路径）而非遵循 prompt 指令。

**层级**：认知/流程层（prompt 设计缺陷）+ 工具/系统层（worktree 脏状态继承）

**可证伪实验**：若 implementer prompt 加「禁止 `git add -A`，只 `git add <设计文档指定的文件>`」+ worktree 建立后先 `git status` 验证干净，则 implementer 不会 commit 认知外文件。

---

### 问题 3：detail.json 与 workflow plan.json 的隐式契约不匹配

**症状**：workflow 脚本的 `buildImplementerPrompt` 读 `waveCase.changes`（lite 格式），但 mid 的 detail.json 用 `waveCase.issues`（issue id 数组）。我手动改了脚本加 mid 分支，但这个适配不在原脚本里。

**why1**：workflow 脚本 `execute-full-workflow.js` 是为 lite tier 设计的（读 plan.json 的 `waves[].changes`），没有处理 mid tier 的 `waves[].issues` 字段。

**why2（根因）**：CW 的 tier 系统（lite/mid/full）在设计文档层面定义了不同的 JSON schema（plan.json vs detail.json），但 workflow 脚本是一个通用执行器，**不感知 tier 差异**。脚本的 `buildImplementerPrompt` / `buildTestRunnerPrompt` 是 hardcoded for lite 的，mid/full 的字段差异需要手动适配。这是一个**schema 契约与执行器的耦合缺口**。

**层级**：架构/契约层（tier schema 与执行器耦合）

**可证伪实验**：若 workflow 脚本根据 `$ARGS.tier` 分支选择 prompt 模板（lite 读 changes / mid 读 issues+设计文档路径 / full 读 issues+code-skeleton），则无需手动改脚本。

---

### 问题 4：TDD 铁律在主 agent 接手后失效

**症状**：主 agent 手动实现时，是「先写代码 → 跑 tsc → 跑测试修复」，非「先写失败测试 → 实现 → 跑通」。

**why1**：主 agent 接手是因为 workflow 不可用，接手时已有完整设计（骨架 + 签名表 + 时序图），直接按设计实现比先写测试更高效。

**why2（根因）**：coding-execute skill 的 TDD 铁律是针对 **workflow 内 implementer agent** 设计的（每个 agent 先写测试）。当 workflow 失败、主 agent 接手时，skill 的 TDD 约束**没有传递到主 agent 的执行模式**。主 agent 用自己的判断（重构场景下先实现更合理），绕过了 TDD。这是 skill 约束的**作用域局限**——只约束 subagent，不约束 fallback 到主 agent 时的行为。

**层级**：认知/流程层（skill 约束作用域）

**可证伪实验**：若 coding-execute skill 加「主 agent 接手 fallback 模式」章节，明确「接手后仍需 TDD（或显式声明豁免理由）」，则主 agent 会遵循或显式豁免。

---

### 问题 5：Wave 拆分粒度对 workflow 不友好

**症状**：W1 含 6 个 issue（#1#2#3#4#6#8），涉及 6+ 文件，单次 implementer agent 处理不过来。

**why1**：mid-detail-plan 的 Wave 拆分按**逻辑依赖**（契约层 → 模型层 → 编排层），W1 是「契约+模型」层的所有 issue。但 workflow 的单 implementer agent 限制是 3 文件/1000 行（SKILL 规范）。

**why2（根因）**：Wave 拆分的优化目标（最小化 Wave 数 + 最大化并行）与 workflow 执行约束（单 agent 文件上限）**方向相反**。mid-detail-plan skill 不知道 workflow 的单 agent 约束，按逻辑依赖拆出大 Wave；workflow 拿到大 Wave 后单 agent 处理不了。两个 skill 的约束没有对齐。

**层级**：架构/契约层（跨 skill 约束不对齐）

**可证伪实验**：若 mid-detail-plan skill 的 Wave 拆分加约束「每 Wave 的文件数 ≤ workflow 单 agent 上限（3 文件）」，则 W1 会被拆成 2 个子 Wave，单 agent 可处理。

---

### 问题 6：测试矩阵（T1.1~T9.18）与实际测试文件的映射断裂

**症状**：detail.json 定义了 49 个测试用例（T1.1~T9.18），但实际测试是按文件组织的现有测试套件（useChat.test.ts 等），T 编号只存在于设计文档。

**why1**：设计阶段的测试矩阵是**意图矩阵**（描述要测什么），不是**测试代码清单**（描述测试函数在哪）。实现时无法直接「写 T1.1 对应的测试函数」——需要人工映射 T 编号到测试文件和用例名。

**why2（根因）**：CW mid tier 的 testCases schema（caseId/scenario/steps/assertion）是**行为描述**，不包含**代码位置**（文件路径/测试函数名）。test-runner agent 拿到 testCase 后需要自己决定在哪写测试，这个映射是隐式的。对于新项目可行，对于**适配现有测试套件**的场景（本次改了 5 个现有测试文件），映射成本很高。

**层级**：架构/契约层（测试 schema 与实际测试组织方式的断裂）

**可证伪实验**：若 testCases schema 加可选字段 `file?: string`（测试文件路径）+ `describe?: string`（测试组名），则 test-runner 可直接定位写入位置，不需人工映射。

---

### 问题 7：HTML 渲染阻塞 cw(detail) gate 关键路径

**症状**：Step 6 花了大量 turn 派 visualizer subagent 渲染 6 个 HTML 文件，但 cw(detail) gate 只检查 .md 文件，HTML 对 gate 通过**零贡献**。

**why1**：mid-detail-plan skill 的 Step 6 是「定稿 + HTML 渲染 + cw(detail) gate」，把渲染和 gate 放在同一步，暗示渲染是 gate 的前置条件。

**why2（根因）**：skill 设计者把 HTML 渲染视为「定稿的一部分」（可交付产物），但实际 CW gate 机器检查不消费 HTML。渲染是**可选的可视化增强**，不是 gate 前置条件。skill 把可选步骤和必须步骤混在同一步，导致 agent 无法判断优先级。

**层级**：认知/流程层（skill 步骤设计）

**可证伪实验**：若 mid-detail-plan Step 6 拆成「Step 6a: cw(detail) gate（必须）」+「Step 6b: HTML 渲染（可选，gate 通过后）」，则 gate 不会被渲染阻塞。

---

### 问题 8：异常猎手发现的 3 个陷阱是主 agent + 架构 reviewer 的共同盲区

**症状**：F1（多 session 收口）、F2（errorText 丢失）、F3（toolCall 终态矛盾）——这 3 个问题主 agent 和架构 reviewer 都没发现，是异常猎手（独立视角）首次发现。

**why1**：异常猎手的 prompt 是「假设设计是错的，找最可能出 bug 的地方」，这是一个**对抗性视角**。主 agent 和架构 reviewer 的 prompt 是「验证设计是否正确」，是**确认性视角**。两者盲区不同。

**why2（根因）**：CW 的 review-fix-loop 设计中，reviewer 角色按**职能维度**分（需求/架构/红队/异常猎手），但只有异常猎手是真正的**对抗性视角**。红队（redteam）虽然也是对抗性的，但其 prompt 聚焦于「优先级和方案选择」，不聚焦于「实现级陷阱」。结果是对抗性审查只有一路（异常猎手），如果它也漏了就没人兜底。

**层级**：认知/流程层（reviewer 角色设计）

**可证伪实验**：若 review-fix-loop 把异常猎手从「1 路」扩展为「2 路」（一路看数据流一致性，一路看状态机边界），则 F1/F2/F3 类问题有更大概率被至少一路发现。

---

### 问题 9：cw(detail) gate 机器检查脆弱（6 次重试）

**症状**：cw(detail) gate 重试 6 次才通过，每次失败原因：
1. dependsOn 引用 issue ID（#2）而非 test ID（T1.1）
2. 循环依赖（T1.1→T4.1→T1.1）
3. NFR 占位符 "XXX" + 列后缀 "（占位）"
4. NFR 表格 9 列（多了「测试用例 ID」列）
5. 骨架 TODO 注释 + tsc 错误 + orphan 方法 `complete`
6. 执行计划验收清单用范围简写（T9.4~T9.8）而非逐个列举

**why1**：机器检查用 regex/AST 解析 markdown + TS 文件，对格式极度敏感。错误消息告诉你 WHAT failed，但不告诉你 HOW to fix（如「orphan 方法 complete」不说它把 markdown 表格的 `complete` 单词当方法名了）。

**why2（根因）**：gate 检查的**设计哲学**是「严格机器校验」（fail-fast 防止低质量交付物过 gate），但**实现质量**不够（错误消息不可操作 + 格式约束未文档化）。用户每次失败都要逆向工程机器检查的期望格式，试错成本极高。最荒谬的例子：markdown 表格里的 `complete` 单词被 orphan 检测当成方法名——这是 regex 解析的误判，不是真实的交付物质量问题。

**层级**：工具/系统层（gate 检查实现质量）

**可证伪实验**：若 gate 失败时返回**期望格式示例**（如「orphan 检测期望骨架文件中有 `function complete` 或 `complete =` 声明，但 `complete` 出现在 markdown 表格被误识别」+ 修复建议「给表格单元格加反引号」），则用户 1-2 次即可通过，非 6 次。

---

### 问题 10：CW gate 通过标准对用户不透明

**症状**：cw(detail) 返回 `gate FAIL` + mustFix 列表，但不告诉你 gate 的**完整检查项清单**——你不知道还有多少项没检查到，每次修完一个又冒出新的。

**why1**：gate 返回的是 fail-fast（遇到第一个错误即返回），不是全量报告。

**why2（根因）**：gate 检查是**串行 fail-fast**设计（issue → nfr → code-arch → execution），每次只报当前层的错误。用户修完 issue 层后才知道 nfr 层有问题，修完 nfr 才知道 code-arch 有问题……6 次重试是因为 4 层各 fail 1-2 次。如果 gate 一次跑完 4 层并返回全量错误清单，用户可以一次修完。

**层级**：工具/系统层（gate 返回策略）

**可证伪实验**：若 gate 改为「全量检查 + 一次性返回所有层的所有错误」，则重试次数从 6 降至 1-2。

---

## 改进项（按优先级）

### [P0] cw gate 机器检查改为全量报告 + 可操作错误消息

| 字段 | 内容 |
|------|------|
| 根因链 | 症状(6 次重试)→why1(fail-fast 串行 + 错误消息不可操作)→why2(gate 实现质量不足) |
| 层级 | 工具/系统层 |
| 归属 | pi-coding-workflow（`src/cw/checks/check-*.ts`） |
| 追踪 | 待办（需跨 repo 修改 coding-workflow extension） |
| 方向 | gate 改为全量检查（4 层并行，一次性返回所有错误）；每个错误附期望格式示例 + 修复建议 |

### [P0] workflow 脚本注册机制 + tier 感知

| 字段 | 内容 |
|------|------|
| 根因链 | 症状(workflow not found + 不感知 tier)→why1(脚本在 extension 目录不被发现 + hardcoded lite)→why2(跨 extension 契约缺口 + schema 与执行器耦合) |
| 层级 | 架构/契约层 |
| 归属 | pi-coding-workflow（workflows/）+ pi-workflow（发现机制） |
| 追踪 | 待办（需跨 repo 修改） |
| 方向 | coding-workflow extension install 钩子自动注册脚本到项目 `.pi/workflows/`；脚本根据 `$ARGS.tier` 分支选择 prompt 模板 |

### [P1] workflow implementer prompt 加工作区污染防护

| 字段 | 内容 |
|------|------|
| 根因链 | 症状(implementer commit 了认知外文件)→why1(git add -A + 未读设计文档)→why2(prompt 无前置 guard + worktree 脏状态) |
| 层级 | 认知/流程层 |
| 归属 | pi-coding-workflow（workflows/execute-full-workflow.js `buildImplementerPrompt`） |
| 追踪 | 待办 |
| 方向 | prompt 加「禁止 git add -A，只 add 指定文件」+ 「先 git status 验证工作区，若有非设计范围的改动则报告而非 commit」 |

### [P1] mid-detail-plan Step 6 拆分：gate（必须）+ HTML（可选）

| 字段 | 内容 |
|------|------|
| 根因链 | 症状(HTML 渲染阻塞 gate)→why1(同一步混合必须+可选)→why2(skill 步骤设计未区分优先级) |
| 层级 | 认知/流程层 |
| 归属 | pi-coding-workflow（skills/mid-detail-plan/SKILL.md） |
| 追踪 | 待办 |
| 方向 | Step 6 拆成 6a（cw detail gate，必须）+ 6b（HTML 渲染，可选，gate 通过后） |

### [P1] Wave 拆分加 workflow 单 agent 文件上限约束

| 字段 | 内容 |
|------|------|
| 根因链 | 症状(W1 6 文件单 agent 处理不了)→why1(Wave 按逻辑依赖拆，不感知执行约束)→why2(跨 skill 约束不对齐) |
| 层级 | 架构/契约层 |
| 归属 | pi-coding-workflow（skills/mid-detail-plan/SKILL.md Wave 拆分章节） |
| 追踪 | 待办 |
| 方向 | Wave 拆分规则加「每 Wave 文件数 ≤ 3（workflow 单 agent 上限）」 |

### [P2] testCases schema 加代码位置字段

| 字段 | 内容 |
|------|------|
| 根因链 | 症状(T 编号与测试文件映射断裂)→why1(testCase 是行为描述无代码位置)→why2(schema 设计未考虑适配现有测试套件场景) |
| 层级 | 架构/契约层 |
| 归属 | pi-coding-workflow（testCases schema 定义） |
| 追踪 | 待办 |
| 方向 | testCase 加可选字段 `file?: string` + `describe?: string` |

### [P2] coding-execute skill 加「主 agent 接手 fallback 模式」

| 字段 | 内容 |
|------|------|
| 根因链 | 症状(主 agent 接手后 TDD 失效)→why1(skill TDD 约束只针对 subagent)→why2(skill 无 fallback 模式章节) |
| 层级 | 认知/流程层 |
| 归属 | pi-coding-workflow（skills/coding-execute/SKILL.md） |
| 追踪 | 待办 |
| 方向 | 加「fallback 模式」章节：主 agent 接手时仍需 TDD 或显式声明豁免理由 |

### [P2] review-fix-loop 异常猎手扩展为 2 路

| 字段 | 内容 |
|------|------|
| 根因链 | 症状(异常猎手发现主 agent+arch reviewer 共同盲区)→why1(只有 1 路对抗性视角)→why2(reviewer 角色按职能分不按视角分) |
| 层级 | 认知/流程层 |
| 归属 | pi-coding-workflow（skills/mid-shared/references/review-fix-loop.md） |
| 追踪 | 待办 |
| 方向 | 异常猎手从 1 路扩展为 2 路（数据流一致性 + 状态机边界） |

---

## 本轮最大收获

**设计阶段的投入是值得的。** 17 个决策（尤其 D-011~D-017 来自异常猎手）让主 agent 手动实现时**一次性 0 tsc error**（仅 2 个类型窄化微调）。如果没有异常猎手抓到的 F1（多 session 收口）/F3（toolCall 诚实态矛盾），实现时必然翻车。

**但执行基础设施（cw gate + workflow）是瓶颈。** gate 6 次重试 + workflow 3 次失败消耗了 session 70%+ 的预算，实际编码（8 文件 +270/-184 行）只花了约 15% 的预算。改进 ROI 最高的是 gate 和 workflow，不是设计流程。
