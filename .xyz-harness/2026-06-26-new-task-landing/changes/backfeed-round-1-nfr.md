---
verdict: pass
source: non-functional-design.md
target: requirements.md, system-architecture.md, issues.md
round: 1
entries: 1
needs_user_confirm: 0
---

# ④NFR 反哺检查 Round 1 — non-functional-design.md 定稿 vs 上游

> 独立 subagent，上下文隔离。逐上游核对 ④定稿是否引入与 ①②③ 已拍板事实/决策矛盾。
> 结论速览：**无强制反哺矛盾，可交接**。4 个关键检查点全 PASS。仅 1 条非阻塞措辞细化项（③ AC-7.7，AC 结论已由 ④保全、且 ④已自带修正记录，可选追溯标注）。

## 逐上游核对

### ① requirements.md

- **UC-6（createBranch）vs ④ D-NFR3 审计降级**：①UC-6 AC-6.1~AC-6.4 + §8 Out of Scope 全文无「审计日志」要求；④ D-NFR3「v1 仅结构化日志，审计移后续」不推翻任何 ①AC，属 ④自决降级（单用户桌面审计价值有限）。✅ **不矛盾**
- **UC-4（dirty 切走）vs ④ Issue #6 数据一致性**：①§7 约束「切走 dirty 分支 v1『留在工作区』不自动 stash」；④ Issue #6 回滚策略「v1 选留在工作区（不 stash）」完全一致。✅ **不矛盾**
- **§3 数据清单「未提交改动 dirty … 不缓存」vs ④ D-NFR2（getStatus 独立缓存）**：①明确 dirty「按需实时读，不缓存」；④ 缓存为「条件性待落（依赖⑤骨架 P99>200ms 触发）」，默认不缓存与 ①一致，条件触发是性能优化非行为推翻。✅ **不矛盾**
- **§3 数据清单「分支信息 … 带 TTL 缓存」vs ④ G1（readGitInfo 独立缓存）**：①描述的「带 5min TTL 缓存」正是 readGitInfo（branch 元信息），④ 证实该缓存仅含 branch/isWorktree、不含 dirty，与 ①描述一致。✅ **不矛盾**

### ② system-architecture.md

- **§10 D-5（git 服务维持分离不合并）vs ④ G1（getStatus 与 readGitInfo 独立路径）**：②D-5 已裁定 git-info(读 branch) 与 GitService(status) **职责正交、不合并**；④G1 源码核实两者是两条独立路径（execSync readGitInfo vs IGitExecutor port getStatus）、无共享缓存、数据类型不同。④G1 **印证并支撑** ②D-5 的分离结论，非推翻。✅ **不矛盾（反而强化）**
- **§6 Port 清单（GitService 经 IGitExecutor）vs ④ G2（createBranch 经 port 继承 8000ms 超时）**：②已确立 GitService 走 IGitExecutor port；④源码核实 port（`infra/git-executor.ts:18` execFileSync timeout=8000ms）createBranch 直接复用。与 ②Port 定位一致。✅ **不矛盾**
- **§12 BC-6（git-info/readGitInfo 已接入显示）vs ④ G1（readGitInfo 无 dirty 数据）**：②BC-6 说 readGitInfo 提供 branch/isWorktree；④证实 readGitInfo 缓存仅含 {branch,isWorktree} 不含 dirty——dirty 走 getStatus 独立路径。与 ②BC-6 行为保持一致。✅ **不矛盾**

### ③ issues.md

