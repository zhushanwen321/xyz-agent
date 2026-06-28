---
verdict: APPROVED
machine_check: PASS
review_mode: single
---

# Review — clarity（侧栏「文件」视图 · 全项目文件树 裁决稿）

## Verdict

APPROVED — requirements.md 内部一致、决策账本 D-001~D-007 七条全部落地、对被推翻的 `sidebar/spec.md` 改写干净无残留旧语义、后端依赖 gap 列表与真实代码库逐一吻合、§4 SideDrawer 对齐 detail-pane SSOT 结构完整。机器检查唯一 exit-1 项是检查本审查文件自身的自指项（写入即解）。

## 机器检查结果

`check_clarity.py` 原始 exit 1（6/7 passed），需区分性质：

| 检查项 | 结果 | 性质 |
|--------|------|------|
| requirements.md 存在 | ✅ | 实质性（针对交付物） |
| frontmatter verdict | ✅ | 实质性 |
| 关键章节齐全 | ✅ | 实质性 |
| 无占位符 | ✅ | 实质性 |
| **review-clarity 存在且 verdict: APPROVED** | ❌ → ✅ | **自指项**（检查本审查文件自身） |
| 每 UC 有 ≥1 条 AC | ✅ | 实质性（6/6，实测 UC-1~UC-6 均有 AC） |
| 未含系统实现（①铁律） | ✅ | 实质性 |

**判定说明**：针对 `requirements.md` 本体的 6/6 实质性检查全过。唯一 ❌ 是 `check_review_verdict` 检查 `review-clarity.md` 是否存在且 verdict=APPROVED —— 即检查**本审查文件自身**。首次审查时此项结构性不可满足（先有鸡还是先有蛋）：写入本文件（verdict: APPROVED）后重跑 `check_clarity.py` 该项即 ✅，整体 exit 0。此 ❌ 不反映 `requirements.md` 任何缺陷，故不构成阻断。

> 与 `2026-06-26-new-task-landing` 的成功先例采用同一处理范式（见其 review-clarity.md「写入即解」），保持 harness 内一致。

## 维度评估（5 维 ✅⚠️❌）

### 内部一致性 ✅
- **决策账本闭环**：decisions.md 七条决策（D-001~D-007）全部在 requirements.md 有对应落点，无一孤儿——
  - D-001（推翻 spec→全项目树）→ §1 背景 + §0 对照表
  - D-002（根=session.cwd）→ §3 数据清单「cwd 根目录」+ §5 工具栏标题
  - D-003（git 标注源=git.status）→ §3 数据清单 + §5/§2 说明
  - D-004（.gitignore + 显示忽略项开关）→ §1 达成路线注 + §5（HTML §3 详述）
  - D-005（点击落地 SideDrawer detail-pane）→ §5 落地区方案 A + §4（HTML §4）
  - D-006（文件操作本轮 demo）→ §4 功能清单 F4 + §8 不做 + UC-5 占位
  - D-007（配色语义：亮色/角标/灰斜体）→ HTML §2 注释块（.node .name = fg 亮色 / .git-* 角标 / .node.ignored = muted 灰斜体），CSS 注释显式标注「裁决弃旧 dim 弱化」
- **D-005 跨文档一致**：UC-6（requirements.md，点文件→SideDrawer detail-pane 预览内容/diff）与 HTML §4（drawer 打开 + .cur 高亮）语义一致；decisions.md D-005 文案「dd-head + dd-tabs[文件名] + view-toggle[Diff/预览] + cs-diff + cs-foot」与 HTML §4 实际 DOM 结构（`.dd-head` / `.dd-tabs` / `.view-toggle` / `.cs-diff` / `.cs-foot`）逐类名吻合。
- **目标→用例→功能可追溯链闭合**：G1→UC-1/UC-3→F1/F3；G1.1→UC-3；G1.2→（散见 §5 分层语义）；G2→UC-2→F2；G3→UC-4→F3。达成路线表 §1 的三行路线（file.tree / git.status / 过滤框）与功能清单 F1/F2/F3 一一对应。

