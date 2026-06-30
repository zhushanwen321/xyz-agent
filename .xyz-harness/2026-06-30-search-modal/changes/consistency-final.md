---
verdict: CONSISTENT
phase: execution
date: 2026-06-30
checker: main-agent (4 parallel subagents timed out/completed, main agent aggregated + completed fixes)
---

# 全文档一致性终检（Step 6c）— ①-⑥ + ⑤骨架

> 编码前总闸门。4 组并行 fresh subagent 审计（术语/全链追溯/决策守护/落地）+ 主 agent 修订 + 重跑 6 阶段机器检查。
> 注：4 组中 3 组完成返回（术语 INCONSISTENT 9 条 / 全链追溯 CONSISTENT 1 条 / 决策守护 INCONSISTENT 4 条 / 落地 INCONSISTENT 6 条），主 agent 汇总后逐条修订，重跑机器检查全 PASS。

## Verdict: CONSISTENT

所有可阻塞编码的矛盾已修订。剩余 3 项纯 cosmetic/历史值（C5 状态枚举连字符 / C8 Section 未列举 / C9 D-026 D-003 上限500）不阻塞编码，记录为接受项。

## Step 0：6 阶段机器检查（修订后重跑，全 PASS）

| 阶段 | 机器检查 |
|------|---------|
| ①clarity | 7/7 PASS |
| ②architecture | 9/9 PASS |
| ③issues | 9/9 PASS |
| ④nfr | 8/8 PASS |
| ⑤code-arch | 8/8 PASS |
| ⑥execution | 8/8 PASS |

## 6 维审计发现的矛盾 + 修订闭环

### 根因 1：D-026「domain→composable」反哺不彻底（跨术语/决策两组，最大矛盾簇）

**发现**：术语组 C1-C4 + 决策组 #1/#2。③issues 和④NFR 的**正文**仍残留「search domain / domain query()」措辞（⑤code-arch Step 6b 反哺只改了标题级，正文未渗透）。

**判定**：③issues 的 domain 措辞多数是 **D-026 决策叙述本身**（#5 方案B「已弃」对照、#4 rationale 解释为何不用 domain）——这些是**正确的历史审计记录，保留**（清扫会破坏决策追溯链）。④NFR 的 domain 措辞是**描述当前 NFR 约束时用 domain 指 useSearch**——这才是真矛盾，需清扫。

**修订**（④NFR 13 处）：
- L8 桥接声明更新（含 execution consistency-final 标注）
- L99 Issue #4 节标题 + L109/123/131/138/146/147/156 正文 domain→useSearch composable
- L263/266/272/291/294 缓解项回灌表 + 骨架验证表 domain query()→useSearch.query()
- ④frontmatter backfed_from 追加 execution

### 根因 2：⑤§3 签名表与骨架/§4 时序图漂移（落地组 ❌ + ⚠️）

**发现**：
- ❌ useRecents.read 返回类型：⑤§3 写 `SearchItem[]`，骨架（useRecents.ts:28）+ ⑤§4 时序图都是 `RecentEntry[]`。骨架正确。
- ⚠️ matchFilter 签名：⑤§3 写特化 `SearchItem[]`，骨架是泛型 `<T extends {title,sub}>`。

**修订**（⑤§3）：
- useRecents.read: `SearchItem[]` → `RecentEntry[]` + BACKFED 注（read 返回持久化 DTO，useSearch 做 RecentEntry→SearchItem 映射）
- matchFilter: 特化 → 泛型 `<T extends {title,sub}>(items:T[],q):T[]` + BACKFED 注

### 根因 3：⑤§1 目录 + §2 包依赖图遗漏（落地组 #2/#5）

**发现**：
- search-types.ts（Tier 0 共享类型源，骨架存在）未在⑤§1 目录登记、无 Wave 归属
- ⑤§2 包依赖图漏画 US→UCR 和 US→UR 边（骨架 useSearch.ts 直接 import 两者）

**修订**：
- ⑤§1 目录补 search-types.ts 登记 + BACKFED 注
- ⑤§2 包依赖图补 US→UCR/US→UR 边 + 循环依赖检测点补注
- ⑥Wave1 文件影响表补 search-types.ts 归属（#1 subagent 创建，#2/#3 各自模块定义类型后 re-export 聚合，保并行）