- **AC-6.6「dirty 数据复用 GitService.getStatus（BC-6 同源）」vs ④ D-NFR2「getStatus 独立缓存」**【关键检查点 1】：③「同源」语义 =「同走 GitService，不另起 git 调用」（指数据源同一 service），非「同走缓存」。④ D-NFR2「getStatus 需新建自己的 per-cwd 缓存，不与 readGitInfo 合并」是对缓存的独立决策，**不否定**③「复用 getStatus」——缓存 getStatus 结果不构成「另起 git 调用」。两者正交。✅ **不矛盾**（④ D-NFR2 已显式说明「同源指同走 GitService 非同走缓存」，消解了潜在误读）
- **AC-6.8「getStatus 无缓存，v1 可接受，若性能问题④评估加缓存」vs ④ D-NFR2**：④已评估，缓存放「条件性待落（P99>200ms 触发）」+ 若加则独立新建。与 ③「④评估加缓存」授权一致。✅ **不矛盾**
- **AC-7.7「createBranch execSync 需超时包装，execSync 无原生超时是已知风险，具体包装属⑤」vs ④ G2 修正**【关键检查点 2 见下矛盾清单】：④源码核实 createBranch 经 IGitExecutor port 已继承 8000ms 超时，无需另加包装。
- **Q2 用户决策（git 全同步）vs ④ 残余风险「~40-50ms 阻塞接受」**【关键检查点 4】：④ D-NFR1 3 档方案（A 保持同步/B 读异步写同步/C 全 worker_threads）用户选 A；④残余风险「~40-50ms 阻塞对单用户桌面可接受」直接承接 ③ Q2「git 全同步」决策，监控 P99>200ms 告警作逃生口。✅ **不矛盾（与 Q2 一致）**
- **D-7（createBranch 失败留 modal）vs ④ Issue #7 稳定性**：④ Issue #7 故障场景「createBranch 失败留 modal 显错（AC-7.3，D-7 决策）」完全保持 ③D-7 裁决。✅ **不矛盾**

## 矛盾清单

### Entry 1：③ AC-7.7 超时实现措辞 vs ④ G2 源码事实【非阻塞·可选追溯标注】

| 字段 | 内容 |
|------|------|
| 涉及上游 | **③issues.md #7 AC-7.7**：「v1 用 `execSync` + 超时包装（如 child_process timeout）…『execSync 无原生超时』是已知风险，具体包装实现属⑤，NFR④评估阻塞影响」 |
| ④ 事实（G2 修正，源码核实） | createBranch 实际经 **IGitExecutor port**（`infra/git-executor.ts:18` execFileSync `timeout=8000`），**已继承 8000ms 超时，无需另加包装**；git-info.ts 另有 `GIT_TIMEOUT_MS=2000`（未导出，与 port 8000 不混淆） |
| 矛盾类型 | 设计假设被下游源码证伪（实现路径假设）。③ AC-7.7 隐含「createBranch 直走 execSync、需手动包装超时」；④ 源码核实实际走 port 已自带超时 |
| AC 结论是否被推翻 | **否**。③ AC-7.7 的验收结论（createBranch 需超时保护 + 超时后 modal 显错「git 操作超时」）被 ④ **完全保全**——port 的 8000ms 超时即满足该 AC。仅实现方法（execSync+手动包装 → port 复用）被细化 |
| 是否已在 ④ 自闭合 | **是**。④ Issue #7 并发控制 + 缓解项回灌表「createBranch 经 IGitExecutor port 已继承 8000ms 超时（无需另加包装）」已完整记录修正，⑤ 读 ④ 不会被误导 |
| 与 ② 自洽性 | ②§7 + ③AC-7.4/AC-7.5 已确立 GitService 走 IGitExecutor port；③AC-7.7「execSync+包装」与 ③自身 AC-7.4/7.5（port 扩展）有内在措辞张力，④源码核实消解之 |
| 建议修订（可选，非强制） | 在 ③ AC-7.7 末尾追加：`[BACKFED from ④nfr on 2026-06-26] 源码核实：createBranch 经 IGitExecutor port（execFileSync timeout=8000ms）已自带超时，无需另加包装；④已闭合`。目的仅为链路措辞洁净，避免 ⑤ 隔离读 ③ 时重复包装 |
| NEEDS_USER_CONFIRM | **否**。属源码事实核对（agent 自决可逆），非 D-不可逆决策；AC 结论未变 |

> 其余核对项均无矛盾。4 个关键检查点结论：
> - CP1（getStatus 独立缓存 vs AC-6.6 同源）→ **不矛盾**（同源=同走 GitService 非同走缓存）
> - CP2（G1 独立路径是否推翻②/③）→ **不矛盾**（印证②D-5 分离，未推翻任何结论）
> - CP3（D-NFR3 审计降级 vs ①AC）→ **不矛盾**（①无审计要求）
> - CP4（~40-50ms 阻塞 vs ③Q2）→ **不矛盾**（直接承接 Q2 全同步决策）

## 结论

**无强制反哺矛盾，可交接。** 4 个关键检查点全部 PASS。

仅 1 条非阻塞项（③ AC-7.7 超时实现措辞）：AC 验收结论已由 ④保全，④自身已闭合修正记录；建议对 ③ AC-7.7 做可选追溯标注以保持链路措辞洁净，**非必须**（⑤ 读 ④ 不会被误导）。无 NEEDS_USER_CONFIRM。
