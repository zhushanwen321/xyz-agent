# xyz-agent 架构重构 · 迁移执行计划（索引）

**版本**: 1.1 · **日期**: 2026-06-16 · **分支**: refactor-architecture-design
**上游 spec**: [architecture-design.md](architecture-design.md)（D1–D9 + G1–G7）
**核对依据**: [changes/tracing-round-1.md](changes/tracing-round-1.md)

> 本文件是**索引与全局约束**。各阶段细节见 `plan/` 子文档。

---

## 与原设计的差异（D6c 订正）

经代码核对，原 D6c「服务循环依赖」诊断**不成立**——Session↔Plugin↔Model 无编译期循环，hook 注入已是 IoC，setter 是正常 DI。因此：

- 阶段 3 瘦身：去掉「引入事件总线」「switchModel 收敛」，只保留「拆 session-service 巨石」（T2）。
- 事件总线降级为**可选未来演进**（见 `plan/phase-3-split-session-service.md` 末尾），不在必做项。

## 总体策略

- **每阶段独立 commit + 独立验证**（CLAUDE.md #12：禁止一次性大重构）。
- **阶段间无强耦合**：1（前端）与 2（Runtime）可并行（不同进程）；出问题 `git revert <commit>` 回退单阶段。
- **优先做**：阶段 1（R4 API Client）+ 阶段 3（T2 拆 session-service）治两个最痛的点。

## 阶段总览

| 阶段 | 主题 | 风险 | 改动 | 子文档 |
|------|------|------|------|--------|
| 0 | 文档与认知 | 0 | 0（仅文档） | [phase-0-documentation.md](plan/phase-0-documentation.md) |
| 1 | 前端 API Client 层 | 低 | 中 | [phase-1-api-client.md](plan/phase-1-api-client.md) |
| 2 | Runtime 目录分层 | 低 | 中 | [phase-2-runtime-layering.md](plan/phase-2-runtime-layering.md) |
| 2.5 | Main 进程重构（M1 spawn 去重） | 中 | 低 | [phase-2.5-main-process.md](plan/phase-2.5-main-process.md)（M3 已降级为文档化） |
| 3 | 拆 session-service 巨石 | 中 | 中 | [phase-3-split-session-service.md](plan/phase-3-split-session-service.md) |
| 4 | 命名对齐 | 低 | 小 | [phase-4-naming-alignment.md](plan/phase-4-naming-alignment.md) |
| 5 | 防护加固 | 低 | 小 | [phase-5-guardrails.md](plan/phase-5-guardrails.md) |

**建议顺序**：0 → 1 → 2 → 2.5 → 3 → 4 → 5。1 与 2 可并行；3 与 2.5 可并行（不同进程）。

---

## 全局迁移铁律（所有阶段适用）

1. **每阶段独立 commit、独立验证**——禁止跨阶段混在一个 commit。
2. **阶段 2 目录迁移必须同步 tsup.config.ts**——entry/noExternal/asarUnpack 联动，否则打包崩（CLAUDE.md #12）。
3. **阶段 1 灰度并存**——api + 直 send 共存，逐个 composable 迁移，不破坏现有事件流。
4. **阶段 3 先写 vitest**——覆盖 sendMessage（含 hook 拦截）、switchModel、abort 三条路径再动结构。
5. **命名变更用 `git mv`**——保留历史追踪。
6. **回滚（G7）**——每阶段独立 commit，出问题 `git revert <commit>`。禁止跨阶段部分回滚（如只迁一半 composable，会造成 api/直 send 混用中间态）。

## 决策到阶段映射

| 决策 | 落地阶段 |
|------|---------|
| D1 双通道/启动时序 | 阶段 0（文档，**按代码现状写**：createWindow 先于 spawn）+ 阶段 5（集成测试） |
| D2 双真相源/单实例语义（G1） | 阶段 0（文档）；Main 原子 claim 超出本重构 scope（标注） |
| D3 API Client | 阶段 1 |
| D4 Runtime 四层 | 阶段 2 |
| D5 双维度模型 | 阶段 0（认知） |
| D6a 错误流 / D6b 路由 / G5 重连收尾 | 阶段 1（G5 决策 A：路由层收尾 + 清队列） |
| D6c 服务解耦 | 已订正，事件总线为可选演进（不在必做项） |
| D7 命名债 | 阶段 2（SidecarServer + 17 处注释）+ 阶段 4（R2–R5） |
| D8 mock / D9 协议复用 | 阶段 1 |
| G3–G6 API Client 细则 | 阶段 1 |
| G7 回滚 | 全局铁律 |
| T2 拆 session-service | 阶段 3 |
| **M1 spawn 去重** | **阶段 2.5** |
| **M3 window-manager 不存完整 tree** | **阶段 0（仅文档化，已降级）**——plan-review-round-3：改 Set 丢 paneId 契约 + 风险弱 + spec 已定低优 |
