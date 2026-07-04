# ARCHIVED — ⌘K 全局搜索浮层（search-modal）

> 归档于 2026-07-01。本 topic 已完成设计→实施→沉淀闭环，目录只读。
> 设计产出保留作事后追溯材料（decisions.md 含完整决策审计链 D-001~D-029）。

## 沉淀去向

| 源 deliverable | 沉淀进 | 内容 |
|---------------|--------|------|
| ①requirements §8 | PRODUCT.md「非目标」 | 搜索明确不做：文件内容全文搜索（ripgrep）/符号搜索（LSP）/危险命令分级/会话跳转进概览 |
| ②system-arch | ARCHITECTURE.md「数据流模式」 | useSearch 跨 store 编排实例（3 源 allSettled）+ ADR 导航 |
| ③decisions D-026 | ADR-0028 | 搜索编排归 composable 非 domain（domain 只调 transport+pending 铁律） |
| ③decisions D-028 | ADR-0029 | 领域类型 SSOT 归 lib（mock 反向依赖领域类型） |
| ③decisions D-029 | ADR-0030 | 文件匹配算法单一管线复用（composer # 与 SearchModal） |
| ④nfr MR-4.5/MR-6.2 | NFR.md S-6 | error 冒泡链不经吞错层 |
| ④nfr MR-17.1 | NFR.md S-7 | WS 源超时 race |
| ④nfr MR-4.1 | NFR.md S-8 | 查询乱序守卫 loadSeq |
| ⑥execution T1.12 | TEST-STRATEGY.md §4 | 搜索查询乱序守卫基线用例 |

## [UNVERIFIED] 约束

无。全部 13 条 MR 约束经代码 grep 验证落地（Step 1b 代码一致性验证通过）。

## 清理记录

- 删 `changes/`（tracing/review/backfeed/machine-check/consistency 全部过程产物）
- 删 `*.html`（design-visual-explainer 可视化产物）
- 删 stray `src-electron/` 空目录
- 保留 `decisions.md`（决策审计链，append-only）
- 保留 `code-skeleton/`（契约文档，⑤code-arch 产出）
