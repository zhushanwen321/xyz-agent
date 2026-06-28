---
frame: evolution
round: 1
perspectives: [5-change-axis, 6-behavior-contract]
converged: false
created_at: 2026-06-28
---

# 时间帧追踪 · Round 1（视角5 变化轴 + 视角6 行为契约）

## Gap 汇总表

| ID | 类型 | 视角 | 严重度 | 一句话 | 引用 |
|----|------|------|--------|--------|------|
| G1 | F | 6 | 高 | BC-3 的 allowedPrefixes 实际 3 目录（含 npm），文档只写「skill 目录」 | §12 BC-3 |
| G2 | F | 6 | 高 | BC-1 源码行号 221 应为 222；两帧语义（accumulating/ready + changeSetStatus/isFullSet 字段）没登记 | §12 BC-1 |
| G3 | F | 6 | 中 | BC-4 遗漏子行为：filterText 过滤语义变更/buildTree 默认全展开→懒加载折叠/fileCount 计数语义变更 | §12 BC-4 / FileView.vue |
| G4 | F | 6 | 中 | BC-3 扩展后 {piAgentDir}/npm 目录是否保留（cwd 可能不覆盖它） | §12 BC-3 |
| G5 | D | 5 | 中 | fileTree store 4 职责（树缓存/展开态/选中态/GitOverlay）~150 LOC，D-012「分离」是否=拆文件未拍板 | §7 前端 / D-012 |
| G6 | D | 5 | 中 | file-service 跨 service 复用 isUnderOrEqual，该抽 shared 还是接受 service 间依赖未说 | §7 runtime / §2 |
| G7 | F | 6 | 中 | BC-2 行号未核对（git-service.ts:94/protocol.ts:107） | §12 BC-2 |
| G8 | K | 5 | 低 | useFileTree 含「预览」职责，该拆 useDetailPane | §7 前端 |
| G9 | F | 5 | 低 | file-service「合并 ignore 过滤」与 IIgnoreReader port 边界不清 | §7 runtime / D-004 |

## CONVERGED: 否（9 个 gap，2 高优先级）
