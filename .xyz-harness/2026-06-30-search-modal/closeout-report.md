---
archived: true
unverified_count: 0
topic: 2026-06-30-search-modal
closed_at: 2026-07-01
---

# Closeout Report — ⌘K 全局搜索浮层

## 沉淀清单

### ADR（append-only，3 条）

| ADR | 源决策 | 溯源 |
|-----|--------|------|
| ADR-0028 搜索编排归 composable | D-026 | `[from: 2026-06-30-search-modal §code-arch, decisions D-026]` |
| ADR-0029 领域类型 SSOT 归 lib | D-028 | `[from: 2026-06-30-search-modal §code, decisions D-028]` |
| ADR-0030 文件匹配算法单一管线复用 | D-029 | `[from: 2026-06-30-search-modal §code, decisions D-029]` |

### NFR.md（覆盖更新，3 条，S-6/S-7/S-8）

| 约束 ID | 约束 | 源 MR | 代码验证 |
|---------|------|-------|---------|
| S-6 | error 冒泡链不经吞错层 | MR-4.5/MR-6.2 | useSearch.ts `composerApi.getFileCandidates` 无 useFileSearch.load；useSearchJump.ts `fileApi.read` 无 openPreview ✅ |
| S-7 | WS 源超时 race | MR-17.1 | useSearch.ts `withWsTimeout` + `WS_SOURCE_TIMEOUT_MS` ✅ |
| S-8 | 查询乱序守卫 loadSeq | MR-4.1 | useSearch.ts `loadSeq` + `seq !== loadSeq return []` ✅ |

### 其他长期文档

| 文档 | 内容 | 溯源 |
|------|------|------|
| PRODUCT.md「非目标」 | 搜索明确不做（全文搜索/符号/危险命令/概览跳转） | `[from: 2026-06-30-search-modal §requirements §8]` |
| ARCHITECTURE.md「数据流模式」 | useSearch 跨 store 编排实例 | `[from: 2026-06-30-search-modal §system-arch]` |
| ARCHITECTURE.md 子文档导航 | ADR-0028/0029/0030 索引 | `[from: 2026-06-30-search-modal §decisions]` |
| TEST-STRATEGY.md §4 | 搜索查询乱序守卫基线用例 | `[from: 2026-06-30-search-modal §execution T1.12]` |
| TEST-STRATEGY.md 功能文档列表 | 06-search-modal.md 索引 | `[from: 2026-06-30-search-modal §testing]` |
| DESIGN-LOG.md | search-modal 归档条目 + 沉淀去向 | `[from: 2026-06-30-search-modal]` |

## [UNVERIFIED] 清单

无（unverified_count: 0）。全部 13 条 MR 约束经代码 grep 验证落地。

## 清理记录

- 删 `changes/`（19 个过程产物文件）
- 删 `*.html`（4 个可视化产物）
- 删 stray `src-electron/` 空目录
- 保留：6 deliverable + decisions.md + code-skeleton/ + _progress.md + ARCHIVED.md + 本报告

## 实施验证摘要

- 编码：5 个 commit（设计文档 / 实现+测试 / 测试文档 / E2E spec / 复用改造）
- 测试：425 vitest 全绿 + 7 Playwright E2E 全绿 + vue-tsc EXIT 0
- 架构修复：D-028（类型 SSOT 归位）+ D-029（匹配算法复用）在编码期发现并修复
