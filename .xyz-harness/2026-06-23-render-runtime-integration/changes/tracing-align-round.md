# Issues 对齐追踪报告 — Align Round（上游 06-25 反哺对齐）

> 独立 subagent 隔离追踪产出（fresh context）
> 追踪输入：requirements.md（06-25）、spec-w11.md（06-25）、system-architecture.md、code-architecture.md、issues.md（06-24，被追踪对象）、tracing-round-14.md
> 触发：skill Step 6b「反哺触发上游修订 → 回 Step 2 重追踪」。上游 06-25 新增 C11-C15、精简 FR-12、修正 FR-3/FR-4，issues.md 停在 06-24，需对齐。
> 视角：①覆盖性（F1-F12 + C1-C15）②方案完整性 ③优先级一致性 ④前沿清晰度 + 跨文档矛盾核查

## 结论：需补充 gap（未收敛）

issues.md 主体仍有效（13 个 issue 结构、P 级、blocked_by、方案对比全部成立；Round 14 的 M-03 已彻底清理——#8/#12 三处 body 文本 pending 矛盾全部回填 [STALE]，内部自洽）。但 **06-25 上游新增的 C12/C13/C14 三项决策未下沉为 issues.md 验收项**，implementer 据当前 issues.md 执行会漏掉 commit message 输入框、agent_end 刷新、非轮询约束三个可执行约束。另发现 **1 处跨文档 STALE 残留**（上游 spec/requirements 仍称 pending 补全，与 issues #8 [STALE] 矛盾，方向相反——issues 是对的，上游滞后）。

**verdict: 需补充 — A-02/A-03 必修（验收漏项会直接导致实现缺失），A-01/A-04 建议，A-05/A-06 可选清理。**

| gap | 类型 | 位置 | 阻塞? |
|-----|------|------|-------|
| A-01 | F 覆盖漏项 | #1/#10 未显式区分 C12 双数据源 | 否（上游 D-1 可查，建议显式化） |
| A-02 | F 覆盖漏项 | #3 验收缺 C13 commit message 输入框 + 空 message 禁用按钮 | **是**（验收漏→实现漏） |
| A-03 | F 覆盖漏项 | #3 验收缺 C14 agent_end 刷新 + 非轮询约束 | **是**（验收漏→实现漏） |
| A-04 | D 跨文档 STALE | spec-w11 FR-2/G-001/G-002/Acceptance + requirements F2/G1 vs issues #8 [STALE] | 否（issues 正确，上游待同步） |
| A-05 | F 覆盖（minor） | #1/#8/#12 未显式区分 C15 unmerged 双路径 | 否（结构已覆盖） |
| A-06 | 清理（cosmetic） | #13 标题仍带 "?" 但已升 P1 | 否 |

---

## 一、覆盖性核查（视角 1）

### A-01 [F] — C12「git.status 独立 vs file_changes」未在 issues #1/#10 显式区分

- **位置**：issues.md #1 方案 A「模型」行（仅列 `GitStatusResult` 结构，未声明独立于 file_changes）；#10 问题描述（仅说「聚合 chat store fileChanges」，未声明独立于 git.status）。
- **反证**：requirements.md:200「**关键语义区分（C12）**：真实 git 状态与 per-turn 改动是**两条独立数据**，各管各的」；spec-w11.md FR-12「核心定位（C12）：git-zone 显示真实 git 全量状态（**独立于 message.file_changes**）」；system-architecture §10 D-1「独立数据源」。
- **问题**：issues.md 是 implementer 主决策图。#1/#10 均未显式声明二者独立，存在被误读为同源数据的风险（如把 file_changes 喂给 git-zone，或反之）。
- **修复**：#1 方案 A 补一行「数据源独立于 message.file_changes（C12/D-1），git-zone 走 git.status、变更卡片/FileView 走 file_changes」；#10 问题描述补「FileView 数据源为 file_changes（独立于 git.status，见 C12）」。

### A-02 [F，阻塞] — C13 commit message 输入框 + 空 message 禁用按钮 验收缺失

- **位置**：issues.md #3「验收标准」段（仅 4 条：GitZone grep / zone ⑤ 渲染 / 四态 pill / 暂存取消暂存提交按钮调 domain）。
- **反证**：requirements.md C13「commit message：前端弹输入框（可选 message）」；spec-w11.md FR-12.3「提交按钮弹**简单 message 输入框**（可选 message，C-G-R2-02）」+ FR-12 业务约束「commit message 非空（空 message 会让 git 打开编辑器致子进程挂起；**前端空 message 时禁用提交按钮**）」；code-architecture §4.2 时序图 GitZone.vue `onStage` 有 pending guard。
- **问题**：#3 验收只要求「提交按钮调 git.commit」，**无 commit message 输入框 UI 验收**，**无空 message 禁用按钮约束**。implementer 据此可能直接 `git.commit(sessionId)` 不带输入框，或允许空 message 提交触发 git 编辑器挂起子进程（spec 明确警示的安全隐患）。
- **修复**：#3 验收补两条：`[ ] 提交按钮弹出 message 输入框（可选 message，C13/FR-12）`；`[ ] 空 message 时禁用提交按钮（防 git 打开编辑器致子进程挂起）`。

