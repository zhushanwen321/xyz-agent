# 技术设计文档对抗式审查报告

> 审查对象：`.xyz-harness/2026-08-13-session-restore/spec.md`（session.restore 显式 RPC）
> 审查依据：`rubric-design-doc.md`（P0/P1 清单）+ `design-principles.md` + `anti-patterns.md` + xyz-agent `AGENTS.md`
> 审查方式：逐条 `read`/`grep` 源码核实文档引用的文件路径/行号/API/函数名（P0-11）

## Summary

**4 must-fix, 3 suggestions.**

文档**结构与方案主干优秀**：五段骨架完整、SCQA 开篇结论先行、三方案对比带长期/短期评估、5 个验收场景均为 dev app 真实实测且逐条回溯 §1 目标、核心方案（新增 `session.restore` RPC）确实分离了「切换」与「重开」语义、根治了模式 A/B/C。但**事实核查不过关**——附录标榜「已确认的运行时事实」，实测多处行号偏移、一个文件根本不存在、一个函数名引用错误；**编排描述有实质遗漏**——`postLoadSession` 抽取漏了 `setActiveId`/`cancelFlow` 两个前置依赖，且 U3 的 sidebar 改法表述会重犯模式 A 同款 useI18n bug。模式 D 的 ghost session 处理未闭环。

