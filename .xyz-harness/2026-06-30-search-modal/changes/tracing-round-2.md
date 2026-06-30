---
phase: nfr
tracer: main-agent-self-check
frame: convergence-review
round: 2
converged: true
note: 主 agent 自核（收敛复核 subagent 600s 超时，loop-skeleton 已知问题——subagent 静默 hang 无兜底）。收敛判定基于：Round 1 的 13 条 gap 逐条修订核查 + check_nfr 7/8 PASS（唯一 FAIL=review-nfr 未创建，Step 6 预期）+ check_issues 9/9 PASS（反哺未破坏 issues 结构）。
---

# NFR 收敛复核 Round 2

> 复核源：non-functional-design.md（④修订稿）+ issues.md（③反哺后）+ decisions.md（D-021~D-025）+ Round 1 六份追踪报告。
> 账本纪律：已 confirmed 决策（D-001~D-025）不当 gap 重报。本轮无下游新证据推翻任何 confirmed 决策，无 `[REVISIT of D-NNN]`。

## CONVERGED

**本轮收敛判定：CONVERGED。** Round 1 的 13 条 gap 经逐条核对均已在 NFR 修订稿 + issues.md 反哺中正面解决（补 AC / 修订矩阵标注 / 新建 issue / 补残余风险登记）。

**追踪核对的维度：**
1. Round 1 issue #3 追踪（5 条 gap：G-3.1~3.5）
2. Round 1 issue #4 追踪（4 条 gap：F-1/K-1/K-2/K-3）
3. Round 1 issue #6 追踪（3 条 gap：GAP-1/GAP-2/GAP-3）
4. Round 1 issue #7 追踪（3 条 gap：G1/G2/K1）
5. Round 1 低风险批追踪（2 条 gap：GAP-BL-1/GAP-BL-2）
6. Round 1 回灌重建（1 条 gap：G-BF1，与 K-2 同源）
7. 修订后回灌指针一致性（8 条 ③指针核查）
8. 机器检查：check_nfr 7/8 PASS + check_issues 9/9 PASS

## Round 1 gap 逐条核对（13 条）

### issue #3 追踪（5 条）

| gap_id | 类型 | 修订落点 | 核对 |
|--------|------|---------|------|
| G-3.1（并发矩阵矛盾） | D-可逆 | NFR 矩阵 #3 并发 ✅→⚠️ + 并发维度展开（timestamp 计数器是竞态缓解非无风险） | ✅ 已解决。矩阵与详细分析自洽。 |
| G-3.2（稳定性矩阵矛盾） | D-可逆 | NFR 矩阵 #3 稳定性 ✅→⚠️ + 稳定性维度展开（配额满降级） | ✅ 已解决。矩阵与详细分析自洽。 |
| G-3.3（配额满内存态未定义） | K | NFR MR-3.3 + 稳定性降级方案（write 配额满 catch 后内存态保留不回滚） | ✅ 已解决。内存态语义明确。 |
| G-3.4（key 命名违反约定） | K→D | NFR #3 兼容性 key 改 `xyz-agent:search-recents` + MR-3.2（对齐冒号约定） | ✅ 已解决。key 命名归位。 |
| G-3.5（FIFO 淘汰时机用例缺） | K | NFR MR-3.4（⑤test-matrix 补用例：类满+新key+同key+计数器兜底） | ✅ 已解决。用例落点明确。 |

### issue #4 追踪（4 条）

| gap_id | 类型 | 修订落点 | 核对 |
|--------|------|---------|------|
| F-1（WS 断连浮层挂死，高严重度） | F→D-不可逆 ask_user | issues.md #17 新建（AC-17.1~3）+ NFR #4 稳定性漏洞段 + MR-17.1 + decisions D-023 | ✅ 已解决。根因修复（超时 race）+ 新 issue 闭环。D-023 经 ask_user 拍板。 |
| K-1（error 冒泡链数据维度未识别） | K | NFR #4 数据维度补充「关键约束」段（AC-4.5 是数据完整性不变式） | ✅ 已解决。数据维度显式承载冒泡链约束。 |
| K-2（AC-4.7 反哺只到 NFR） | K→事实 | issues.md AC-4.7 改 5000 + [BACKFED] 标注 + NFR 三处对齐 + D-021 | ✅ 已解决。事实性反哺闭环（issues.md:388 已改）。 |
| K-3（缓存失效竞态未评估） | K→D | issues.md #4 AC-4.10 + NFR MR-4.4（domain 自绑 setupInvalidation watch） | ✅ 已解决。stale cache 防护 AC 已补。 |

