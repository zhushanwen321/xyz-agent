---
topic: recent-workspaces
complexity_tier: L2
created_at: 2026-07-03
---

# 设计进度 — recent-workspaces（最近工作区独立持久化）

**当前阶段：** mid-detail-plan 已完成 ✅
**主题目录：** `.xyz-harness/2026-07-03-recent-workspaces/`
**复杂度档位：** L2（12 分；见下评分依据）

## 复杂度评分依据（L2）

| 信号 | 分数 | 依据 |
|------|------|------|
| 系统数 | 中(2) | 多模块单系统（runtime + renderer） |
| 用例数 | 中(2) | 增强现有流程，约 5 用例 |
| NFR 高风险维度 | 低(1) | 并发+损坏风险低，WriteBackCache+atomicWrite 已覆盖 |
| 技术选型开放度 | 低(1) | 栈已定（JSON store，handoff 预决） |
| Wave 数 | 中(2) | 预估 4 Wave |
| 领域成熟度 | 低(1) | recent-workspaces 是成熟模式 |
| 状态复杂度 | 低(1) | 无状态机，仅 list+timestamp+LRU |
| 跨边界数 | 中(2) | 新增 RPC 控制边界 + filesystem + pi 只读扫描 |
| **总分** | **12** | **= L2 标准档** |

## 已完成阶段

| 阶段 | 交付物 | 审查 |
|------|--------|------|
| mid-plan（需求+架构）| requirements.md + system-architecture.md | ✅ review-fix-loop CONVERGED（Round 1 修 3 must_fix → Round 2 双路 APPROVED） |
| mid-detail-plan Step 1-3 | issues.md + non-functional-design.md + code-architecture.md(+skeleton 15文件) + execution-plan.md | Step 3c 机器检查实质硬伤全清（nfr 7/8、code-arch 14/15、execution 7/8，未过项均 review-*.md 缺失=Step 4 产出） |

## mid-detail-plan 进行中

- **Step 0 context-builder**：✅ 摘要注入（context-summary-mid-detail-plan-round-1.md）
- **Step 1 issues + batch-ask**：✅ issues.md 6 issue + batch-ask 确认 D-007（create-only 不扩展 selectDirectory）/ D-008（INV-7 toast+homedir fallback）
- **Step 2 2 drafter 并行**：✅ nfr（bg-9 完成 7/8）/ code-arch（bg-10 失控 cancel，但核心产出 code-architecture.md 42.6KB + 骨架 15 文件已落盘，机器检查 14/15）
- **Step 3 回灌对齐 + execution**：✅ code-arch 来源 B 补全（nfr 10 条代码测试缓解全映射）+ execution-plan.md（4 Wave + 验收清单 28 用例）
- **Step 4 review-fix-loop**：🔄 5 路 reviewer 并行（issues覆盖/nfr/code-arch禁读重建/execution/红队）

## mid-detail-plan 已确认决策（D-007/D-008，见 decisions.md）

- D-007 写入时机 A 只挂 create 不扩展 selectDirectory（ask_user）
- D-008 INV-7 cwd 失效 UX = toast 提示 + homedir fallback（ask_user）
- code-arch 新增 agent-opinionated：D-005 方案 a（WriteBackCache 固定 partition 'global'）+ trim set 后立即内存 + label 算（basename）零冗余 + INV-1 双层守卫

## 教训记录：code-arch drafter 失控（2026-07-03）

bg-10 code-arch drafter 在骨架完成后陷入收尾循环（25 分钟/7.48M tokens 仍涨），cancel 时核心产出已落盘（code-architecture.md + 15 骨架文件 + 机器检查 8/9）。根因推测：drafter 试图创建 review-code-arch.md 被纪律约束阻止，来回挣扎。**启示：drafter task 需更强约束「产出主交付物即停，不碰 review 文件」；主 agent 派发后应定期查 token 趋势，超 3M/10min 预警**。

## 下阶段必读

- 下阶段 SKILL：mid-detail-plan Step 5（一致性终检）→ Step 6（定稿+渲染）
- 本主题全部上游交付物（见上表 + decisions.md，均在本目录）

## mid-plan review-fix-loop 收敛记录

- **Round 1**（4 路并行：需求完整性 / 架构合理性+边界 / 禁读重建 / 红队）：禁读重建 CHANGES_REQUESTED（3 must_fix：§6 通道错位 / workspaceStore 填充时机 / cwd 失效）；其余 3 路 APPROVED。三路独立指出 §6 「global 通道」论证概念错位（HIGH-CONFIDENCE，源码铁证 routeInbound 阶段① vs 阶段②）。
- **Round 1 L6 修复**：§6 重写 / D-004 措辞澄清 / INV-6 扩展 / 加 INV-7 / §7 形态适配+debounce 归位 / AC-7.1/AC-3.2/UC-2 边界标注
- **Round 2**（2 路验证：禁读重建 + 红队）：双 APPROVED，3 must_fix 全解决，无新硬伤。4 nit 已处理（§6 阶段② 精度 / §6 两附录合并 / D-005 措辞放宽对齐 §7 方案 / §3 措辞）。
- **趋同**：`review_ensemble_overlap: high`（§6 错位 3 路同报，认知帧差异化有效）

## 不可推翻的决策

- **直接 read `decisions.md` 取 status=confirmed 且 classification=D-不可逆 的决策**（权威源，即时维护）
