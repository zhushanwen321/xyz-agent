---
phase: architecture
entries: 0
---

# 反哺检查 Round 1 — architecture → clarity(requirements)

> 审查 APPROVED 后、交接前，检测本阶段是否引入与上游 requirements.md 矛盾的结论。

## 检查结果：无矛盾（entries=0）

逐项核对 system-architecture.md 与 requirements.md：

| 核对项 | requirements.md | system-architecture.md | 一致性 |
|--------|----------------|----------------------|--------|
| 目标映射 | G1/G1.1~1.4/G2 | §1 目标转换表逐条映射 | ✅ 一致 |
| 四类数据源 | §3 数据清单（命令/文件/会话真实 + 符号占位） | §7 模块划分 + §9 泳道（4 源编排） | ✅ 一致 |
| 文件搜索（复用 searchFiles） | §7 约束 + §6（D-003 复用 searchFiles） | §7 模块（复用 file.search）+ §10 D-016 | ✅ 一致 |
| 命令注册表（D-004） | §2 UC-2 + §4 F5 | §7 命令注册表模块 + §10 D-016 扩展 store | ✅ 一致 |
| 跳转行为（D-006） | §2 UC-2/3/4 三类跳转 | §7 跳转编排模块 + §12 BC-3 变更 | ✅ 一致 |
| recents 持久化（D-007） | §2 UC-1 + §3（localStorage） | §7 recents composable + §12 BC-5 变更 | ✅ 一致 |
| 符号占位（D-001/D-002） | §2 UC-5 + §8 不做 | §4 降级决策 + §10 特化（符号不建 port） | ✅ 一致 |

## 架构新增的澄清（非矛盾，不反哺）

架构阶段澄清了 requirements 未明确的两点实现细节，属架构职责范围内细化，不构成 requirements 矛盾：
1. **分组归属**：requirements 未明确「按类型分组」归哪个模块，架构明确归 search domain（§7/§9）
2. **file.search 全量返回**：requirements §6 提「复用 file.search」，架构澄清其返回全量 FileNode[]、子串过滤在 renderer 前端（§9 泳道）

这两点是架构对 requirements 的合理细化，不推翻 requirements 任何结论，不需反哺修订 requirements.md。

## 结论

无事实性矛盾，无设计假设被证伪，不涉及 D-不可逆决策推翻。requirements.md 无需修订。交接下游。

---
phase: issues
entries: 0
tracer: independent-backfeed-subagent
date: 2026-06-30
---

# 反哺检查 Round 1 — issues → architecture(②)/requirements(①)

> 独立 subagent，上下文与主 agent 隔离。检测 issues 阶段定稿（issues.md）是否引入与上游 ②system-architecture.md / ①requirements.md 已拍板事实/决策矛盾的结论。
> 反哺纪律：只修订「事实性矛盾」或「设计假设被下游证伪」；下游「更优方案」不构成反哺理由；D-不可逆决策 → 必须 ask_user。

## 检查结果：无矛盾（entries=0）

逐上游 .md 核对 issues.md 全部 10 个 issue + 决策记录（D-017~D-020）+ 覆盖核验表 38 行，未检出与上游已拍板结论矛盾之处。重点三项核对如下：

### 重点核对 1：D-020（debounce P2→P1）—— ✅ 非矛盾

- **上游②§1（system-architecture.md §1 搭便车候选表）**：debounce(120ms) 列为搭便车**候选**（状态「候选，待⑤骨架验证确认」）——候选非锁定的 P2 决策，提前到 P1 完全在决策流范围内。
- **上游① UC-2（requirements.md §2）主流程 step 2**：「debounce(120ms) 后查询命令注册表」——**① 明确要求 debounce**。issues 将 debounce 提前不仅不违反①，反而更贴合① UC-2 的 AC 假设（该 AC 默认 debounce 存在）。
- **决策流程**：D-020 是 D-019 的正式 REVISIT，decisions.md 账本一致（D-019 status=revisited/superseded_by=D-020；D-020 status=confirmed，confirmed_by=ask_user）。
- **rationale 下游证据**：AH-C2「search domain 用 allSettled 每次按键发 3 源全量拉取」经 tracing-round-2 独立源码核验属实（file.search/session.list 均全量返回），P1 阶段无 debounce 的性能炸点真实存在。
- **结论**：D-020 与上游②候选/①UC-2 AC 均不矛盾，走决策流合规，rationale 有真实下游证据支撑。**不需反哺**。

### 重点核对 2：AH-B1（500 截断 vs ①「全量递归」）—— ✅ 非矛盾

