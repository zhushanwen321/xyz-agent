# Recursive-Split E2E 深度审查报告

> **审查日期**：2026-08-02
> **审查对象**：wf-1785597545032-zg0k6q（21 agent calls，43 分钟，完整跑通）
> **方法**：3 个 subagent 并行审查（errorLogs+重试 / worktree / 代码质量+git 合并）

---

## 审查发现（4 个问题）

### 问题 1：wave:ui clarify 重复 10 次 — major bug

**现象**：`wave:recursive-root::ui` 的 clarify 被调度 10 次（call id=8-17），累计浪费 9.2 分钟。cw store 里 ui unit 有 14 条连续 `clarify` 记录，76 条 clarifications（正常 renderer wave 只 3 条）。

**根因链**：
1. cw 的 clarify 是 progressive action，每次 `cw clarify` 返回 `ok=true` 但不自动推进到 plan（status 停在 `clarifying`，frontier 继续 return `nextAction=clarify`）
2. recursive-split.js 的 `PROGRESSIVE_ACTIONS` 豁免了 clarify 的熔断——`detectStuckNodes` 直接 continue，retryCount 永远不累加
3. BFS 无条件信 frontier 的 nextAction，agent 返回 `done:true` 但 BFS 不消费此信号
4. 最终靠 agent 第 14 次"想通"主动调 `cw plan` 才脱困——纯靠运气

**为什么 plan/design-review 豁免合理但 clarify 不合理**：
- plan/design-review 有 gate 阻拦（gate fail 时必须重试，是正常多轮迭代）
- clarify **没有 gate**（永远 ok=true），豁免它 = 授权无限循环

**修复方向**（recursive-split.js）：
- progressive action 加软上限：连续 N 轮（如 15）仍同 action 同 status → abort 或在 prompt 注入"已徘徊 N 轮，立即前进"
- 或：executeNodeNextAction 对 progressive action 返回 done:true 后，下一轮 prompt 显式提示"上一轮已完成，请执行 cw <nextAction> 前进"
- 或：buildActionPrompt 的 clarify hint 改为"调一次 cw clarify 后若需求已清晰，立即调 cw plan 推进，不要重复 clarify"

**严重度**：major（不阻断流程但静默烧资源，任何 wave 只要 agent 在 clarify 徘徊就会触发）

### 问题 2：npm 版 subagent-workflow 缺 fork/worktree/returnMeta — major（部署时序）

**现象**：21 个 errorLog 全是 `agent() received unknown fields: fork, worktree, returnMeta`。

**根因**：dev app 的 mandatory 安装机制从 npm 拉 `@zhushanwen/pi-subagent-workflow` v2.0.1。该旧版的 `_knownFields` 白名单不含 `fork/worktree/returnMeta`（这些是本 PR #136 新增）。npm 版 warn 并忽略这三个字段。

**实际影响**：
- `returnMeta` 模式**仍部分生效**（calls 的 result 有 sessionFile）——因为 pi 旧版 agent-result handler 的 resolve 逻辑仍有兼容行为
- `fork` / `worktree` 被丢弃——但当前 recursive-split.js 硬编码 `worktree:false`，无影响
- 21 条 warn 是纯噪声

**修复**：本 PR #136 的 subagent-workflow 改动需要发 npm 新版（changeset 已准备 `minor` bump）。发版后 dev app 重启会自动升级。或用 dev-link skill 切到本地源码版调试。

**严重度**：major（部署时序问题，W1/W2 能力在 npm 发版前不会真正生效）

### 问题 3：UI wave test 阶段空口验收 — major

**现象**：UI wave 的 plan 定义了 3 个 integration test case（打开/关闭/错误处理），但 test 阶段没产出测试代码，只用了 `testJudgment` 人工判定通过。23 个测试全部是 renderer wave 的，UI 层 0% 自动化覆盖。

**根因**：recursive-split.js 的 buildActionPrompt 对 test action 的引导太模糊（"确保测试通过（cw 自动跑测试）"），没要求 agent 产出测试文件。

**修复方向**（recursive-split.js）：
- buildActionPrompt 的 test hint 改为"为当前 wave 的代码产出 vitest 测试文件，确保覆盖 plan 里声明的 testCases，跑 `npx vitest run` 确认全绿"
- 或：test action 的 schema 要求返回 `testFiles: string[]`（产出的测试文件路径）

**严重度**：major（验收失真，test gate 形同虚设）

### 问题 4：worktree=False — 已知限制，非 bug

所有 21 个 call 的 `worktree=False`。这是 pr-cr-fix must_fix #1+#2 的有意回退（pi worktree 绑定单 record，无法跨 action 存活）。本次两个 wave 串行调度无冲突。

**严重度**：非 bug（spec-w 目标态 vs 当前实现差距，已记录）

### 附加发现：renderer wave 越界实现 UI 职责

renderer wave（call 3）在 execute 时越界写了 `main.ts` 的主题切换 UI，ui wave（call 18）用 refactor commit 删除。跨 wave 职责泄漏——workflow 的 split 职责边界未被 enforce。

**根因**：buildActionPrompt 的 execute hint 没限制 agent 只能触碰 plan 声明的 files。

**严重度**：minor（最终产物功能正确，但浪费往返）

---

## 审查结论

E2E 最终**跑通**（root closed + 2 wave closed + 23 tests pass + build ok），但暴露 3 个 major 问题：

| # | 问题 | 修复方 | 状态 |
|---|------|--------|------|
| 1 | clarify 无限循环 | recursive-split.js（progressive 软上限） | 待修 |
| 2 | npm 版缺新字段 | 发 npm 新版（changeset 已准备） | 待发版 |
| 3 | UI test 空口验收 | recursive-split.js（test prompt 强化） | 待修 |
| 4 | worktree=False | 已知限制 | 不修 |

问题 1 和 3 是 recursive-split.js 的 prompt/熔断改进，可以立即修。问题 2 是发版时序，changeset 已在本 PR 中。
