---
topic: 2026-07-03-recent-workspaces
archived: true
unverified_count: 0
closeout_date: 2026-07-03
---

# Closeout Report — recent-workspaces

## 沉淀清单

| # | 源 deliverable | 目标文档 | 溯源 | 内容摘要 |
|---|---------------|---------|------|---------|
| 1 | ③issues + decisions | `docs/adr/0002-...-three-layer-architecture.md` | `[from: §system-arch §1, D-003]` | D-003 三层架构（不引入 DDD4） |
| 2 | ③issues + decisions | `docs/adr/0003-...-pull-only-rpc.md` | `[from: §system-arch §6, D-004]` | D-004 pull-only RPC（不做 broadcast） |
| 3 | ③issues + decisions | `docs/adr/0004-...-writeback-atomicwrite.md` | `[from: §system-arch §7, D-005]` | D-005 write-back + atomicWrite |
| 4 | ④nfr | `NFR.md` S-13 | `[from: §nfr Issue#1 INV-5]` | getConfigDir 动态化 |
| 5 | ④nfr | `NFR.md` S-14 | `[from: §nfr Issue#1 INV-4]` | 损坏降级 [] |
| 6 | ④nfr | `NFR.md` S-15 | `[from: §nfr Issue#1 atomicWrite]` | atomicWrite 一致性 |
| 7 | ④nfr | `NFR.md` S-16 | `[from: §nfr Issue#2 INV-1]` | 双层守卫 |
| 8 | ④nfr | `NFR.md` S-17 | `[from: §nfr Issue#4 INV-6]` | load 在 presetCwd 前 |
| 9 | ①requirements | `PRODUCT.md` | `[from: §requirements §7]` | 产品级非目标 |
| 10 | ②system-arch | `ARCHITECTURE.md` | `[from: §system-arch]` | Runtime services 七域（+workspace） |
| 11 | ⑥execution | `TEST-STRATEGY.md` §4/§5 | `[from: §execution]` | store 走门面基线 + real E2E fixture 基线 |
| 12 | — | `DESIGN-LOG.md` | — | topic 归档登记（新建任务/Session 流程领域） |

## [UNVERIFIED] 清单（0 条，原 UV-1 INV-7 已于 2026-07-03 补全实现并沉淀 NFR.md S-18）

### UV-1（已补全，2026-07-03 INV-7 实现后重跑 closeout）

**状态**：已补全。代码已落地，沉淀进 NFR.md S-18。原未验证标记已消除。

- **④原约束**：`non-functional-design.md` Issue#6 缓解项 INV-7（D-008）—— 选中已不存在的 cwd → toast 提示「目录 X 已不存在，已切换到主目录」+ 静默 fallback homedir。已补全实现（session-lifecycle.create 加 existsSync 降级 + useNewTaskFlow 比对 toast）。
- **缺失证据**：
  - `DirSelectPopover.vue:66-68` `selectWorkspace(ws)` 只 `emit('select', { cwd: ws.cwd })`，无 existsSync 校验
  - `useNewTaskFlow.ts:202` `pendingCwd.value = cwd`，接收后无校验直接写
  - 全 renderer 源码 grep `existsSync|homedir|已不存在|已切换` 无 INV-7 相关命中
  - T4.4 测试（`dir-select-popover-workspace.test.ts:85`）断言的是 `emitted('select')` payload 格式，**未断言 toast + fallback**——语义偷换
- **影响**：用户选中已被删除的 cwd（worktree 清理/手动删目录）→ create session 用失效 cwd → 后续 fs 操作报错（未降级）
- **待补**：~~实现 existsSync 校验 + toast + homedir fallback + 补 T4.4 真实断言~~ **已补全**（2026-07-03）：session-lifecycle.create 与 restoreSession 对称加 existsSync+homedir 降级，useNewTaskFlow 比对 cwd toast，session-service.test + use-new-task-flow.test 补真实断言，已沉淀 NFR.md S-18

## 清理记录

- 删除 `changes/`（30 个过程产物：tracing/review/backfeed/machine-check/consistency/test-results）
- 删除 6 个 `*.html`（coding-visualizer 可重新生成）
- 保留 `decisions.md`（决策审计链）+ `retrospect.md`（执行复盘）+ `code-skeleton/`（骨架验证产物）+ 6 deliverable .md（设计快照）

## 代码一致性验证（Step 1b）汇总

| ④约束 | 验证方式 | 代码证据 | 结果 |
|--------|---------|---------|------|
| INV-5 getConfigDir 动态化 | grep store 构造 | `recent-workspaces-store.ts:38-39` join(configDir, FILE_NAME) | ✅ 沉淀 S-1 |
| INV-4 损坏降级 [] | grep try/catch | `:116-128` try { JSON.parse } catch | ✅ 沉淀 S-2 |
| atomicWrite 一致性 | grep atomicWrite | `:141` atomicWrite 调用 | ✅ 沉淀 S-3 |
| INV-1 双层守卫 | grep service+store 守卫 | service `:22` + store `:55` cwd.trim() | ✅ 沉淀 S-4 |
| INV-6 load 在 presetCwd 前 | grep initApp 时序 | `useSidebar.ts:360-364` await load → presetCwd | ✅ 沉淀 S-5 |
| existsSync 无穿越 | 骨架级（复用 session-lifecycle） | 复用既有模式 | ✅（随 S-3 一并记录） |
| INV-7 toast + homedir fallback | grep + 测试断言核对 | `session-lifecycle.create:43-49` existsSync+homedir 降级 + `useNewTaskFlow:159-163` 比对 toast | ✅ 补沉淀 S-18（2026-07-03 补全） |
