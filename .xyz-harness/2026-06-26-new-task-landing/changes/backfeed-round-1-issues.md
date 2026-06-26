---
verdict: pass
source: issues.md
target: system-architecture.md, requirements.md
round: 1
entries: 2
---

# 反哺检查 Round 1 — issues.md 定稿 vs 上游

> 独立 subagent 核验。扫描③issues.md 全部决策（#1~#8 AC + 决策记录 D-7/D-A3/D-A10/D-A25/D-A26/D-A28/D-A29/D-A30/D-P1）与①requirements.md / ②system-architecture.md 的事实性矛盾。
>
> **结论摘要**: 检出 **1 项真矛盾**（D-7，②mermaid 与①+②自身散文冲突）+ **1 项评估后判定非矛盾**（D-A3，①已定义、②不同层不冲突）。**无额外未标记的上游矛盾**。

## Entry 1: D-7 createBranch 失败转移目标【真矛盾·正当反流】

| 字段 | 内容 |
|------|------|
| 涉及上游 | **②system-architecture.md §5** NewTaskFlowState mermaid 状态机图，行 `branch_modal --> branch_popover: 取消 / 创建失败`（任务标 L94） |
| 矛盾类型 | 事实性矛盾（状态机转移表） |
| 上游说什么 | ②mermaid: 创建失败时 `branch_modal → branch_popover`（落回 popover） |
| ③发现什么 | ③AC-7.3: createBranch 失败 → **留 modal 显错**（不落回 branch_popover） |
| 上游自相矛盾佐证 | ②§5 同章节「Reason 字段·失败处理」散文已写：「overlay 内失败（创建分支失败/git 读失败）：**停留在当前 overlay**，不改 flow 状态」← ②mermaid 与②自身散文冲突 |
| ①佐证③立场 | ①UC-6 异常流程 + AC-6.4: 「创建分支 git 写操作运行时失败 → **modal 显示错误提示，不关闭**，允许重试或取消」← ①是真相源，明确留 modal |
| 建议修订（②） | 拆分该 mermaid 行为两条转移，与②散文 + ①AC-6.4 对齐：<br/>`branch_modal --> branch_popover: 取消`<br/>`branch_modal --> branch_modal: 创建失败(显错，留 modal 重试)`<br/>②散文无需改（已正确）。仅修 mermaid 一行。 |
| NEEDS_USER_CONFIRM | **否**。③已标「K 用户裁决」（用户裁决留 modal，体验更好）。①UC-6/AC-6.4 也是用户拍板项。修订是让②对齐①+用户既定决策，不引入新决策。 |

## Entry 2: D-A3 首次启动 cwd【评估后·非矛盾·建议不反流①】

| 字段 | 内容 |
|------|------|
| 涉及上游 | ①requirements.md UC-1 AC-1.3 / UC-2 AC-2.2 / §7 约束 / Q2-b 决策；②system-architecture.md §4 resolveDefaultCwd / BC-2 |
| 矛盾类型 | **非事实性矛盾**（任务前提「①需回流」不成立） |
| 核验结论 | ①**早已定义**首次启动强制选目录：<br/>• AC-1.3 [边界]: 「首次启动（无任何历史 session）→ directory chip 显示空态，发送按钮 disabled 直至选目录」<br/>• AC-2.2 [边界]: 「首次启动 → 发送按钮 disabled」<br/>• §7 业务约束: 「首次启动（无历史 session）必须先选工作目录才能发送」<br/>• 决策记录 Q2-b [D-不可逆]: 「首次启动: chip 空态 + 发送 disabled（用户拍板）— 避免创建无目录坏 session」<br/><br/>③AC-1.7「resolveDefaultCwd 返回 undefined → 强制选目录」与①Q2-b**完全一致**，无矛盾。<br/><br/>②层不冲突：②BC-2 的 `cwd ?? process.cwd()` 是 **runtime 防御性默认**（session-lifecycle.ts:42），③AC-1.2 已显式「**保留**」该防御默认。③AC-1.7「不回退 process.cwd()」是**前端首次启动 UX 层**陈述（前端不发 undefined cwd，发送 disabled），与②BC-2 runtime 层正交，不冲突。 |
| 建议修订 | **①不改**（已完备）。<br/>**②可选补一行澄清**（非必须，属 gap-fill 非矛盾）：§4 resolveDefaultCwd 纯函数不变式补注「session list 为空时返回 undefined → 前端强制选目录（见①AC-1.3），不回退 runtime process.cwd()」。优先级低，不阻塞。 |
| NEEDS_USER_CONFIRM | **否**。①Q2-b 已是用户拍板的 D-不可逆决策，③只是落地实施，无新决策。 |

## 附加观察（非反流项，仅供③自纠）

- **③AC-7.3 trace 标签笔误**: 标注「trace: UC-6 AC-6.3」，但内容（createBranch 失败留 modal）对应 **①AC-6.4**（运行时失败 modal 不关闭）；①AC-6.3 实为「input 为空 → 按钮 disabled」。属③内部文档笔误，不涉及①②上游，建议③自纠为「trace: UC-6 AC-6.4」以免误导⑤/⑥。不计入 entries。

## 未检出项说明

逐上游章节核对②§1~§12 + ①全部章节，以下③决策均**无上游矛盾**（一致性确认）：
- #1 方案A（create 签名扩展）/ AC-1.2（保留 runtime 防御默认）/ AC-1.6（pi spawn 半创建态）↔ ②T1/BC-2、①UC-1 异常
- #2 方案A（独立 Landing）/ AC-2.2（非 git chip 隐藏）/ AC-2.3（乐观空判据）↔ ②§7/BC-12/§4建模G-5、①UC-7
- #3 方案A（单 composable）/ AC-3.2/3.6/3.7/3.8/3.12 ↔ ②§5/§7/Obs-B
- #4 方案A（纯函数）/ D-6 打回 T3 ↔ ②§7/D-6
- #5 方案A（popover+OS dialog）/ AC-5.3（取消落 popover）/ AC-5.7（不可读目录）↔ ②§3.4/§5、①UC-3/UC-5
- #6 方案A（popover+inline 确认+同步 getStatus）/ AC-6.2（dirty 切走留工作区）/ AC-6.3（unborn HEAD）↔ ②§3.3/§7、①UC-4/§7
- #7 方案A（modal+port 扩展）/ AC-7.1/7.2/7.4/7.5/7.8 ↔ ②§7/§6 Port、①UC-6
- #8 forkSession cwd ↔ ②BC-11
- P3 #9~#12 ↔ ①spec §6 / §8 OOS（延后项一致）
- D-A10（实例模型）/ D-A25（空 session 堆积）/ D-A26/A28/A29（WS 断连等 NFR）/ D-A30（newSessionToStandby）/ D-P1（P3 根来源）↔ ②Obs-B/§5建模G-4/BC-8，均一致或显式移交④⑤

以下③补的鲁棒性 gap（**非矛盾，按反流纪律不反流**）：
- AC-2.6 getHistory 加载失败降级 UI（②§4 仅定义加载中乐观空，未定义失败态）— ③补强，不改上游
- AC-6.2 dirty checkout 目标分支遇冲突（git 拒绝切换）的边界 — ①②均未涉，③亦未展开，留⑤
- AC-7.7 execSync hang 超时保护 — ①②未涉，③标已知风险移交④/⑤