### A-03 [F，阻塞] — C14 agent_end 刷新触发 + 非轮询约束 验收缺失

- **位置**：issues.md #3 方案 A「流程」行（`onMounted → git.status() → 渲染四态；操作后 → 刷新`）+ 验收段（无刷新时机项）。
- **反证**：requirements.md C14「git 状态刷新：进入会话 + 回合结束 + 操作后（**非轮询**）」；spec-w11.md FR-12.4「刷新时机（G-R2-04）：进入 session 时 + **agent_end 后** + stage/unstage/commit 操作后手动刷（**非轮询，无 filesystem watch**）」。
- **问题**：#3 流程只覆盖「onMounted（进入 session）+ 操作后」两个时机，**缺 agent_end（回合结束）触发刷新**；验收**无非轮询/无 fs watch 约束**。缺前者会导致 AI 改完文件后 git-zone 不刷新（用户看不到新状态）；缺后者 implementer 可能误加 fs.watch 或轮询。
- **修复**：#3 验收补两条：`[ ] agent_end（回合结束）后触发 git.status 刷新（C14）`；`[ ] 无轮询、无 filesystem watch（仅进入 session + agent_end + 操作后手动触发）`。

### A-05 [F，minor] — C15 unmerged 双路径未在 #1/#8/#12 显式区分

- **位置**：issues.md #1（GitStatusResult 含 `hasConflict + files[].status`，git.status 路径 ✅）；#8/#12（FileChangeStatus 含 'unmerged'，file_changes 路径 ✅）。
- **反证**：requirements.md C15「unmerged 由 runtime 推，**双路径**：git.status 的 hasConflict+files[].status=unmerged 与 file_changes 的 FileChangeStatus=unmerged」；system-architecture §10 D-6「两条路径都由 runtime 推送」；code-architecture §3.9 [STALE] G-R2-03「修正 FR-11 矛盾（runtime 推 unmerged）」。
- **问题**：两条路径结构上均已覆盖（#1 有 hasConflict/files，#8/#12 有 unmerged 枚举），但 **issues.md 无一处显式声明「unmerged 由 runtime 双路径推、前端不自己标注」**。#12 问题描述只说「补 unmerged 枚举」，未说谁推送。implementer 若只读 #12 可能误在 file_changes 消费侧自行标注 unmerged（旧 FR-11 错误前提）。
- **修复**（minor）：#12 问题描述补一句「unmerged 由 runtime 推（C15/D-6 双路径），前端只消费枚举不自行标注」。

> C11（git-zone 加回含后端 git.*）→ #1/#3 覆盖完整 ✅。

---

## 二、方案完整性（视角 2）

#1-#12 每个 P0/P1 均含方案 A + 方案 B + 取舍决策 + 放弃理由 ✅。#13（P1，[SURFACED] 修订）单方案合理（C10 已定形态）。无遗漏。

## 三、优先级一致性（视角 3）

P0（#1/#2）blocked_by 均为「无」✅。无 P0 依赖 P2/P3。依赖表与各 issue 正文 blocked_by 字段一致 ✅。#8（P1）描述提及「依赖 #12」为软依赖（可字符串占位），表中标「无」——属有意软化，非硬阻塞，不判为不一致。

## 四、前沿清晰度（视角 4）

### A-06 [cosmetic] — #13 标题仍带 "?" 但已非迷雾

- **位置**：issues.md #13 标题 `### #13: auto_retry / queue_update UI 指示位 ?`。
- **问题**：#13 已升 P1 并 [SURFACED] 修订（W2，形态 C10 已定），不再是迷雾，标题 "?" 误导。
- **修复**：删标题 "?"（与正文 [SURFACED] P1 定位一致）。

#14-#17 为 P3 显式延后项（非迷雾），无需 "?" ✅。

---

## 五、跨文档矛盾核查（额外检查）

### A-04 [D，跨文档 STALE 残留] — spec-w11 + requirements 仍称 pending 补全，与 issues #8 [STALE] + code-arch §3.9 [STALE] 矛盾

