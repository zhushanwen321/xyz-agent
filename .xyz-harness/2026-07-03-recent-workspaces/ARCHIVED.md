# ARCHIVED.md — 2026-07-03-recent-workspaces

**归档日期**：2026-07-03
**状态**：archived（只读，不再修改）

## 主题

最近工作区记录功能——独立持久化用户最近使用的目录（cwd），解耦对 pi session 文件扫描的依赖。LRU 淘汰保 10、去重、debounce + atomicWrite 持久化、pull-only RPC、前端 popover 展示与搜索。

## 沉淀去向

| 目标文档 | 内容 | 溯源 |
|---------|------|------|
| `docs/adr/0002-recent-workspaces-three-layer-architecture.md` | D-003 三层架构（不引入 DDD4） | §system-architecture §1, §decisions D-003 |
| `docs/adr/0003-recent-workspaces-pull-only-rpc.md` | D-004 pull-only RPC（不做 broadcast） | §system-architecture §6, §decisions D-004 |
| `docs/adr/0004-recent-workspaces-writeback-atomicwrite.md` | D-005 write-back + atomicWrite 持久化 | §system-architecture §7, §decisions D-005 |
| `NFR.md` S-13~S-17 | 5 条已代码验证的工程约束（INV-5 动态路径 / INV-4 损坏降级 / atomicWrite / INV-6 load 时序 / INV-1 双层守卫） | §non-functional-design 缓解项回灌表 |
| `PRODUCT.md` | 产品级非目标（不引入 SQLite / 不做跨机器同步 / 冷启动空开始 / 与 pi 隔离） | §requirements §7 不做边界 |
| `ARCHITECTURE.md` | Runtime services 域更新（六域→七域，新增 workspace） | §system-architecture |
| `TEST-STRATEGY.md` §4/§5 | 回归基线（store 走门面 / real E2E fixture） | §execution |
| `DESIGN-LOG.md` | 本 topic 归档登记（新建任务/Session 流程领域） | — |

## ~~[UNVERIFIED] 项~~（原 1 条，已于 2026-07-03 补全）

原 INV-7（选中失效 cwd 降级）已补全实现并沉淀 NFR.md S-18：
- `session-lifecycle.create` 加 existsSync + homedir 降级（与 restoreSession 对称）
- `useNewTaskFlow.submitFirstMessage` 比对 cwd + toast 通知
- `session-service.test.ts` + `use-new-task-flow.test.ts` 补真实断言

详见 closeout-report.md UV-1。

## 留 topic 保留

- `decisions.md`（完整决策审计链，含 revisit 记录）
- `retrospect.md`（执行过程复盘）
- `code-skeleton/`（可编译骨架，设计验证产物）
- 6 个 deliverable .md（①-⑥ 设计产出快照）
