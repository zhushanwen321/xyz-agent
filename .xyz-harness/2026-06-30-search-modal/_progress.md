---
topic: search-modal
complexity_tier: L2
created_at: 2026-06-30
current_phase: coding
---

# 设计进度 — search-modal

**当前阶段：** 编码实现（设计工作流全部完成）
**主题目录：** `.xyz-harness/2026-06-30-search-modal/`

## 复杂度档位

**L2（标准档）**

## 已完成阶段

| 阶段 | 交付物 | 审查 |
|------|--------|------|
| ①澄清需求 | requirements.md (+.html) | ✅ APPROVED |
| ②系统设计 | system-architecture.md (+.html) | ✅ APPROVED |
| ③Issue 拆分 | issues.md (+.html) | ✅ APPROVED |
| ④非功能设计 | non-functional-design.md (+.html) | ✅ APPROVED |
| ⑤代码架构 | code-architecture.md (+.html) + code-skeleton/ | ✅ APPROVED + 骨架验证通过 |
| ⑥执行计划 | execution-plan.md (+.html) | ✅ APPROVED + 全文档一致性终检 CONSISTENT |

## 下阶段必读

- 下阶段 SKILL.md（design-execution）
- 本主题全部上游交付物（均在本目录）

## 不可推翻的决策

- 直接 read `decisions.md` 取 status=confirmed 且 classification=D-不可逆 的决策（D-001/003/004/005/006/011/012/013/016/023/026）
- **D-026 [REVISIT of #4]**：search 编排归 `composables/features/useSearch.ts`，**不新建 api/domains/search.ts**（domain 严格只调 transport+pending 铁律不变）

## 搭便车候选（待⑤骨架验证确认）

1. Sidebar keydown 接入命令注册表（#10，P2）—— ⑤骨架已确认工作量可控（D-004 消除硬编码）
2. scrollIntoView → scrollIntoViewIfNeeded（#10，P2）—— ⑤骨架已确认（BC-7 spec 合规）

> debounce(120ms) 已按 D-020 从 #10 提前到 #7（P1），不再属搭便车候选。

## ④NFR 阶段产出（反哺上游）

- 新建 issue #17 [P1]：WS 源超时 race（防 WS 断连浮层挂死，D-023）
- #4 新增 AC-4.10：缓存失效竞态防护（domain 自绑 setupInvalidation watch）
- #6 新增 AC-6.9：file 跳转吞错层防护（直调 fileApi.read 不经 useDetailPane 吞错层，D-024）
- AC-4.7 校正：MAX_SEARCH_RESULTS 500→5000（D-021，事实性反哺，已同步①requirements）
- 14 条缓解项回灌（⑤test-matrix 5 / ⑤骨架约束 2 / ③已覆盖 4 / ③待落 4 含 #17）
- 4 项残余风险接受（localStorage 配额满 / 大仓库截断 / session.list 耗时 / toast 脱敏）
- 5 项需⑤骨架验证副作用（loadSeq 迁移 / debounce+loadSeq 协同 / allSettled 单源静默 / WS 超时 race / close 孤儿查询守卫）

## ⑤code-arch 阶段产出（反哺上游）

- **D-026 [REVISIT of #4]**：search 编排归 composable（非 domain），不新建 api/domains/search.ts。理由：编排跨 commandStore+fileSearchStore 违反「domain 严格只调 transport+pending」铁律，归 composable 与 useSidebar/useFileSearch 同层一致。#5 性质从「三元切换 real domain」改为「删除 search 导出 + 改调 useSearch」
- 16 个 test-matrix gap 闭环（重建帧发现）：UC-1 交互防线补全（唤起聚焦/↑↓导航/Tab切类/视觉态/三种关闭/高亮/reload持久化）+ DTO 映射用例（相对路径/gitBranch降级）+ stale cache 防护 + 自检假性 PASS 修正（Tab切类本期 IN SCOPE 非 P2 延后）
- 骨架验证（Step 7）：6 模块骨架（match-engine/useSearch/useCommandRegistry/useSearchJump/useRecents/command store 扩展），renderer vue-tsc 零错误，调用链 Level 1 接线可达，无类型逃逸，orphan 0
- 反哺①-④：25 处 "search domain → useSearch composable" 表述同步（backfeed-round-2.md），4 上游 frontmatter 标 backfed_from: [code-arch]
- Wave 依赖 DAG：Wave1(P0: #1/#2/#3) → Wave2(P1: #4含#17/#5/#6/#7含#8) → Wave3(P2: #9/#10)

## ⑥execution 阶段产出（反哺上游 + 一致性终检）

- **D-027**：5-Wave 细化（⑤§8 的 3-Wave 粗粒度 → 5-Wave 工程细化），D-可逆 agent-opinionated。Wave1 P0 基础设施 3 并行 → Wave2 P1 编排层 #4‖#6 2 并行 → Wave3 P1 UI 集成 #7+#5+#8 单切片 → Wave4 P2 增强 #9+#10 串行 → Wave5 验收 Gate
- **关键合并**：#17→#4（withWsTimeout 同文件）/ #5→#7（消费链原子性）/ #8→#7（loading/error 同文件）
- **测试验收清单 47 条** = ⑤test-matrix 全量（来源 A 40 + 来源 B 7），末尾验收 Wave5 blocked_by Wave1-4
- **无 Prefactor Wave / 无性能混沌 Wave**（判定充分，④全部缓解项验收方式分布已核）
- **追踪闭环**：Round 1 发现 8 gap（DAG 图 3 F + T4.8 桩提示 1 K + ⑤§4 错位 ID 3 F + T2.5 措辞 1 F），全修订；收敛复核 CONVERGED
- **反哺①-⑤**：⑤code-arch §4 异常路径表 11 个错位 ID 回流修正（GAP-TC-1/2/3）+ ⑤§3 签名表漂移修正（useRecents.read RecentEntry[] / matchFilter 泛型）+ ⑤§1 search-types.ts 登记 + ⑤§2 包图补边 + ④NFR 13 处 domain→composable 清扫 + ②§7 三处路径补 features/ + AC-1.4 指针补
- **一致性终检 CONSISTENT**：4 组并行审计（术语/全链追溯/决策守护/落地）发现 20 处矛盾，19 处修订 + 3 处接受（C5 连字符/C8 Section/C9 D-003 历史值，不阻塞编码）
- **机器检查**：6 阶段全 PASS（修订后重跑 ①7/7 ②9/9 ③9/9 ④8/8 ⑤8/8 ⑥8/8）
- design-status: complete-phase execution → 「阶段 execution 已 completed（gate 校验通过）。全流程完成」
