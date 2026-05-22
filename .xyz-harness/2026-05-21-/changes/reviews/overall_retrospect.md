---
phase: pr
verdict: pass
---

# Overall Retrospect — Runtime + Front-end Architecture Refactoring

覆盖全部 5 个 phase（spec → plan → dev → test → pr），43 文件变更，+4,747 / -975 行。

---

## 1. Phase Execution Review

### Summary

本次 harness 将 xyz-agent Runtime 从两个上帝类（server.ts 574L + session-pool.ts 600L）重构为 Transport + Service 分层架构，同时完成了前端类型安全、死代码清理和 refCount 修复。全流程 5 个 phase 依次完成，PR #42 已合并，CI 全绿（lint / test 46 用例 / tsc --noEmit）。

| Phase | 核心产出 | 评审轮次 | 最终状态 |
|-------|---------|----------|---------|
| spec | 9 FR + 7 决策 + infrastructure scan | 3 轮 | pass |
| plan | 10 Task / 4 执行组 + E2E test plan + test cases | 3 轮 | pass |
| dev | 43 文件 +4,747/-975 行，session-pool.ts 完全删除 | 2 轮 code review | pass |
| test | 20 用例执行，46 vitest 全过，tsc 零错误 | 1 轮 | pass |
| pr | PR #42，13 commits，CI 全绿 | — | pass |

### 全流程关键成就

1. **session-pool.ts 600L 完全删除**，功能分散到 3 个独立 Service（SessionService、RpcClientService、ProcessManagerService）+ Transport 层。这是整个重构中最核心也最危险的操作，没有出现功能回归。
2. **DI 接口 + setServices 注入模式**成功解决了"谁先创建"的循环依赖问题。plan 阶段设计的 `server 先创建 → Service 构造 → setServices 注入` 方案在实际执行中完全可行。
3. **前端 refCount 保护**修复了 split mode 下事件重复注册的潜在 runtime bug，属于 spec 阶段未充分重视但 dev 阶段正确处理的问题。

### 全流程关键问题

1. **AC 目标与现实的偏差**：spec 的 AC-1 要求 server.ts ≤250L，实际 365L。这条偏差贯穿 dev 和 test 阶段（TC-7-02 R1 失败），最终以 code review 接受收尾。根因是 spec/plan 阶段没有精确估算 switch/case 路由的最小体积（27 case × ~4 行 = ~108L 路由本身）。教训：涉及行数约束的 AC，必须在 plan 中附带估算依据。
2. **4 个前端测试 pre-existing failure 从未修复**：从 spec 扫描发现到 dev 执行确认再到 test 记录，Vite 配置缺 `@vitejs/plugin-vue` 的问题在 5 个 phase 中被传递了 3 次却从未解决。每次都是"记录在案"然后继续。这是一个典型的"非本次变更范围"问题被无限推迟的模式。
3. **测试计划与实际执行不一致**：E2E test plan 描述的是"启动 Runtime → WS 连接 → 发消息"，实际执行全部用 vitest mock。对纯重构项目风险可控，但方法论上自相矛盾——如果需要端到端验证，这个差距就会变成真正的缺陷。
4. **评审总轮次偏高**：spec 3 轮 + plan 3 轮 + dev 2 轮 + test 1 轮 = 9 轮。spec 和 plan 各 3 轮的主要原因是"第一次粗写 → 第二次修结构性问题 → 第三次精扫"。如果初始产出质量更高（尤其是 AC 全文搜索验证和 Task 粒度控制），可以各减 1 轮。

### What Would You Do Differently

1. **Spec 阶段决策先行**：先确定所有关键决策（删哪些文件、新建哪些接口、DI 模式），再写 FR/AC。避免决策分散在 FR 描述和 Decisions Made 两处导致的 AC 残留不一致问题。
2. **Plan 阶段按 subagent 约束拆 Task**：默认每个 Task ≤5 文件、≤1000 行。BG3 Task 8（同时提取 3 Service + 重写 server + 删 session-pool + 更新 index，超 3000 行）必须拆成 2-3 个子 Task。
3. **Dev 阶段强制每 Task 完成后跑 `npm run build`**：TC-11-01 的 `vue-tsc` 类型错误（SystemNotification.vue 缺少 `info` 变体）本应在 dev 阶段就暴露，不应拖到 test 阶段。
4. **合并 E2E test plan + test cases template 为一份文件**：两份文件内容高度重叠，维护同步成本不必要。

### Key Risks（后续迭代注意）

1. **server.ts 365L 膨胀趋势**：当前 27 个 case 的 Transport 路由已经接近 365L。如果后续新增消息类型，需要在添加前先做 Map-based 路由重构或按 domain 分文件。
2. **6 个 LOW 技术债**：event-adapter.ts 中 PiEvent 类型未完全利用、async handler 缺 return 等。这些不会立即出 bug，但会在后续维护中造成困惑。
3. **无真实 WS 集成测试**：所有集成测试都是 vitest mock。未来如果修改传输层（如心跳、断连重连、消息序列化），需要补充端到端 WS 测试。
4. **4 个前端测试文件长期不可用**：Vite 配置问题未修，导致前端测试基线无法建立。后续任何前端变更都无法通过 CI 验证前端代码。

