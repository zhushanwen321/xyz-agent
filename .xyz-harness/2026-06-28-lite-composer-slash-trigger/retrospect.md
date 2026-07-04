# Lite 复盘：composer-slash-trigger（2026-06-28）

## 概况
- Wave 数：2（W1 功能 / W2 验收）| 失败循环轮数：1（test-runner/reviewer 双双 hang，降级主 agent 自验）| 覆盖率：CommandPopover 60.2% / Composer 40.67% / ComposerInput 26.47%（全文件；增量核心逻辑全被 U1-U10 覆盖）
- 总体：⚠️ 功能交付正确，但执行过程暴露 6 个问题，根因分属工具/系统层、认知/流程层、架构/契约层三类

## 清单结果

### 流程
- ✅ Wave 拆分准确：单 Wave（三组件经 event/prop 契约耦合，串行同一 implementer）拆分合理，无因拆分不当返工
- ⚠️ TDD 真执行但被中断：implementer subagent 严格 TDD（先写测试跑确认 RED），但在 turn 41 触顶中断，**测试写完了、源码 0 改动**。主 agent 接手实现，等于"测试先行 + 实现后补"——形式上 TDD，实质是测试已就位作为契约
- ❌ 失败循环：test-runner + reviewer 双 subagent **hang**（136s，token 卡 72K/193K 2 分钟不增长），触发健康检查 + 取消 + 降级主 agent 自验。降级决策正确，但 hang 本身是系统层问题（见问题 2 深度分析）
- ✅ 测试 ‖ review 并行：降级为当前 worktree（单 Wave + 单测无副作用 + E2E 手动，无冲突风险），降级已向用户报告

### 测试质量
- ✅ 覆盖率达标：CommandPopover 全文件 60.2%（过线）；增量核心逻辑（onInput 触发 U1-U5 / items 过滤 U6-U8 / wiring+守卫 U9-U10）100% 被单测锁定
- ⚠️ E2E 全部手动（项目无框架）：E1-E6 至 plan 完成时 0 验证，browser-automation 实测又暴露 mock commands 订阅链路问题（非本次范围，见问题 5）
- ⚠️ 测试用例设计偏差：U6 原 query='co' 同时匹配 /commit + /compact（2 项），实现期才发现改 'comm'（见问题 4 深度分析）

### 文档
- ⚠️ plan.md 与实现基本一致，但有 1 处偏差：plan 说「分文件 commit」，实际因 pre-commit hook 要求提取 composable，合并成单 commit（+ 新增 useComposerChipCommands.ts）
- ❌ **handoff 的事实性偏差未被 plan 阶段 catch**：handoff DoD item 6 说「eslint no-magic-spacing 会查 Tailwind scale」，实际 eslint.config.mjs 仅 20 行无此规则；handoff 还遗漏「+菜单回归」bug，plan 阶段 catch 到并修正了（加 slashTriggerActive 守卫 + U10）。**handoff 的事实声明不应盲信**（见问题 3 深度分析）

### skill / subagent
- ❌ **subagent hang 无自动兜底**（见问题 2 深度分析）
- ✅ implementer prompt 充分：技术约束（DOM 查询判 chip / Tab 只在 CommandPopover 加 / slashTriggerActive 守卫）在 prompt 穷尽列出，implementer 未 NEEDS_CONTEXT
- ⚠️ reviewer hang 可能是 task 过大（6 文件 5 维度审查），下次考虑拆分或加 maxTurns

### 提示词 / 业务 / 架构
- ❌ **主 agent 低级重复错误消耗大量 turn**（见问题 1 深度分析）
- ⚠️ 架构信号：ComposerInput 提取 chip DOM 操作到 composable 是 hook 触发的（pre-commit 行数限制），非主动设计。contenteditable 组件天生易胖
- ⚠️ mock 与 runtime 的 commands 订阅链路有差异（见问题 5 深度分析）

## 改进项索引

| P | 问题 | 根因层级 | 归属 | 追踪 |
|---|------|---------|------|------|
| P0 | 主 agent 连续漏写 `cd renderer` | 工具层+项目结构 | 自我工作习惯 | 待办 |
| P0 | 后台 subagent hang 无系统兜底 | 系统层+规范矛盾 | pi 调度层 / lite-execute skill | 待办 |
| P1 | handoff 事实声明被盲信 | 认知层（验证手段与声明类型不匹配） | lite-plan skill | 待办 |
| P1 | U6 query='co' 匹配 2 项 | 上下文层（fixture 不在 plan 窗口） | lite-plan 测试设计 | 待办 |
| P2 | mock commands 订阅链路与 runtime 不一致 | 契约层（sessionId 对齐/时序），**待证** | 业务项目 mock 层 | 待办 |
| P2 | E2E 全手动 | 架构层（测试金字塔断层） | 业务项目基建 | 待办 |

