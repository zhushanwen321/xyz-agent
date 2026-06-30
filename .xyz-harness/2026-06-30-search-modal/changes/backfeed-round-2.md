---
phase: code-arch
backfeed_target: [requirements, system-architecture, issues, non-functional-design]
verdict: SYNCED
entries: 25
date: 2026-06-30
---

# ⑤code-arch → ①-④ 反哺报告 — Round 2

> D-026 [REVISIT of issues #4] 将 search 编排从 `api/domains/search.ts`（domain）迁到 `composables/features/useSearch.ts`（composable）。
> 上游①-④在 D-026 前写就，残留 "search domain / api/domains/search.ts / domain query()" 表述，本轮做事实性同步。
> （Round 1 是 nfr 阶段反哺 AC-4.7 500→5000，见 backfeed-round-1.md，本文件是 code-arch 阶段的独立反哺）

## 反哺纪律遵守

- [x] 只改 D-026 影响的事实性表述（编排归属层：domain → composable）
- [x] 不推翻任何 confirmed 决策（D-001~D-025 不动；D-011/D-012/D-013 不变——D-026 只改编排归属层，不动这些）
- [x] 每处反哺加 `[BACKFED from code-arch on 2026-06-30]` 标记（D-026）
- [x] 被反哺文件 frontmatter 加 `backfed_from: [code-arch]`
- [x] 只改内容不改 phase 状态（verdict/current_phase 不动）
- [x] AC 数量不减少（只改措辞；#5 重写但 AC-5.1/5.2/5.3 保留并修订）

## 反哺明细

### requirements.md（3 处，subagent 完成）
- G2 行：「新建 search real domain」→「新建 useSearch composable」
- F9 行：同步
- frontmatter backfed_from 追加 code-arch

### system-architecture.md（9 处，subagent 完成）
- 统一语言表 search real domain 条目
- 层级图 SD 节点（search real domain → useSearch composable）
- §7 模块表 search real domain 行（位置 api/domains/search.ts → composables/features/useSearch.ts）
- §9 swimlane SD participant
- §10 特化决策措辞
- BC-5 源码位置引用
- frontmatter backfed_from: [code-arch]

### issues.md（17 处，subagent + 主 agent 补 #5/#17）
- #4 标题/描述（subagent）：search real domain → useSearch composable
- **#5 完整重写（主 agent）**：性质从「三元切换 real domain」改为「删除 search 导出 + 改调 useSearch」（D-026 后 search 无 WS domain）；方案 A/B 重写；AC-5.1（grep 验收）改为验证 search 导出删除 + SearchModal 改调 useSearch；AC-5.2 改为 useSearch 内部判 VITE_MOCK
- #17 方案 A（主 agent）：domain query() → useSearch.query()
- DAG 节点标签、P0/P1 覆盖核验表（subagent）
- #4 AC-4.4/4.5/4.9/4.10 措辞（subagent）
- frontmatter backfed_from 追加 code-arch

### non-functional-design.md（影响说明段，主 agent）
- frontmatter backfed_from: [code-arch]
- 顶部加 D-026 影响说明段：NFR 分析全部有效（编排层归属变化不改风险本质），文中 "search domain / domain query()" 措辞统一理解为 "useSearch composable / useSearch.query()"
- #5 兼容性 DTO 映射论点不变（real 源异构 DTO → SearchItem，由 useSearch 内部做）

## 无法反哺的矛盾

无。D-026 是 confirmed [REVISIT]，所有上游表述都做了事实性同步，无与 D-026 矛盾且无法调和的内容。骨架物理验证（Step 7）未证伪②的分层/领域边界——D-026 反而**修正**了②「search real domain」与「domain 严格只调 transport+pending」铁律的隐性矛盾（编排跨 store 的 domain 本就违反铁律，D-026 把编排归位 composable 后铁律重新自洽）。

## 收敛判定

**SYNCED** — 25 处反哺完成，4 个上游 .md frontmatter 均标 backfed_from 含 code-arch。结构检查（check_issues.py）反哺后通过。
