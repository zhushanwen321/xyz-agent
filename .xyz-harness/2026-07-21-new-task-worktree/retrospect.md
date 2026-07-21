# Retrospect · new-task-worktree

## 任务概览

在 .bare 模式 workspace 下支持从新建任务流程创建 worktree：DirSelectPopover 新增「新建 worktree」动作项，CreateWorktreeModal 五态（form/progress/success/error/exists），创建完立即生效切换 chip，submitFirstMessage 零改动。

- **3 Wave**：W1 runtime 后端（WorktreeService + RPC）/ W2 renderer 前端（Modal + popover 动作项）/ W3 集成测试
- **35 testCase**：13 runtime（WS/WD/SR）+ 16 modal（CM）+ 4 popover（DP）+ 3 E2E（INT）+ 2 真实 flow（RF）+ 3 useConnection 可见性 = 实际 50+ it 块映射到 35 testCase
- **gateFailCount=10 / testRetryCount=2 / firstTryPassRate=0.55**

## 做得好的

### 1. 设计先行，HTML demo 迭代确认后才进 CW 流程
用 impeccable critique + HTML demo（draft-worktree.html）和用户迭代了 4 轮设计（入口位置 / 执行模型 / base 默认值 / setup 脚本契约），方案完全对齐后才 `cw create`。这避免了「实现到一半发现方案要改」的返工。spec_review 阶段用禁读重建发现 5 个 spec 缺口（SR1-SR5），在 plan 前全部补齐。

### 2. submitFirstMessage 零改动——架构决策的红利
把 worktree 创建放在「选目录」层而非 composer 内第三 chip，是整个设计最关键的决策。这让 worktree 创建成为独立前置步骤，pendingCwd 创建完已是新路径，后续 session.create + chat.send 走现有逻辑零侵入。review 阶段证实：submitFirstMessage 文件 diff 为空（AC-9 达成）。

### 3. review 抓到 2 个 critical 生产 bug
reviewer 用禁读重建 + 架构追踪发现两个「测试全绿但生产不可用」的 bug（R1 isBareWorkspace 数据源断裂 / R2 错误 details 透传断裂）。这两个都是 W2 worker 写的 mock 过度导致的「构建者视角绿、使用者视角坏」——和 AGENTS.md 记录的「新建任务」事故同构。如果没做 review 直接 merge，整个功能在生产环境入口都不显示。

### 4. 主 Agent 派发 + worker 执行的工作流有效
W1 runtime 后端（worker 超时，主 agent 接手写 worktree-service.ts + handler + 注入链）/ W2 renderer（worker 完整完成 26 测试）/ review（reviewer subagent）/ review_fix（worker 修 R1-R7）。每个 worker 有明确契约（测试文件 + 文件清单 + testid），主 agent 负责编排和对齐。

## 做得不好的

### 1. gateFailCount=10——cw CLI 格式摸索成本高 [重点反思]
10 次 gate fail 几乎全是 cw CLI 的格式问题，不是代码质量问题：
- plan：`format: "lite"` 必填、`changes`（非 tasks）、modify 的文件必须已存在（server.ts 路径错）
- tdd_plan：testCase 需要 `expected.type`（exact/exit_zero/script）、`scenario`/`steps`/`executor`/`requiresScreenshot` 完整字段、需要 real 层 testCase、testRunner.mode 不能是 custom（要 nodejs）
- review：severity 是 must-fix/should-fix/nit（非 critical/major/minor）、dimension 必须在 taskShape 声明的 6 个子集内（非任意值）
- review_fix：commitHash 在每个 fix 对象里（非命令行参数）、字段是 resolution（非 fixSummary）
- test：actual.text 必须**精确等于** expected.text（exact 模式严格匹配）

这些格式约束分散在 guidance 和 schema 里，没有集中的「格式速查」。**改进**：应该把 cw CLI 的各阶段格式约束沉淀成一个速查 skill 或 AGENTS.md 章节，避免每次都靠 fail-and-fix 学习。

### 2. testRetryCount=2——test.json 的 expected.text 设计有问题
test 阶段 fail 两次：第一次传 actual.text="pass"（不匹配 expected），第二次才理解 actual.text 要精确等于 expected.text。根因是 test.json 的 expected.text 填的是「描述性预期」（如 "返回 isBareMode=true..."），而 judgeByExpected 做精确字符串匹配——这个语义对自动化测试（vitest pass/fail）不自然。

**改进**：对于自动化测试场景，expected 用 `exit_zero` 或 `script` type（跑测试命令验退出码）比 `exact` + 文本匹配更合适。或者在 test.json 设计时 expected.text 填测试断言的精确输出而非描述。

### 3. W1 worker 超时——派发任务过大
W1 有 10 个 changes（shared + 5 runtime 模块 + handler + 注入链），单个 worker 在 600s 内只完成 5/7 模块就超时。主 agent 接手写剩余 3 个（worktree-service.ts impl + handler + 注入链）。

**改进**：超过 5 文件 / 3 模块的 wave 应拆成多个串行 worker，或主 agent 预先把「可并行的独立模块」和「有依赖的编排层」分开派发。

### 4. W2 worker 的 mock 过度——三视角事故重现
W2 worker 写的集成测试 `vi.mock('@/composables/features/useNewTaskFlow')` 把整个 flow 替换成 mock，绕过了真实的 gitInfo computed 数据路径。导致 R1（isBareWorkspace 数据源断裂）在测试里不可见。reviewer 主动补了真实 flow 测试（RF-1/2）才发现。

**改进**：派 worker 写集成测试时，prompt 必须强调「至少一条用例用真实 composable，只 mock 底层 transport/session 数据源」——这是 AGENTS.md 测试规范 #6 的要求，但 worker 不一定遵守，主 agent 要在 review 时检查。

## 关键决策复盘

| 决策 | 正确性 | 回看会改吗 |
|------|--------|-----------|
| 入口放 DirSelectPopover（非 composer chip） | 正确 | 不会改——submitFirstMessage 零改动的红利证明这个选择 |
| 立即生效（非延迟执行/打包发送） | 正确 | 不会改——延迟执行的状态机复杂度高，立即生效更简洁 |
| setup 脚本方案 A（不做 fallback） | 正确 | 不会改——识别项目类型永远是坑 |
| 仅支持 .bare 模式 | 正确 | 不会改——自用 + 小众场景，YAGNI |
| base 默认 origin/main | 正确 | 不会改——用户明确要求 |

## 流程改进 actionable

1. **沉淀 cw CLI 格式速查**（最高优先）：把 plan/tdd_plan/review/review_fix/test 各阶段的必填字段、合法枚举值、常见 fail 原因整理成速查表，放 skill 或 AGENTS.md
2. **worker 任务拆分阈值**：超过 5 文件的 wave 拆成多个 worker，主 agent 编排依赖
3. **集成测试 prompt 模板**：派 worker 时强制要求「至少一条真实 composable 用例」，附 AGENTS.md 测试规范 #6 引用

## 数字

- commit 数：5（设计稿+文档 / TDD 测试 / W1 / W2 / review fix）
- 代码行：+2613 / -84（14 个新文件 + 12 个修改）
- 测试用例：50+ it 块（映射到 35 testCase）
- review issue：7（2 critical + 3 major + 2 nit，全修复）
- gate fail：10 次（全为 cw CLI 格式问题，非代码质量）
