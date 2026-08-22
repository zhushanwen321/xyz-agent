# 对抗式审查报告：# 引用补全当前目录化重构

> **审查对象**：`extensions/session-reader/docs/2026-08-10-cwd-popup-redesign.md`
> **审查基调**：对抗式（默认怀疑，逐项 read 源码核实，不凭感觉）
> **审查人**：主 agent 自审（本会话未提供 `subagent` 工具，无法派独立 `tech-design-review` agent；已按 `review/rubric-design-doc.md` P0 项逐条核实，关键事实均 read 源码复核）

## Summary

**1 must-fix, 3 suggestions.** 核心方案（复用 `SessionManager.listAll` + 字段重映射）因果链成立、关键事实经实测、验收 testable；有 1 处运行时断言事实错误必须修。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.1 终态 + §3.4-2 | P0-11 事实 | 称「有 name 时显示 name（黄色，对齐 /resume 的 warning 色）」。**实测证伪**：`SelectList.renderItem` 对整段 description 统一上色（`theme.description(spacing + truncatedDesc)`，select-list.js:106），`AutocompleteItem` 只有 `{value,label,description}` 无颜色字段。`/resume` 的 name 黄色是其自定义组件 `SessionSelectorComponent` 单独算色，# 弹窗的通用 SelectList 做不到。文档承诺了一个渲染层无法兑现的效果 | 删除「黄色」断言；改为「name 与 firstMessage 同色，靠文本本身区分」；若要 name 视觉区分需改 pi-tui（列入 out-of-scope） |
| SUGGESTION | §3.4-4 | P0-12 副作用 | uuid 片段过滤（`id.includes`）**静默移除了旧的 keyword fallback**（旧 `findSessions` 在 uuid 零匹配且 query 非十六进制时，会深读 firstMessage 做关键词匹配）。这是行为收窄（合理，# 弹窗不需要关键词搜索），但未声明 | §3.4 显式声明：# 弹窗不再支持关键词匹配，只支持 uuid 片段；关键词查找走 `session_read` 工具 |
| SUGGESTION | §3 / §4 | P1 假设 | 大 cwd（Stock 530 文件）首次 listAll = 667ms，文档归入 P2 缓存「可选」。但未显式声明「# 弹窗面向典型项目 cwd（6-50 文件）」这一前提；超大 cwd 首次加载慢是已知边界 | §3.4 或 §4 场景 A 补一句前提声明 + 边界值 |
| SUGGESTION | §5 U5 | P1-2 拆分 | `/session-pick` 的 `getArgumentCompletions` 改动仅一句带过，未说明 Tab 补全也变 cwd-scoped + uuid-only（与 handler 一致） | U5 补一句：`getArgumentCompletions` 同样换 listAll + uuid 过滤 |

## P0 逐项判定（对抗式核实）

| # | 项 | 判定 | 依据 |
|---|---|---|---|
| P0-1 | 五段骨架 | 通过 | §1-§5 齐全 |
| P0-2 | delta 链 | 通过 | 无 vN/Rxx/参见上版 |
| P0-3 | 结论先行 | 通过 | 每章首句结论 + SCQA 开篇 |
| P0-4 | 现状触根因 | 通过 | §2.3 逐目标给根因 + 实测数据 |
| P0-5 | 使用者视角 | 通过 | §2.1 真实截图 + §3.1 终态样例 |
| P0-6 | 术语定义 | 通过 | SelectList/AutocompleteItem/session_info 等首次出现有定义 |
| P0-7 | ≥2 方案 | 通过 | 4 个决策点各 ≥2 方案 |
| P0-8 | 长期+短期评估 | 通过 | 决策 1/2 表格含两栏 |
| P0-9 | 明确推荐 | 通过 | 每个决策有 ✅/❌ + 理由 |
| P0-10 | 方案解决根因 | 通过 | G1-G6 各回溯根因；方案 A（listAll）直击 G1/G3/G5 三个根因 |
| P0-11 | 关键事实正确 | **不通过** | name 黄色断言错（见上 MUST_FIX）；其余事实（SelectList 32 clamp、listAll 签名、getSessionDir 在 ReadonlySessionManager、perf 数字）均已 read 源码/实测核实 ✅ |
| P0-12 | 副作用/遗漏 | 可能不完整 | keyword fallback 移除未声明（见 SUGGESTION）；其余向后兼容（insertText 不变、session_read 工具侧不动）已覆盖 |
| P0-13 | 验收 testable | 通过 | 7 场景各有步骤+通过标准+回溯目标 |
| P0-14 | 验收非单测/mock | 通过 | 全部真实环境（pi TUI + 真实 session 文件） |
| P0-15 | 验收投入匹配 | 通过 | 大改动 7 场景，非敷衍 |
| P0-16 | 运行时断言附探针 | 通过（修后） | perf 数字标实测、SelectList clamp 标源码行；name 颜色断言无探针且错 → MUST_FIX |
| P0-17 | 物理数据流图 | 通过 | §2.2 有当前数据流图 |
| P0-18 | 错误恢复指引 | 通过 | §3.1 失败路径含具体恢复动作（/session-pick、/resume、session_read 工具） |

## 结论

修掉 MUST_FIX（删除 name 黄色断言）后，文档达到 DoR（设计就绪），可进入 §5 拆分实施。3 个 SUGGESTION 建议同批补入但不阻塞。
