# ARCHIVED — sidebar-project-file-tree（2026-06-28）

**主题**：侧栏全项目文件树功能（File View 重定义为完整目录树 + 文件预览 + git 标注）。
**状态**：已归档（只读）。编码实施完成（W0-W8，commits e8518a8d → 2d99cc52），测试验收全绿。
**归档日期**：2026-06-30。

## 沉淀去向

| 源 deliverable | 沉淀进 | 内容 |
|---------------|--------|------|
| ③issues D-001 | [ADR-0025](../../docs/architecture/adr/0025-file-view-full-project-tree.md) | File View 语义重定义（全项目树）|
| ③issues D-009 | [ADR-0026](../../docs/architecture/adr/0026-file-tree-lazy-loading.md) | 文件树懒加载策略 |
| ③issues D-008/D-013 | [ADR-0027](../../docs/architecture/adr/0027-fileservice-three-layer.md) | FileService 三层 + ignore 纯函数范式 |
| ④nfr S-1/S-3/S-4/S-5 | [docs/NFR.md](../../docs/NFR.md) | 越界守门 / git 防注入 / 禁 v-html / git.diff 越界 |
| ④nfr K-2/AC-3.x | [docs/NFR.md](../../docs/NFR.md) | 超时机制 / 幂等去重 / 跨 store 编排 |
| 2026-06-30 复盘 | [docs/NFR.md](../../docs/NFR.md) NFR-A1/T1 | shared 层禁 node 内置 / E2E dev 冒烟闸门 |
| ⑥execution + 复盘 | [TEST-STRATEGY.md](../../TEST-STRATEGY.md) §2 | E2E 从手动升级为 Playwright + dev 冒烟 |
| ②system-arch | [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) | 子系统索引加文件树 + ADR 索引 |

## 保留文件（归档态）

- `decisions.md` — 决策审计链（D-001~D-021，含 revisit 记录）
- 6 个 deliverable `.md`（requirements/system-arch/issues/nfr/code-arch/execution-plan）— 设计产出，事后追溯材料
- `code-skeleton/` — 骨架代码参考（W3 store 实现时已强制对齐 D-021，骨架仍为旧结构）

## 已清理

- `changes/` — tracing/review/backfeed 过程产物（已删）
- `*.html` — design-visual-explainer 可视化产物（已删，可重新生成）

## 关联复盘

- `.xyz-harness/2026-06-30-e2e-retrospect/` — E2E 全绿掩盖 dev 崩溃事故复盘 + 测试流程文档