- **矛盾方 A（上游，滞后）**：
  - spec-w11.md:18「硬漏接（tool_call_pending）」
  - spec-w11.md:26 In-scope #2「`message.tool_call_pending` store case 补全 + ToolCallStatus 扩 'pending'」
  - spec-w11.md:53-54 FR-2「补 `case 'message.tool_call_pending'`，写入 ToolCall.status='pending'」
  - spec-w11.md:109-110 G-001/G-002「ToolCallStatus 扩 'pending'」
  - spec-w11.md:149 Acceptance「`message.tool_call_pending` 有 store case + ToolCallStatus 含 'pending'」
  - requirements.md:41 G1 路径「修复 tool_call_pending 硬漏接」；:209 F2「工具调用 pending 状态补全」
- **矛盾方 B（下游，正确）**：
  - issues.md #8 [STALE]（line 609）「runtime 不生产 message.tool_call_pending… #8 不补 pending case、#12 不加 'pending' 枚举。原 spec FR-2/G-002 前提失效」
  - code-architecture §3.9 [STALE]「ToolCallStatus = 'running' | 'completed' | 'error'，'pending' 不加」
  - 实证（Round 13 已核验）：`grep tool_call_pending src-electron/runtime/src/` 无生产点；message.ts:3 当前代码本就无 'pending'；event-adapter-extension.test.ts 有反向断言。
- **判定**：**issues.md 正确，上游 spec/requirements 滞后**。06-25 上游更新（C11-C15/FR-12 精简/FR-3-4 修正）未顺手清理 pending 残留。注意 spec-w11.md:28/60/150 的「queue_update pending 气泡」是 **queue pending**（steer/followUp 排队），非 tool_call_pending，**不矛盾**，勿误伤。
- **修复方向**（上游，非 issues.md）：spec-w11.md FR-2/G-001/G-002/Acceptance + requirements F2/G1 路径 标注 `[STALE]`（pending 已移除，见 issues #8 [STALE] / code-arch §3.9 [STALE]）。issues.md 无需改动。

> **Round 14 M-03 复核**：issues.md #8 line 552/565、#12 line 836/849 三处 body 文本均已回填「（注：ToolCallStatus.pending 已移除，见 [STALE]）」。**M-03 全部 RESOLVED**，issues.md 内部 pending 自洽。

---

## 六、收敛判定 + 建议 issues.md 需补充的验收项清单

**未收敛**：A-02/A-03 是必修阻塞项（验收漏项直接导致 implementer 漏实现 C13/C14 的可执行约束）；A-01/A-05 是覆盖清晰度建议；A-04 是反向跨文档同步（issues 正确，上游待修）；A-06 cosmetic。

### 建议 issues.md 补充清单

| # | 位置 | 补充内容 | 对应 gap | 必修? |
|---|------|---------|---------|-------|
| 1 | #3 验收 | `[ ] 提交按钮弹出 message 输入框（可选 message，C13/FR-12）` | A-02 | **是** |
| 2 | #3 验收 | `[ ] 空 message 时禁用提交按钮（防 git 编辑器挂起子进程）` | A-02 | **是** |
| 3 | #3 验收 | `[ ] agent_end（回合结束）后触发 git.status 刷新（C14）` | A-03 | **是** |
| 4 | #3 验收 | `[ ] 无轮询、无 filesystem watch（进入 session + agent_end + 操作后手动触发）` | A-03 | **是** |
| 5 | #1 方案A 模型行 | 补「数据源独立于 message.file_changes（C12/D-1）」 | A-01 | 否（建议） |
| 6 | #10 问题描述 | 补「FileView 数据源为 file_changes（独立于 git.status，C12）」 | A-01 | 否（建议） |
| 7 | #12 问题描述 | 补「unmerged 由 runtime 双路径推（C15/D-6），前端不自行标注」 | A-05 | 否（建议） |
| 8 | #13 标题 | 删「?」（已升 P1，非迷雾） | A-06 | 否 |

### 建议上游同步（非 issues.md 改动）

| 文件 | 位置 | 动作 | 对应 gap |
|------|------|------|---------|
| spec-w11.md | FR-2 / G-001 / G-002 / Acceptance（line 18/26/53-54/109-110/149） | 标注 `[STALE]`（pending 已移除，见 issues #8 / code-arch §3.9） | A-04 |
| requirements.md | F2（line 209）/ G1 路径（line 41） | 标注 `[STALE]` 同上 | A-04 |

**完成上表 1-4（必修）+ 5-8（建议）后，issues.md 即与 06-25 上游对齐收敛**；A-04 上游同步可与下一轮 spec 修订同批处理，不卡 issues.md 收敛（issues 已正确，[STALE] 注释提供无歧义裁决）。