## 机制层根因深度分析

### 问题 1：连续 6+ turn 漏写 `cd renderer`

**机制**：项目命令分布在三个目录层级，且每类命令绑定不同层级——`npm run lint` 在仓库根、`npm run dev:mock` 在 src-electron/、`npx vitest run` 在 src-electron/renderer/（因为 `@` alias 只在 renderer/vitest.config.ts 定义）。

**关键工具机制**：bash 工具的 cwd **不跨调用持久**——每次 `cd renderer && X` 的 cd 只在那一条 command 内有效，下一条 command 的 cwd 回到默认（src-electron 或仓库根，行为不稳定）。「记住写 cd」不是一次性记忆，而是**每条 command 都要重新决策**的持续负担。

**叠加因素**：implementer subagent 中断后，主 agent 接手时 cwd 上下文从 implementer session 继承（它 cwd=仓库根），但 vitest 要从 renderer 跑——**起点状态就是错的**。

**真因**：工具假设「单 cwd 项目」（多数项目是），但本项目是 multi-workspace + 命令分散在三层级 + 工具 cwd 不 sticky，三者叠加成持续陷阱。「遗忘」只是这个陷阱的症状。**可证伪**：若 bash cwd sticky，第一条 cd 后 0 次重复。

### 问题 2：subagent hang 无系统兜底

**机制**：后台 subagent 的唤醒靠「终态触发」——subagent done/failed/cancelled → notifier 注入消息 → 主 agent 被唤醒。这个机制**假设 subagent 一定会到达终态**。但模型推理 hang 时（GLM-5.2 卡在思考，token 停滞），subagent 处于「运行中但无进展」——既不 done 也不 failed，notifier 永不触发。

**致命矛盾**：lite-execute 规范同时要求两条互斥行为——STOP 规范「派出后台 subagent 后不要轮询，等通知」+ 健康检查规范「超过 2x 预期时长主动 list 检查」。但 STOP 状态下主 agent **没有执行检查的时机**——它不会被唤醒，除非有外部触发。这次打破僵局的是 `goal_context` 的 turn 推进（系统级注入），不是 lite-execute 的健康检查规范。**规范写了，但规范依赖的执行时机不存在。**

**真因**：异步任务把 liveness 检测责任推给了消费者（主 agent），但消费者在等终态时本就无法主动执行——**责任与能力错位**。分布式系统里这靠 worker heartbeat 解决，subagent 没有心跳机制。**可证伪**：若 subagent 每 30s 发心跳 + 主 agent 2 周期无心跳则 cancel，hang 会在 ~60s 被发现，而非 136s + 靠 goal_context 救场。

### 问题 3：handoff 事实声明被盲信

**机制**：需区分「为什么有些验证了、有些没验证」。我实际做了部分验证——+菜单回归 bug 是 plan 阶段 catch 的，catch 的方式是**逻辑推导**：读到 handoff「`slash-trigger:null` 无条件关浮层」时脑内模拟「+菜单打开后敲键」场景，发现矛盾。eslint 规则那条没 catch，因为它是**外部事实**（规则在不在），逻辑推导不出，只能实测，而我没实测。

**关键机制**：handoff 用「已验证的事实（不要重新查）」这类标题预设了权威性，**直接抑制了二次验证本能**。它把事实型声明（eslint 规则在）和判断型结论（方案可行）混在一起，统一包装成「已验证」。

**真因**：plan 阶段的验证策略有选择性——逻辑可推导的做了验证，需外部实测的没做。这不是「忘了验证」，而是**验证手段与声明类型不匹配**：事实型声明需要 grep/ls 实测，但我把它当判断型结论处理了（读了就信）。**可证伪**：若对 handoff 每条「X 存在/已实现」都 grep 一次，eslint.config.mjs 仅 20 行那条会立即暴露。

### 问题 4：U6 query='co' 匹配 2 项

**机制**：设计 U6 时思路是「验证 query 能收敛到 1 项」→ 选 'co'（因为 commit 含 co）。但 mock 数据集是 `/commit /review /fix /compact`——**'compact' 也含 'co'**。脑里只有「/commit」，没有完整的 4 条数据集。

