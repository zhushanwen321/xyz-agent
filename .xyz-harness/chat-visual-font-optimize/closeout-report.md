---
archived: true
unverified_count: 0
topic: chat-visual-font-optimize
closed_at: 2026-08-26
---

# Closeout Report — 对话流视觉优化（字体管线 / 折叠头截短 / 双轴尾部追踪 / 表格圆角）

## 实施摘要

5 Waves 全部落地（commits：00363c37 字体管线 / b0cb6972 表格圆角 / 10c2de6d 折叠头截短 / 0ab291e 双轴尾部追踪 / f628561b 验收记录）：字体渲染对齐 macOS 原生（删 font-smoothing + 系统栈替换 Inter，五载体同步 + ADR-0019 supersede 留痕）、bash 折叠头 `…/末两段` 展示层截短（展开/copy 全量）、thinking/tool 非展开态双轴尾部追踪（useTailScroll composable）、markdown 表格圆角化。195/195 测试全绿，dev app V1-V4 验收通过（截图 .tmp/verify/ 5 张）。

## 沉淀清单

| 沉淀项 | 去向 | 溯源 |
|--------|------|------|
| `--font-sans` 系统栈新值 + supersede ADR-0019 字体子决策标注 | docs/page-design/v6-master-spec.md §4.6 + v6-tokens.css + design-tokens.md + docs/adr/0019-visual-direction.md（括注） | [from: cw-2026-08-25-chat-visual-font-optimize §D2/D6]（W1 commit 00363c37） |
| tailwind-preset fontFamily.sans 改 var(--font-sans) 变量引用（消灭第二 SSOT） | packages/shared/src/tailwind-preset.ts + packages/mobile-renderer/src/styles/tokens.css | [from: cw-2026-08-25-chat-visual-font-optimize §D2]（W1 commit） |
| 流式 block 双轴尾部追踪 + 折叠头截短回归基线（破坏即事故） | TEST-STRATEGY.md §4 基线表 | [from: cw-2026-08-25-chat-visual-font-optimize §D4]（commit c1c8ed3） |
| pi bash 部分输出无流式增量广播的协议层事实（tool 折叠头按预案降级静态 argPath；thinking 链路钉尾 3/3 实测通过） | .tmp/xyz-agent-font-optimize-design.md §6 限制 6（实测确认）+ TEST-STRATEGY.md 基线行备注 | [from: cw-2026-08-25-chat-visual-font-optimize §W5] |
| URL 不截短口径（实现优于设计：scheme+host 占位保护，URL 完整可读） | .xyz-harness/chat-visual-font-optimize/plan.md U5 + 设计文档 D3 风险栏 | [from: cw-2026-08-25-chat-visual-font-optimize §W3] |

## UNVERIFIED 项

无。所有沉淀项均有代码/commit 证据（grep 可验）。

## 遗留（非阻塞）

- D4 的 P1 应用点（working 态手动展开 thinking 定高尾部窗口）按设计文档待用户单独决策，未实施
- critique Out 项（R1/R2/R3/R4/R5/R7）显式排除，各自独立处置
- 399 条存量 lint warnings 非本次引入，未处理（不挂门禁）