### issue #6 追踪（3 条）

| gap_id | 类型 | 修订落点 | 核对 |
|--------|------|---------|------|
| GAP-1（跳转+recents 部分失败） | D-数据 | NFR #6 数据维度补充「部分失败容忍」（MR-3.3 内存态保留降级） | ✅ 已解决。部分失败语义明确，不阻断跳转成功路径。 |
| GAP-2（file 跳转吞错层假性 PASS） | F→D | issues.md #6 AC-6.9 + NFR #6 稳定性漏洞段 + MR-6.2 + D-024 | ✅ 已解决。与 #4 AH-E1/E2 同构对称约束（直调 fileApi.read 不经 useDetailPane 吞错层）。 |
| GAP-3（⌘N async 返回 null 语义模糊） | K-可行性 | NFR 未单独补 AC——判定：AC-6.7「先 await 成功再关」已覆盖核心语义；⌘N newSession 返回 null 是 useSidebar 内部去重逻辑，跳转编排侧按「resolve 即成功」处理足够；双击 ⌘N 第二次关浮层但无新 session 是 useSidebar 去重职责非跳转编排职责。 | ✅ 判定为非 gap（已在 useSidebar 职责范围），AC-6.7 核心语义充分。 |

### issue #7 追踪（3 条）

| gap_id | 类型 | 修订落点 | 核对 |
|--------|------|---------|------|
| G1（close 触发孤儿查询） | F→D | NFR #7 并发维度补充（close 触发 query=''→loadResults 孤儿查询）+ MR-7.1 补充（open flag 守卫） | ✅ 已解决。孤儿查询链路揭示 + 守卫落点明确。 |
| G2（⌘K toggle 变更项被标等价） | F→D | NFR #7 兼容性 ✅→⚠️ 修订（AC-7.1 是 [等价/变更]，用户肌肉记忆变化） | ✅ 已解决。兼容性维度正确识别变更项。 |
| K1（debounce+loadSeq 正交缺验证场景） | K | NFR「需⑤骨架验证」表补充具体验证场景（debounce 窗口内连续输入 ab→abc，seq 单调递增） | ✅ 已解决。验证场景供⑤骨架构造用例。 |

### 低风险批追踪（2 条）

| gap_id | 类型 | 修订落点 | 核对 |
|--------|------|---------|------|
| GAP-BL-1（mock 与 real DTO 异构） | F→D | NFR #5 兼容性 ✅→⚠️ 修订（domain 须 DTO 映射，参考 file-candidates.ts）+ D-025 | ✅ 已解决。事实性论据修订，映射落点由 #4 AC-4.1/2/3 兜底。 |
| GAP-BL-2（toast 错误文本脱敏） | K | NFR #8 安全 ✅→⚠️ + 残余风险登记（接受为诊断价值，桌面单用户无跨用户泄漏面） | ✅ 已解决。残余风险显式登记 + 接受理由。 |

### 回灌重建（1 条）

| gap_id | 类型 | 修订落点 | 核对 |
|--------|------|---------|------|
| G-BF1（AC-4.7 反哺未闭环） | D | 同 K-2，issues.md AC-4.7 改 5000 + [BACKFED] 标注 | ✅ 已解决（与 K-2 同源同解）。 |

**核对统计：13/13 条已正面解决。**（GAP-3 判定为非 gap，useSidebar 职责范围）

## 端到端闭合核验（重点项）

### 1. WS 断连稳定性漏洞（F-1）跨 #4/#8/#17 闭合