---

## 2. Harness Usability Review

### Flow Friction

5 个 phase 的推进节奏总体自然，没有需要 workaround 的硬性阻塞。主要摩擦点：

- **Spec → Plan 的评审迭代成本高**：spec 3 轮 + plan 3 轮共 6 轮评审占了全流程相当比例。根因是初始产出粒度不够细（spec 的 handler 枚举靠记忆、plan 的 BG3 Task 粒度过粗）。如果在 spec/plan 阶段有结构性预检（如"AC 全文搜索验证"、"Task 行数估算"），可以各减 1 轮。
- **Phase 之间的信息传递依赖 markdown 文件**：spec → plan → dev → test 的上下文传递完全靠 markdown 文件的交叉引用。这在 5 个 phase 中工作正常，但如果某个 phase 的交付物质量不达标（如 plan 的 AC 估算不准），下游 phase 会继承偏差。目前没有跨 phase 的自动一致性检查。

### Gate Quality

Gate 检查在整个流程中发挥了有效作用：

- **Spec gate**：3 条 MUST FIX（session-pool 去向、types.ts 位置、handler 枚举）全部是真阻塞项，没有 false positive。
- **Plan gate**：Task 粒度问题被准确识别，BG3 拆分后通过。
- **Dev gate**：双轮 code review 设计（v1 审代码 → v2 审测试证据）比单轮全量 review 效果好，6 个 LOW 正确分类为不阻塞。
- **Test gate**：一轮通过，4 LOW + 1 INFO 全部有意义（AC 覆盖缺口、测试方式不一致）。

没有出现 gate 漏检导致下游返工的情况。

### Prompt Clarity

各 phase 的 prompt/stage 描述质量整体较高：

- **最佳**：Plan 阶段的 File Structure 表 + Wave Schedule + Execution Groups 三重引导结构。AI 可以立即理解执行顺序和分组策略。
- **最佳**：Test 阶段的 test_cases_template.json，steps 字段指定了具体 grep 命令和文件路径，几乎零歧义。
- **需改进**：Dev 阶段的 FG1 Task 9 说"修改所有调用系统通知的组件"但未列出具体组件名。subagent 需要自行 grep 浪费上下文。
- **需改进**：Spec 阶段的 AC 行数目标（≤250L）没有附估算依据，导致 dev/test 阶段的反复讨论。

### Automation Gaps

按优先级排列，最值得投入自动化的 3 项：

1. **测试 evidence 自动生成**（dev + test phase）：`vitest --reporter=json` + `cloc` + `git diff --stat` 就能生成 `test_results.md` 90% 的内容。当前手动构造 JSON 测试记录是最大的重复劳动。
2. **AC 覆盖矩阵自动生成**（test phase）：test_cases_template.json 每条用例标注覆盖的 AC ID，脚本自动生成覆盖矩阵。当前需要人工逐条映射。
3. **决策变更影响分析**（spec phase）：每次修改 Decision 后，全文搜索被删除/重命名的文件名，列出所有出现位置。当前靠人工扫描，v3 的 AC 残留不一致就是遗漏的后果。

次要自动化：

4. **Handler 枚举从代码生成**（spec phase）：从 `ClientMessageType` 联合类型自动提取 handler 清单，避免手写计数。
5. **Baseline 测试快照**（dev phase）：CI 基线快照机制，自动标注 pre-existing failure，避免每轮手动验证 base commit。
6. **Plan 结构性检查脚本**（plan phase）：自动验证每个 Task 的文件数 ≤10、有验证步骤、依赖关系无环。

### Time Sinks

全流程最大的时间消耗：

1. **评审迭代（9 轮）**：spec 3 + plan 3 + dev 2 + test 1。如果初始产出粒度更细，可降至 spec 2 + plan 2 + dev 1 + test 1 = 6 轮，节省约 33%。
2. **BG3 Task 8 单 Task 超 3000 行变更**：提取 3 Service + 重写 server + 删 session-pool + 更新 index 塞进一个 Task。验证和 code review 的认知负担远超正常水平。拆成 2-3 个子 Task 后每步验证成本更低。
3. **测试 evidence 手动构造**：20 个用例的 JSON 记录需要逐条填写 execute_steps 和 evidence，重复且无创造性。

### 全流程综合评价

本次 harness 完成了一次中等复杂度的架构重构（43 文件、+4,747/-975 行、session-pool 完全删除），5 个 phase 全部 pass，CI 全绿，没有功能回归。harness 流程在结构化引导、质量门控、上下文传递方面发挥了核心作用。

主要改进方向：**减少评审轮次**（通过更细的初始粒度和结构性预检）和**自动化 evidence 生成**（测试记录、AC 覆盖矩阵）。这两项改进预计可以将同规模 harness 的总时间缩短 25-30%。