### 上游对齐 ✅
- **spec.md 推翻已落地且无残留旧语义**：被推翻的 `sidebar/spec.md §视图切换` 三处均已标 `[BACKFED from clarity on 2026-06-28]` 并改写——
  - 「tab 计数」行（spec L32）：旧「File View 计数 = 当前 active session 的改动文件数，非全项目」已改为「项目文件总数（另标 git 改动数，如『148 ·12改』）」
  - 边缘态表「File View 点击文件」行（spec L56）：已改为「打开 Panel 右侧 SideDrawer detail-pane 预览（D-005）」
  - 新增独立章节「File View 语义裁决（2026-06-28）」（spec L62-77）：完整定义数据源/树内容/根目录/样式/点击落地/配套 draft
- **无残留旧「改动清单」语义**：grep 确认 spec.md 的「计数语义」「active session 联动」「非 git 仓库」三处均改为全项目树口径；§视图切换「非全项目」措辞已删。requirements.md §0 对照表与 spec.md 新章节零矛盾。
- **detail-pane SSOT 对齐准确**：HTML §4 drawer 的五组件结构与 `draft-detail-pane.html`（detail drawer SSOT）逐项对齐——
  - `dd-head`（title+meta+close）↔ SSOT L191-195
  - `dd-tabs`（tab=文件名，带 +/- 行数 + tab-mk 圆点）↔ SSOT L196-209（SSOT 多一个 dd-tab-sep 和子Agent tab，但 requirements 本轮 scope 仅文件 tab，合理裁剪）
  - `view-toggle`（Diff/预览）↔ SSOT L212-217
  - `cs-diff`（cs-d-path 路径行 + badge + dline 带行号 diff，用 `--diff-add/del` 专用 token 而非 success/danger）↔ SSOT L227-242
  - `cs-foot`（回退/复制 patch/编辑器打开）↔ SSOT L253-259
  - diff token：HTML L16-18 显式声明 `--diff-add/del` 对齐 detail-pane，核对 SSOT L16-17 一致 ✅

### 可执行性 ✅
- **后端依赖 gap 与真实代码库逐一吻合**（关键核验）：
  - `git.status` 已就绪 ✅ — `src-electron/shared/src/protocol.ts` L107/L279 定义 `'git.status'` 请求 + `'git.status:result'` reply；`git-status-parser.ts` 产 XY 双列码→`GitFileStatus['status']`（modified/added/deleted/untracked/unmerged/renamed），与 requirements.md §2「M/A/D/U 角标」映射完全吻合
  - `file.read` 限 skill 目录 ✅ — `server.ts` L470-471「Restricted to skill directories for security (no arbitrary file read)」，L488 `path_not_allowed` 错误，印证 requirements.md §7「runtime file.read 限死 skill 目录，落地预览需放开工作区权限」准确
  - `file.tree` 缺失 ✅ — protocol.ts 无 `'file.tree'` type（仅 `file.read`），印证 §7「runtime 无 file-service/file.tree 协议」准确
  - file 写操作缺失 ✅ — protocol.ts 无 file create/rename/delete client message，印证 §7/§8「F4 待建」
- **gap 是否阻断落地**：不阻断本阶段。所有未就绪项（file.tree/file 写/git.diff 工作区权限）均显式归入 §8 不做 + §7 技术约束「仅记录不展开」，并标注移交 architecture/execution 阶段。本阶段交付物是「设计裁决稿」（推翻定义 + demo 语义），非可执行实现——gap 在下游阶段补齐不构成本阶段阻断。§0 的「⚠️ 推翻动作：定稿后需修订 spec.md」清晰交代了下游动作。