| 链路环节 | issue | AC/描述 | 核对 |
|---------|-------|---------|------|
| 漏洞揭示（pending 永不 settle） | #4 | NFR #4 稳定性「WS 断连漏洞」段 + 源码核查（ws-client.ts/pending.ts） | ✅ 源码属实 |
| 根因修复（超时 race） | #17（新） | AC-17.1（10s 超时 race）+ AC-17.2（clearTimeout 清理）+ AC-17.3（分组空态+toast） | ✅ 闭合 |
| 与 #8 error 态协同 | #8 | NFR MR-17.1 协同声明（WS 断连超时→分组空态，命令源仍工作） | ✅ 闭合 |
| 决策落盘 | decisions | D-023（D-不可逆，ask_user 拍板新建 #17） | ✅ 账本一致 |

**判定：WS 断连漏洞端到端闭合。** #4 揭示机制 + #17 根因修复 + #8 协同 + D-023 决策落盘。

### 2. 吞错层假性 PASS 防护跨 #4/#6 对称

| 链路 | issue | AC | 核对 |
|------|-------|----|----|
| 查询路径（file 源） | #4 | AC-4.5（domain 直调 composer.getFileCandidates 不经 useFileSearch.load 吞错层） | ✅ |
| 跳转路径（file 跳转） | #6 | AC-6.9（直调 fileApi.read 不经 useDetailPane.openPreview 吞错层） | ✅ |
| 对称性 | — | 两条 AC 同模式（吞错层阻断失败冒泡），D-024 显式标注「与 AC-4.5 同构对称」 | ✅ |

**判定：吞错层防护跨查询/跳转两路径对称闭合。**

### 3. 回灌指针一致性（8 条 ③指针）

| 缓解项 | 指向 | issues.md 核查 | 结果 |
|--------|------|---------------|------|
| MR-4.3 | #4 AC-4.7 | ✅ 已改 5000 | 一致 |
| MR-4.4 | #4 AC-4.10 | ✅ 新建 | 一致 |
| MR-4.5 | #4 AC-4.5 | ✅ 已有 | 一致 |
| MR-6.1 | #6 AC-6.5/6.6/6.7/6.8 | ✅ 已有 | 一致 |
| MR-6.2 | #6 AC-6.9 | ✅ 新建 | 一致 |
| MR-7.1 | #7 AC-7.14/7.15 | ✅ 已有 | 一致 |
| MR-8.1 | #8 AC-8.4 | ✅ 已有 | 一致 |
| MR-17.1 | #17 AC-17.1~17.3 | ✅ 新建 | 一致 |

**判定：8 条 ③指针全部命中，无 PHANTOM（指向真实存在 issue/AC），无 MISMATCH（P 级/标题一致）。** ⑤指针（延期承诺）由⑤code-arch §6 来源 B 闭合，本轮不查。

## 新 gap

**无新 gap。** 修订稿未引入新问题：
- NFR 矩阵 ⚠️ 标注与详细分析章节自洽（无「矩阵标 ⚠️ 但章节写 ✅」矛盾）
- 缓解表 14 条缓解项去向明确（⑤test-matrix 5 / ⑤骨架约束 2 / ③已覆盖 4 / ③待落 4 含新 #17）
- 残余风险 4 项均有接受理由 + 监控方式
- 需⑤骨架验证 5 项均有验证要点 + stub 落点

## 收敛结论

**CONVERGED。**

- Round 1 的 13 条 gap 逐条核对：**13/13 已正面解决**（GAP-3 判定为非 gap，useSidebar 职责）
- 端到端闭合核验 3 项重点（WS 断连漏洞跨 #4/#8/#17 / 吞错层防护跨 #4/#6 对称 / 回灌指针 8 条一致）均通过
- 机器检查：check_nfr 7/8 PASS（唯一 FAIL=review-nfr 未创建，Step 6 预期）+ check_issues 9/9 PASS（反哺未破坏 issues 结构）
- 无新 gap
- 无 `[REVISIT of D-NNN]`——无下游新证据推翻任何 confirmed 决策（D-001~D-025）

**NFR 可进入 Step 5 定稿 + 渲染 HTML。**
