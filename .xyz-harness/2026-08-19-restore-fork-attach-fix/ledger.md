# restore-fork-attach-fix 状态账本

> 协调机制：cw-orchestrator 三方制衡（同 `../2026-08-19-data-source-governance-p1p4/ledger.md` 模式）。
> 设计 SSOT = `docs/architecture/restore-fork-attach-fix.md`（commit d6ab28d75，对抗式审查 4 must-fix 已修复）。
> 状态机：pending → building → built → verifying → verified → committed；失败 → rejected（打回原 builder 修复后针对性复审）。
> subagent 一律禁 git 写；每 wave 完成即 commit（主 agent 唯一 commit 出口，精确路径 add）。

## 依赖图

- W1（附着路径修复，含 R1 豁免——归一化 writeFileSync 会触发 R1，豁免必须随代码同 wave 否则无法 commit）→ W2（护栏收尾：attach 断言 + 生命周期等价测试 + ADR-0062 §2 修订 + ADR-0063 + 登记表 I5 + checklist）
- 串行：无并行 wave（W2 的 attach 断言在 tmp 附着形态下会立即失败，依赖 W1 先行）

## wave 表

| wave | 名称 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| W1 | 附着路径修复（F1+F2+F3 + R1 豁免） | committed | 8e1591cde | verifier PASS（报告 acceptance/w1-report.md：防篡改 sha256 一致/越界 35 条零越界（22 条认知外豁免）/3178 全绿/红性 5 红（C2-C6）字节还原四重证明/真实性 6 项）。**F1 major（对抗新发现）**：「崩溃残留 scanner 天然忽略」声明证伪（scanner 按内容识别，残留同 id 双条目 + findScannedSession 命中错位）→ 打回 builder 修复：`isScannableSessionFile` 过滤收口 `scanPiSessionsFromDisk` 两处枚举（session-scanner.ts 核实无需改）+ 双侧断言测试 + docstring/登记表声明修正 → 针对性复审 PASS 维持（红性独立复验/全域无第三枚举点/误伤面零/TTL 缓存不可绕过；R2 minor = 设计文档第三处同源声明，主 agent 已修正）。R1 豁免 B③ 与 B① 同构（F2 裁决不动） |
| W2 | 护栏收尾（F4：断言/等价测试/ADR/登记表/checklist） | pending | — | 领地避开认知外未提交文件（helper 放 process-manager.ts） |

## 事件

- 2026-08-19 计划启动：设计文档定稿并 committed（d6ab28d75，含用户质疑触发的逐动机 pi 侧查证 + tech-design-review 对抗式审查 4 must-fix 修复记录，见设计文档附录）。裁决记录：F5 孤儿抢救不做（用户）；F3 方案 A rename-over 定案（用户「直接删掉」直觉 + 查证修正）。W1 验收基线入 git 后派 builder。