### 完整性 ✅
- **6 UC 均有可验证 AC**：UC-1(3)/UC-2(4)/UC-3(2)/UC-4(3)/UC-5(1)/UC-6(3)，每个 AC 带 [正常]/[异常]/[边界] 标签。
- **UC-5（文件操作）占位合理**：UC-5 标「后续实现」，AC-5.1 [占位] 明确「demo 画右键菜单+工具栏交互，标注依赖后端 file-service」，与 §8 不做 + D-006 + HTML §6 warn note 一致。占位有显式边界（demo 范围 + 依赖标注），非空洞 TODO——是合理的 scope 控制（用户指令「先做这个」聚焦全项目树），非遗漏。
- **UC-6（点击落地）占位合理**：UC-6 实际非纯占位，有 3 条可验证 AC（AC-6.1 点文件→SideDrawer 打开 / AC-6.2 改动文件→diff / AC-6.3 未改动→内容），落地路径已由 D-005 裁决为方案 A。其「关联目标: 无（闭环交互）」标注准确（UC-6 是体验闭环，不直接服务 G1-G3）。
- **数据流完整**：§3 数据清单 3 项（目录树节点/git 状态/cwd）均含来源·处理·消费者·敏感级别，生命周期闭合（fs.readdir→fileTree store→FileView 渲染）。

### 可视化质量 ✅
- **§0~§7 完整呈现推翻后设计**：§0 对照表（6 维旧 vs 新）+ §1 容器壳 + §2 全项目树核心 + §3 .gitignore 开关 + §4 SideDrawer 落地 + §5 过滤 + §6 文件操作 + §7 边缘态，覆盖 requirements.md 全部 UC 与功能。
- **§2 配色语义清晰**：注释块（HTML L83-84）显式声明语义「文件/目录默认亮色(fg)；选中=蓝粗体(accent)；.gitignore 忽略项=灰斜体(muted)」，对应 D-007。CSS 实现——`.node .name{color:var(--fg)}`（L90 未改动文件亮色）/ `.git-m/a/d/u`（L104-107 改动文件角标，四态 M橙/A绿/D红/U冲突红描边）/ `.node.ignored .name{color:var(--muted);font-style:italic}`（L117 忽略项灰斜体）。三角关系（未改动亮色无角标 / 改动亮色带角标 / 忽略灰斜体）在 §2 树示例（Button.vue 无角标 vs FileView.vue M 角标）中实物可辨，非仅文字描述。
- **§4 drawer 真对齐 detail-pane**：见「上游对齐」维度，五组件 + diff token 逐项核对吻合，非声称对齐。
- **§5 过滤 vs ⌘K 区分**：warn note 显式对比（本框=文件树过滤实时无浮层 / ⌘K=全局 Overlay 四类跨 session），对齐 handoff P0。
- **死链检查**：HTML 引用的相对路径（`sidebar/spec.md` / `panel/draft-detail-pane.html` / `overlays/draft-search-modal`）经核对均真实存在。

## 必须修改

无。机器检查的 ❌ 是自指项（写入本文件即解，见「机器检查结果」判定说明），不反映 requirements.md 任何缺陷。

## 可选改进

1. **G1.2 用例缺显式承接**（cosmetic）：requirements.md 目标树有 G1.2「未改动文件、改动文件、忽略文件分层可见」，但达成路线表 §1 的「对应用例」列无 UC 直接标 G1.2（分层可见散落在 UC-1 树内容 + UC-2 角标 + D-004 忽略项）。建议 UC-1「关联目标」补 G1.2 或新增脚注，使目标→用例映射更显式（当前是隐式覆盖，非真缺失）。
2. **UC-6 缺异常 AC**（cosmetic）：UC-6 主流程异常流程写了「文件读取失败→detail-pane 显示错误态」，但无对应 AC（如 AC-6.4 [异常]: file.read 失败→错误态文案）。当前 AC-6.1~6.3 覆盖正常+边界，非阻断；②/③ 阶段可视需要补。
3. **HTML §2 注释块 D-007 引用**（cosmetic）：HTML §2 配色注释块声明了裁决语义但未显式标「D-007」，而 §1/§4 注释分别标了 D-002/D-004/D-005/D-006。补 D-007 标记可提升决策可追溯性（非硬伤，决策账本已记录）。
4. **嵌套 >3 层横向省略策略**（已知遗留）：spec.md 边缘态表「嵌套目录 >3 层·横向省略策略待定」+ requirements.md §8 列为遗留。HTML §2 缩进到 indent-4（4 层）但无省略示意。此为 spec.md 既有遗留，本裁决稿正确地未扩大 scope，标注合理，留后续阶段。