按 rubric 判定：未达 DoR（设计就绪门槛），**must-fix 全部修复后方可进入实施**。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §附录 + §2.1 + §3.3 + §5 | P0-11 关键事实 | **大量行号/路径/函数名错误，且附录自称「已确认」**。逐条核实结果（read 源码）：① `core/store.ts:95/103` markDead/revive → **该文件不存在**，实际在 `stores/session.ts`；② `session-service.ts:184` removeSessionEntry → 实际**定义在 922 行**（差 738 行），184 行是 `session.adapter.detach()`；③ `useSidebarSessionActions.ts:48` 的 `switchSession` → **该函数不存在**，实际是依赖注入的 `selectSession`（27 行类型 / 45 行解构 / 64 行调用）；④ `useSidebarNew.ts:200` selectSession → 实际 **218**；⑤ `useSidebarNew.ts:34` C-W5-1 注释 → 实际注释块在 **9-13 行**；⑥ `errors.ts:40` errorWithCode → 实际 **50**；`errors.ts:49` MODEL_NOT_CONFIGURED → 实际 **57**；⑦ `session-lifecycle.ts:433` return toSummary → 实际 **428**；`:355` getDefaultModel → 实际 **353**；`:424` initErr catch → 实际 **417**；⑧ `handledTypes:42` → 实际 **40**；⑨ `Panel.vue:241` onReviveSession → 实际 242；`:238` onRetryHistory → 实际 237。附录标题写「已确认的运行时事实（供实施参考）」却未实际核实，属反例 1/9（认知懒惰——把「应该」当「是」）。 | 全部 read 源码逐条核准。严重项（文件不存在/函数名错/差百行）必须改对；轻微偏移（±1-2 行）一并校正。附录若保留「已确认」标题，每条须附实测探针状态（✅ 已 read 核实）。 |
| MUST_FIX | §3.3 决策 3 + §5 U2 | P0-12 副作用/遗漏 | **`postLoadSession` 抽取漏了 `setActiveId` 和 `cancelFlow` 两个前置依赖**。selectSession 实际 13 步（`useSidebarNew.ts:218-251` 实读）：`cancelFlow`(219) → `switchSession`(223) → **`sessionStore.setActiveId(id)`(224)** → `clearUnread`(226) → `ensureStreamSubscription`(228) → `touchLru`(230) → `syncSessionToPanel`(231) → …。文档定义 postLoadSession = 第 4-13 步（clearUnread 起），restoreSession = 「api.restoreSession → postLoadSession → revive」——**缺了第 1 步 cancelFlow 和第 3 步 setActiveId**。`setActiveId` 是 `ensureStreamSubscription` / `syncSessionToPanel` 的前置（两者依赖当前 activeId 路由到正确 session 分区，架构约定 #7 / ADR-0049），漏掉会导致 restore 后订阅/panel 同步作用于**旧的 activeId**。文档自己在「待验证检查点」只提了「ensureStreamSubscription 须先于 syncSessionToPanel」，没意识到 `setActiveId` 更靠前。 | restoreSession 编排补全为：`cancelFlow`（若活跃）→ `api.restoreSession(id)` → `sessionStore.setActiveId(id)` → `postLoadSession(id)` → `revive(id)`。明确 setActiveId 必须先于 postLoadSession 内的 ensureStreamSubscription。 |
| MUST_FIX | §5 U3 | P0-12 副作用/遗漏 | **sidebar 改法表述会重犯模式 A 的 useI18n bug**。U3 写「useSidebarSessionActions.ts 点击时检测 status==='dead' → 调 `useSidebarNew().restoreSession`」。但 useSidebarSessionActions 是**依赖注入式**架构（`Sidebar.vue:243` 在 setup 顶层调 `useSidebarSessionActions({ selectSession, ... })` 注入方法，handler 里调注入的 selectSession 而非 `useSidebarNew()`）。若按文档字面在 onSelectSession handler 里调 `useSidebarNew()`，会触发 `useHandoffActions → useI18n → getCurrentInstance()===null`（事件回调无活跃组件实例）——**正是模式 A 的报错**，修了 Panel 又在 sidebar 复发。 | restoreSession 应像 selectSession 一样**通过参数注入**到 useSidebarSessionActions（改其 Options 类型 + Sidebar.vue 注入点），handler 调注入的 `restoreSession`，不在 handler 内调 `useSidebarNew()`。status 判断用注入的 `focusedSession`/`store` 而非直接读。 |
| MUST_FIX | §2.2 模式 D + §4 场景 3 | P0-12 副作用/遗漏（边界场景） | **模式 D 的 ghost session 处理未闭环**。方案对「磁盘文件不存在」只做 `session_not_found` 错误码 + 隐藏重开按钮，但 dead session 项**仍留在 sidebar 列表**（SessionScanner 磁盘扫描 + 内存 Map 缓存），成为永久置灰、无法重开、无法进入的僵尸项。文档在 Scope 把「降级新建空 session」标为 out-of-scope（范围界定合理），但**当前方案对 ghost session 的 UX 缺完整说明**：隐藏按钮后该项是什么状态？用户能否删除？是否应提示「文件已丢失，建议删除」？验收场景 3 只断言「按钮禁用/隐藏」，未覆盖 session 项本身的处置。 | 二选一：① 在决策里显式说明「ghost session 留在列表是已知限制，降级在另一个 feature 解决」并补验收（确认项可被用户手动删除、有错误 tooltip 引导）；② 当前方案就把 ghost session 从列表移除 / 标记不可点击 + 引导删除（轻量闭环）。不能只隐藏按钮留僵尸。 |
| SUGGESTION | §3.3 决策 4 | P1-4 决策 alternatives / P1-5 MECE | **保留 session.switch 隐式分支导致两条 restore 路径错误码不一致**。决策 4 保留隐式分支（headless 兜底）合理，但副作用是：显式 `session.restore` 走新错误码（session_not_found / MODEL_NOT_CONFIGURED / restore_failed），隐式 switch 分支仍走旧错误码（file_not_found / not_found / history_load_failed）。同一 restoreSession 实现对外暴露两套错误语义，是技术债。文档未记录此债。 | 在决策 4 补一句「代价：两条路径错误码暂不一致，headless 迁移到显式 restore 后统一」+ 标 TODO，与已有的「移除隐式分支」TODO 并列。 |
| SUGGESTION | §3.3 决策 3 + §5 U2 | P1-1 关键概念无例子 / P0-17 物理数据流 | **hydrate 的 messages 数据流未点明**。决策 1 说「messages 由前端 hydrate 编排单独拉取」，但没说从哪拉。实读 selectSession（`useSidebarNew.ts:236-241`）：messages 来自 `chatApi.getHistory(id)`（独立 RPC），而非 switchSession/restore 的 reply。这一点对实施者重要（reply 只含 `{ session }`，hydrate 靠 postLoadSession 内的 getHistory）。文档漏了这条物理数据流。另：变量名实际是 `navigationPort.push`（非文档写的 `navigation.push`）。 | 在决策 1 或 postLoadSession 定义处补一句：「reply `{ session }` 不含 messages；postLoadSession 内 hydrate 调 `chatApi.getHistory(id)` 单独拉取（与 selectSession 一致）」。变量名校正为 navigationPort。 |
| SUGGESTION | §3.3 决策 2 | P0-18 错误恢复指引（部分） | **`restore_failed` 的恢复指引偏弱**。session_not_found（隐藏按钮）和 MODEL_NOT_CONFIGURED（引导 Settings）都有具体出口，但 `restore_failed`（spawn pi 失败）只写「显示原因 + 重试按钮」。AGENTS.md 规则 #16（错误信息必须可操作）+ 准则 6 要求指向恢复动作。spawn 失败常见因是 extension 加载失败 / 二进制缺失——可补「查看日志 `~/.xyz-agent-dev/logs/`」或具体诊断入口。 | restore_failed 的前端引导补一个可操作出口（日志路径 / 诊断命令 / 重试上限），不只「重试」。 |

## 逐项 rubric 判定

### P0 致命