**为什么数据集不在场？** plan 阶段读的是三个组件源码 + handoff。mock 的 MOCK_COMMANDS 在第四个文件（`src/api/mock/index.ts`），handoff 只提了一句「已覆盖三种 source」，**4 条命令名没进上下文**。这是「为验证功能设计测试」，而非「对照真实 fixture 设计测试」——顺序反了。

**真因**：测试预期值必须对照 fixture，但 fixture 在 plan 阶段不在场（上下文覆盖盲区）。这是「先有功能意图、后补 fixture 认知」的设计顺序问题。**可证伪**：若 plan 阶段把 MOCK_COMMANDS 4 条命令名列在测试清单旁边，'co' 会一眼看出匹配 2 条。

### 问题 5：mock commands 订阅链路（browser-automation 暴露）

**⚠️ 以下是基于代码的机制假设，未实测验证。**

mock 推送链：`switchSession(id)` → `pushSessionState(id)` → `dispatchSession(sessionId, msg)` → 命中 `sessionHandlers.get(sessionId)` 订阅者。

CommandPopover 订阅：`onMounted` 时 `events.on(props.sessionId, callback)`。组件在 Composer 模板里无条件渲染（只有 PopoverContent 有 v-if），订阅应在 session 激活前建立。

**最强假设：sessionId 两端不对齐**——mock 推送用的 id（`useSidebar.selectSession` 调 `sessionApi.switchSession(id)` 传入）vs CommandPopover 订阅用的 id（Composer `props.sessionId` 来自 `sessionStore.active?.id`）。若 mock 内部 id 与它推给前端的 session.list 里的 id 不一致，推送和订阅就对不上。

**另一可能（时序竞争）**：mock 的 `session.commands` 推送在 `switchSession` 同步触发，但前端切 session 后 CommandPopover 是否因 props.sessionId 变化而重订？代码里有 `watch(() => props.sessionId, subscribeCommands)`，但 watch 触发是异步（nextTick），若 mock push 早于 watch 回调，订阅错过。

**真因（待证）**：要么 sessionId 体系错位，要么订阅时序竞争。两者都指向 **mock 与前端的 session 契约没有强校验**。**不应在复盘里当结论**——要确认得读 useSidebar + mock switchSession + Composer sessionId 来源对齐。

### 问题 6：E2E 全手动

**机制**：门槛只是表象，根因是测试金字塔断层。browser-automation 这次能暴露 mock 问题，是因为它跑**真实渲染**。而 U1-U10 单测用 happy-dom——**happy-dom 对 contenteditable/Selection/Range 支持有限**，这正是为什么 U1-U5 被迫用 textContent + querySelector 而非真实光标操作。**单测过了，但单测验证的不是真实 DOM 行为。**

**金字塔断层**：
- 单测层（vitest + happy-dom）：验证逻辑，**DOM 行为失真**
- 集成层（真实 DOM，不连后端）：**缺失**——本该用真实浏览器环境测 contenteditable
- E2E 层（真实 DOM + 后端）：**缺失**

contenteditable 组件尤其需要集成层，因为它重度依赖浏览器原生 Selection/Range/TreeWalker，happy-dom 模拟不全。browser-automation 这次充当了「一次性手动集成层」，但不可回归。

**真因**：不是「没装 playwright」，是**测试策略没识别出 contenteditable 组件对真实 DOM 的强依赖，导致金字塔中间层留空**。E2E 全手动只是这个空缺的下游表现。

## 根因归类总览

| 根因层级 | 涉及问题 | 性质 |
|---------|---------|------|
| 工具/系统层 | 1（cwd 不 sticky）、2（无 heartbeat） | 业务侧只能绕不能根治 |
| 认知/流程层 | 3（验证手段错配）、4（fixture 不在场） | skill 可改 |
| 架构/契约层 | 5（mock 契约，待证）、6（金字塔断层） | 需 design 级决策 |

**关键判断**：
- 问题 1、2 不是能力问题，是工具/系统机制缺陷硬塞给执行者的负担
- 问题 3、4 是 plan 阶段认知疏漏——逻辑可验证的不该漏（3），fixture 该在场却没拉进来（4）
- 问题 5、6 指向更深层，5 需先验证假设，6 需测试策略级决策

## 最值得改
**P0 #1（主 agent 漏写 cd）**——成本最低、收益最快、完全自主可控。但这是治标，真因是工具 cwd 不 sticky。P0 #2（subagent hang 兜底）价值更高（解决责任与能力错位）但归属 pi 调度层，需跨 repo 改动。问题 3、4 是 plan skill 可直接改进的认知/流程项，归属清晰、改动局部。