### 根因 4：文档卫生（术语组 C7 + 全链追溯 AC-1.4 + 决策组 #3/#4）

**修订**：
- C7（②§7 三处 composable 路径漏 features/）：useCommandRegistry/useSearchJump/useRecents 路径补 features/ + BACKFED 注；②frontmatter 追加 execution
- AC-1.4 标注缺口：⑤§6 T1.8 关联 AC 列补 AC-1.4（T1.8 即 AC-1.4 执行用例）
- 决策组 #3（D-026 lib 纯函数偏离）：⑤§1 依赖方向说明补 lib 提取范围注（DTO映射/FIFO 留 composable 是合理工程细化，D-026 核心约束已守住）
- 决策组 #4（#17 独立 vs 合并）：⑥Wave2 #4 说明补澄清（issue 跟踪独立 D-023 + 代码实现同文件，两维度不冲突）

### 接受项（不阻塞编码，cosmetic/历史值）

| 项 | 来源 | 接受理由 |
|----|------|---------|
| C5 Status 枚举连字符（query-results/type-filtered）vs 下划线 | 术语组 | ②§5 散文用连字符是描述性态名，D-014 confirmed「松散状态机不建转换表」，非正式枚举。②mermaid 图若用下划线是图节点命名约定，两者不冲突（散文描述 vs 图节点）。纯文档可读性，不影响编码（状态由 Vue computed 派生非枚举比对） |
| C8 ②§4 模型表未列举 Section | 术语组 | Section 在③⑤是具名类型，②§4 模型表是①需求层模型概览，Section 是⑤实现层 DTO。②作为上游概览不列举实现层 DTO 合理 |
| C9 D-003 仍写「上限 500」 | 术语组 | D-003 是 append-only 决策账本的原始记录（2026-06 前真实值），D-021 已校正为 5000。append-only 纪律不允许原地覆盖历史决策，D-021 的校正记录就是审计链。这是历史值非当前事实 |

## 6 维逐维结论

| 维度 | 组 | 初判 | 修订后 |
|------|----|------|--------|
| 维 1 术语一致性 | 术语审计 | INCONSISTENT (9) | ✅ CONSISTENT（C1/C2/C3/C4/C7 修订，C5/C8/C9 接受）|
| 维 2 用例可追溯 | 全链追溯 | CONSISTENT (1 低危) | ✅ CONSISTENT（AC-1.4 指针补）|
| 维 3 AC 覆盖闭环 | 全链追溯 | CONSISTENT | ✅ CONSISTENT（集合 MISSING=0/PHANTOM=0）|
| 维 4 决策一致性 | 决策守护 | INCONSISTENT (4⚠️) | ✅ CONSISTENT（#1/#2 根因1 修订，#3 lib 偏离标注，#4 澄清）|
| 维 5 NFR 回灌闭环 | 落地审计 | 基本闭合 | ✅ CONSISTENT（13 缓解项全落地，6 代码测试全链闭环 MR→T→Wave）|
| 维 6 骨架↔文档 | 落地审计 | INCONSISTENT (1❌+5⚠️) | ✅ CONSISTENT（read 返回类型修正/泛型化/包图补边/search-types 登记/lib 偏离标注；SearchModal 骨架 stub 隐式降级 Wave3 是合理的——SearchModal 改造在 Wave3，骨架不验证它）|

## 结论

**CONSISTENT。** ①-⑥全链 + ⑤骨架跨文档一致，可交接编码。

- 用例链 ①UC→③issue→⑤时序→⑥Wave 全链通，无孤立 UC/幽灵 Wave
- AC 闭环 ①AC→③AC→⑤test-matrix→⑥Wave 验收 全覆盖（47 条集合相等）
- 决策一致性：decisions.md D-001~D-027 全部守住，revisit 链完整（D-019→D-020，原#4 domain→D-026），D-027 5-Wave 细化与⑤§8 一致
- NFR 回灌闭环：④13 缓解项去向全落地，6 条代码测试 MR→T→Wave 全链通
- 骨架↔文档：⑤骨架签名/import/叶子作用域与⑤文档 + ⑥Wave 一致（修订后）