| # | 检查项 | 判定 | 依据 |
|---|--------|------|------|
| P0-1 | 五段骨架 | **通过** | 背景/现状/方案/验收/拆分五段齐全，各段充实 |
| P0-2 | delta 链引用 | **通过** | 无 vN / Rxx / 参见上版，自包含 |
| P0-3 | 结论先行 | **通过** | 开篇「结论」段 + §1 SCQA 四段齐全，每章首句是该章结论 |
| P0-4 | 现状触根因 | **通过** | §2.2 五个模式 A-E 都给了「表象→根因」，§2.3 根因表收口 |
| P0-5 | 重实现轻体验 | **通过** | §1/§3.1 有使用者视角（用户看到什么、点按钮怎样），§2.1 数据流图在机制之前 |
| P0-6 | 抽象术语 | **通过** | session/dead/restore 等术语有定义 + 绑状态机例子 |
| P0-7 | 方案对比≥2 | **通过** | B1/B2/B3 三方案 |
| P0-8 | 长期+短期评估 | **通过** | 每方案评长期架构/短期成本/风险三栏 |
| P0-9 | 明确推荐 | **通过** | B1 推荐 + B2/B3 否决理由 |
| P0-10 | 是否真解根因 | **通过（模式 D 除外）** | A/B/C/E 真解根因；模式 D 只改善错误提示（session_not_found + 隐藏按钮），未解 ghost session（见 MUST_FIX 第 4 条），但文档已诚实标 out-of-scope |
| P0-11 | 关键事实正确 | **不通过** | 见 MUST_FIX 第 1 条——文件不存在/函数名错/多处行号偏移 |
| P0-12 | 副作用/遗漏 | **不通过** | 见 MUST_FIX 第 2/3/4 条——postLoadSession 漏 setActiveId/cancelFlow、U3 重犯模式 A、ghost session 不闭环 |
| P0-13 | 验收章节/可测试 | **通过** | §4 五场景均有前置/步骤/通过标准，可在 dev app 真实执行，每条回溯 §1 目标 |
| P0-14 | 验收=单测/mock/抽象 | **通过** | 全部 dev app 真实实测（kill -9 / 删 JSONL / 清 model），无 mock/桩，用具体业务断言（PID 变化/历史条数/置灰消失） |
| P0-15 | 验收投入匹配 | **通过** | 中等改动配 5 场景 + 1 回归，投入匹配 |
| P0-16 | 运行时断言附探针 | **不通过（附录）** | 附录「已确认的运行时事实」标榜已确认却多处行号/路径错（见 MUST_FIX 第 1 条），属反例 1/9——把「应该」当「已确认」。正文 ⛔ 标注（决策 1/3 的实施期验证）是诚实的，问题在附录 |
| P0-17 | 物理数据流图 | **通过** | §2.1 画了从「用户点击」到「revive」的完整链路，标注文件:行号（虽部分偏移）|
| P0-18 | 错误恢复指引 | **部分通过** | session_not_found / MODEL_NOT_CONFIGURED 有具体出口；restore_failed 偏弱（见 SUGGESTION 第 3 条）|

### P1 建议

| # | 检查项 | 判定 | 依据 |
|---|--------|------|------|
| P1-1 | 关键概念无例子 | **部分** | hydrate messages 数据流未点明（见 SUGGESTION 第 2 条）|
| P1-2 | 拆分 justification | **通过** | U1/U2/U3 按依赖顺序，每单元绑验收场景 |
| P1-3 | 受众背景 | **通过** | 假设读者懂 session 概念，§1 补了状态机 |
| P1-4 | 决策 alternatives | **部分** | 决策 1-5 都有「被否」记录；决策 4 的错误码不一致债未记（见 SUGGESTION 第 1 条）|
| P1-5 | 章节 MECE | **通过** | 模式 A-E 分组清晰无重叠 |
| P1-6 | 加机制而非减法 | **通过** | 方案是减法（砍隐式分支依赖、统一 revive 入口），非 clever 机制 |
| P1-7 | scope 越层 | **通过** | 当前层=session 生命周期机制，下一层=RPC 接口+前端方法，未跨 2 层 |

## 对抗式核心三问结论

1. **方案是否真解根因**：模式 A/B/C/E 真解（显式 RPC + setup 解构 + 统一 revive 收口）。模式 D 部分解——错误提示改善了，但 ghost session（文件丢失后僵尸列表项）未闭环，是 MUST_FIX。
2. **关键事实是否正确**：**不过关**。附录自称「已确认」却有一处文件不存在（core/store.ts）、一处函数名错（switchSession）、一处差 738 行（removeSessionEntry 184→922）、多处偏移。实施者照附录找文件会迷路。
3. **副作用/遗漏**：postLoadSession 漏 setActiveId/cancelFlow（会导致订阅/同步作用于错误 session）、U3 表述会重犯模式 A、ghost session 不闭环。三个 MUST_FIX。
