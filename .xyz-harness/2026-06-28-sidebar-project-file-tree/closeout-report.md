---
archived: true
unverified_count: 0
topic: 2026-06-28-sidebar-project-file-tree
closeout_date: 2026-06-30
---

# Closeout Report — sidebar-project-file-tree

## 沉淀清单

| # | 源 deliverable | 目标文档 | 溯源 | 内容摘要 |
|---|---------------|---------|------|---------|
| 1 | ③issues D-001 | ADR-0025 | §1 | File View 语义重定义（全项目树，推翻旧改动清单语义）|
| 2 | ③issues D-009 | ADR-0026 | §5,§7 | 懒加载策略（顶层+一级子首加载，展开按需单层）|
| 3 | ③issues D-008/D-013 | ADR-0027 | §6,§10 | FileService 三层 + IFileExecutor port + ignore 纯函数范式 |
| 4 | ④nfr S-1 | NFR.md NFR-S1 | §S-1 | 路径越界统一守门（isUnderOrEqual 词法判定）|
| 5 | ④nfr S-3 | NFR.md NFR-S3 | §S-3 | git 命令防注入（execFileSync 数组形式）|
| 6 | ④nfr S-4 | NFR.md NFR-S4 | §S-4 | 禁 v-html（XSS 防护，文本插值/<pre>）|
| 7 | ④nfr S-5 | NFR.md NFR-S1 | §S-5 | git.diff 越界新校验（path_not_allowed）|
| 8 | ④nfr K-2 | NFR.md NFR-R1 | §K-2 | 超时机制（10s，withTimeout）|
| 9 | ④nfr AC-3.8 | NFR.md NFR-R2 | §AC-3.8 | 幂等去重（inFlight Map）|
| 10 | ④nfr K-9/AC-3.11 | NFR.md NFR-A2 | §K-9 | 跨 store 编排在 composable 层 |
| 11 | 2026-06-30 复盘 | NFR.md NFR-A1 | §3.1 | shared 层禁 node 内置模块（教训）|
| 12 | 2026-06-30 复盘 | NFR.md NFR-T1 | §5 | E2E dev 冒烟闸门（教训）|
| 13 | ⑥execution + 复盘 | TEST-STRATEGY.md §2 | §2/W8 | E2E 从手动升级为 Playwright |
| 14 | ②system-arch | ARCHITECTURE.md | §子系统 | 子系统索引加文件树 + ADR 索引 0025~0027 |

## [UNVERIFIED] 清单

**0 条**。所有 ④nfr 约束在代码中找到落地证据（grep 验证）：
- NFR-S1: `file-service.ts` isUnderOrEqual ✓ / `git-service.ts` path_not_allowed ✓
- NFR-S3: `git-executor.ts` execFileSync 数组 ✓
- NFR-S4: `DetailPane.vue` 无 v-html，用 `<pre>{{ }}` ✓
- NFR-R1: `file-service.ts` READ_TIMEOUT_MS + withTimeout ✓
- NFR-R2: `useFileTree.ts` inFlight Map ✓
- NFR-A1: `shared/src/` grep `from 'node:'` 空 ✓
- NFR-A2: `useFileTree.ts` setupInvalidation（composable 层 watch）✓

## 清理记录

- 删 `changes/`（tracing/review/backfeed 过程产物）
- 删 `*.html`（6 个可视化产物）
- 保留 `decisions.md`（决策审计链）
- 保留 6 个 deliverable `.md`（事后追溯）
- 保留 `code-skeleton/`（参考）

## 实施验证

- 编码 commits: e8518a8d（W0）→ fb00f27c（W1a）→ ea723585（W1b）→ c138998d（W2）→ 775077ed（W3）→ 27f0313d（W4-W7）→ d85d639c（W8 E2E）→ 4d9a772f（path-guard 修复）→ 2d99cc52（lint/E2E 修复）
- 测试：runtime 1046 + renderer 270 + shared 20 + e2e 11 = 1347 PASS
- dev 启动验证：chromium 加载 dev renderer，0 console error
- lint: 0 errors

## 教训（关联复盘）

本次实施引入一个严重 bug（shared/path-guard.ts node:path 越界），E2E mock 模式掩盖了 8 个 Wave。已在 `.xyz-harness/2026-06-30-e2e-retrospect/` 详细复盘，教训固化为 NFR-A1（shared 禁 node 内置）+ NFR-T1（E2E dev 冒烟闸门）。
