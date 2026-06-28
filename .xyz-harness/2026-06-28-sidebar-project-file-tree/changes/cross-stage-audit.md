---
verdict: inconsistencies_found
---

# 跨阶段一致性审计（①requirements + ②architecture ↔ ③issues）

> fresh subagent，三方向交叉核对。0 PHANTOM（三方确认），③方案取舍零违反 confirmed 决策。7 条不一致（0 高危阻断 / 3 中危 / 4 低危）。

## 不一致清单（按严重度）

| # | 类型 | 不一致描述 | 涉及 | 建议 |
|---|------|-----------|------|------|
| 1 | K | **D-007 样式零落地**：①D-007（ask_user confirmed）三部分——①默认亮色(fg)/选中蓝粗体 ②忽略项灰斜体 ③弃旧 dim。backfeed 仅把②扫进 #15 P3，但①③（默认亮色、弃dim）与「显示忽略项」无关，是 #4 FileView 重写必然要做的样式决策，③#4 无任何样式 AC。 | ①→③ | **补 AC**：#4 补 D-007①③（文件/目录默认亮色 fg、选中 accent、弃 dim）。灰斜体②随 #15 |
| 2 | K | **展开态 reset 三角矛盾未解**：①UC-3 AC-3.2「切回恢复」+ 后置「持久化」vs ②§4「整体 reset」(销毁语义) vs ③AC-3.5「按 session 隔离恢复」(含糊)。②无 rehydrate 机制，③无持久化存储定义。tracing 角色 B 标 K 未解。 | ①↔②↔③ | **反哺 ②或 ask_user**：②§4 明确「整体 reset=按 sessionId 缓存+切回 rehydrate」，或 ask_user 裁决「切走丢展开态」修订 ①AC-3.2+③AC-3.5 |
| 3 | D | **D-004/D-007 显示部分延后 #15「待用户确认」dangling**：backfeed + ③#15 均标「待用户确认延后」，但 review APPROVED 未当阻断，confirmed 的 ask_user 决策（D-007）被静默降级未走 ask_user。 | ①→③ | **交接必须向用户显式确认** |
| 4 | F | **D-017 失效触发依赖 #8 cwd 但无依赖边**：D-017 触发=ready 帧，ready 帧依赖 cwd（BC-5/#8）。#8 与 #3 无 blocked_by，若 #8 未先修失效可能作用到错误 session。 | ②↔③ | **补依赖**：#3 AC-3.11 加注「依赖 #8 ready 帧 cwd 正确」 |
| 5 | F | **#8/#9 P1 理由错误归因未完全修正**：tracing 角色 B 指出 #8/#9 把 file-tree 标注当 P1 理由不准（file-tree 走 git.status D-003 不经 reconcileFileChanges；#8/#9 服务 ChangeSetCard）。③定稿「为什么P1」段仍隐含归因。 | ③ | **修正措辞**：改为「服务 ChangeSetCard（BC-1），D-010①② confirmed 同区域搭便车」 |
| 6 | F | **§11 AC-3（无 PiXxx）在 #2 未单独列**：②§11 AC-3 要求 FileService 无 Pi[A-Z]，#2 列了 AC-2.6/2.7 但无 AC-3 专项。 | ②→③ | **补 AC**：#2 补 `grep "Pi[A-Z]" services/file-service.ts` 无输出 |
| 7 | F | **「当前编辑文件」computed 错位**：②§4 降级「不建独立模型，作为 store computed(get currentFile)」，但 ③AC-4.12（高亮）落在 #4（view）非 #3（store）。store 无 currentFile computed AC。 | ②→③ | **补 AC**：#3 补「store 暴露 currentFile computed」，#4 消费它 |

## 干净之处
- D-017 反哺（②§5/§7/§10 ↔ ③AC-3.11 + decisions.md）四处全一致
- 0 PHANTOM（机器+角色A+本审计三方确认）
- ③方案取舍零违反 confirmed 决策（#2三层port/#3内聚/#4递归/#5扩白名单/#6硬编码/#7扩展/#10统一/#14骨架 全对齐 D-008~D-018）
- ①UC AC 基本全覆盖（除 D-007 样式 + AC-3.2 矛盾）

## 结论
7 条不一致（0 阻断 / 3 中危 / 4 低危）。#1/#2/#3 需本轮或交接闭环（⑤实现必撞），#4~#7 低危⑤可解。