- **上游①§3 数据清单（requirements.md:191）**已显式记录上限：「项目文件树 | runtime 现有 `file-service.searchFiles`（全树递归，**深度 8/上限 500**/内建 ignore）」；①§1 达成路线（:28）同样列「上限 500」。即①**已知并记录了 500 硬截断**，并非声称「无限结果」。
- 「全量/全递归」与「上限 500」在①中并列陈述——①把它们作为 searchFiles 的同一组既有属性（全树递归算法 + 深度8/上限500 硬护栏），不构成自我矛盾。
- issues #4 AC-4.7「文件数超 MAX_SEARCH_RESULTS=500 时显示截断提示」是①未涉及的**下游 UX 细化**（让用户感知截断），属实现层增值，非对①结论的纠正——①从未承诺「全量必显示」。
- **结论**：①未犯事实性错误（已记录 500 上限），AC-4.7 截断提示属合理下游细化，不在反哺范围。**不需反哺**。

### 重点核对 3：AH-S2（error 态查询路径不可达 vs ②§5 error 描述）—— ✅ 非矛盾

- **上游②§5（system-architecture.md:122）**：`error`（查询/跳转失败）列为 open 内视图态；:127 Reason 字段「error 态原因由具体 api 调用 catch 表达」；:151「loading/error 是 transient 标志（ref + setTimeout/catch 驱动）」。
- **issues #8 AC-8.6 发现**：查询路径因 search domain 用 **allSettled 吞单源错误**，实际不进全局 error 态（单源失败=对应分组空态）；全局 error 态仅由**跳转失败**（file.read/session.switch，非 allSettled）触发。
- **关键判定**：②§9 swimlane（:261）**自身就规定用 allSettled**（`par 并行查 3 源（全量返回，无服务端过滤）` + allSettled 容错语义）。issues 的 AC-8.6 完全**遵循②§9 的 allSettled 机制**推导——issues 没有推翻任何②已拍板决策，反而忠实执行了②§9。
- 所谓「②§5 `error`（查询/跳转失败）措辞偏宽」实为**②文档内部 §5（态枚举措辞）与 §9（allSettled 机制）之间的轻微措辞松散**，已在 issues tracing-round-2 中捕获并以 AC-8.6 正面对齐。这是②自身的措辞问题而非 issues 引入的矛盾；issues 不与②矛盾（与②§9 一致），且未触碰 D-不可逆决策（error 态处理归 D-014 可逆松散状态机范畴）。
- **结论**：issues 忠实于②§9 机制，未引入与②矛盾的结论；②§5 措辞偏宽属上游文档自身松散（tracing 已记录），按反哺纪律「下游更优表述」不构成反哺理由。**不需反哺，无 NEEDS_USER_CONFIRM**。

## 其余逐上游核对（摘要）

| 核对维度 | 上游源 | issues 对应 | 一致性 |
|---------|--------|------------|--------|
| 模块划分（②§7 七模块） | system-architecture.md §7 | #1~#7 一一对应，无增删/拆并 | ✅ 模块数与边界一致 |
| 分层/port 决策（D-011/D-012/D-013） | ②§6/§10 + decisions | issues 全部标 N/A「已决策」不当 gap 重报 | ✅ 遵守账本纪律 |
| 用例 AC（①UC-1~UC-5） | requirements.md §2 | 每个 AC 均有 trace 溯源到①对应 AC | ✅ 未违反任何① AC |
| P 级划线（D-017/D-018） | decisions（ask_user confirmed） | issues P0/P1/P2 划分与 D-017/D-018 一致 | ✅ 与拍板一致 |
| 行为契约（②§12 BC-1~BC-12） | system-architecture.md §12 | 覆盖核验表逐条覆盖，变更项（BC-3/5/7）独立 ticket | ✅ 保持/变更归类一致 |
| 搭便车（②§1 三候选） | system-architecture.md §1 | #10 承载，D-020 修订后剩 2 项 | ✅ 候选→纳入，走决策流 |
| 反模式 AC（②§11 AC-1~4） | system-architecture.md §11 | AC-1→#5、AC-2→#10、AC-4→#1，AC-3 标实现期 | ✅ 验收落点一致 |

## 结论（issues 阶段）

无事实性矛盾，无设计假设被证伪，未推翻任何 D-不可逆决策。重点三项（D-020 / AH-B1 / AH-S2）经核验均为 issues 忠实执行上游机制或合理下游细化，不构成反哺理由。上游 ①requirements.md / ②system-architecture.md 无需修订。**NEEDS_USER_CONFIRM：无。**
