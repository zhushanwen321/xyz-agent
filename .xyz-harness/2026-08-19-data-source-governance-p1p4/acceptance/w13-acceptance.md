# W13 验收标准：session store 单一 applySnapshot 入口 + view-ready DTO

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §4 W13 节（L438-463）是 W13 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W12（runtime 侧 owner 快照发布就位）。

## 目标（一句话）

renderer/core 的 session store 写入口收敛为单一 `applySnapshot`，WS 推送的 session 级数据是 view-ready DTO，renderer 零派生（D7）。

## 交付物

1. `packages/core/src/domain/session/store.ts`（修改：updateLabel（L56）/ updateSessionState（L73）/ setGroups（L109）三写入口收敛为 `applySnapshot`；合并规则 = D1b——owner 快照整字段覆盖含显式空值 + 磁盘占位值守卫挂点（守卫实现留 W15，本 wave 合并策略留挂点）；乐观更新（用户改名先显示）保留为 applySnapshot 本地入参形态）
2. `packages/shared/src/protocol.ts`（修改：`SessionViewSnapshot` DTO——label / status / modelId / thinkingLevel / usagePercent / pendingMessageCount / commands 等 view-ready 字段）
3. 消费方改写：`grep -rn "updateLabel\|updateSessionState\|setGroups" packages/renderer/src packages/core/src --include="*.ts" --include="*.vue" | grep -v __tests__` 定位全部调用点逐一改 applySnapshot
4. 对应测试更新

## 关键锁定

- 三个公开 mutation 删除（R2 许可表联动：applySnapshot 成为唯一合法 mutation，W4 R2 骨架的受管清单同步更新——`taste-lint/rules/no-non-owner-store-mutation.mjs` 受管方法列表改为 applySnapshot）
- renderer `stores/session.ts` 是 ADR-0059 薄壳无需改动（改动全在 core factory 与消费 composables）
- 派生逻辑上移仅限 session 域（chat 域 W20-W21 已做，不越界）
- 双 pane（split mode）ADR-0049 分区范式不破坏（useSessionScopedState 使用处不改为实例级状态）

## 通过命令（builder 自验 + verifier 实跑）

1. `grep -n "updateLabel\|updateSessionState\|setGroups" packages/core/src/domain/session/store.ts` 命中 = 0；`grep -rn "applySnapshot" packages/core/src/domain/session/store.ts` ≥1；`cd packages/core && pnpm typecheck && pnpm test` + `cd packages/renderer && pnpm typecheck && pnpm test` 通过
2. R2 联动：`pnpm run lint` 全仓通过（受管清单更新后无直呼残留）
3. 行为级（场景 2 后半：断连重连侧栏一致）留 P2 gate；单测层：applySnapshot 合并规则用例（整字段覆盖/显式空值覆盖/乐观更新形态）

## 禁改清单

- 验收权威文档；登记表；W12 领地（runtime session-service/event-interpreter/message-bus）
- chat 域（W21 已交付）；extensions/；message-bus TOPIC_TABLE
- 禁 git 写操作；禁 any；禁原生 HTML/Emoji（renderer 规范）

## 备注

- 完成后解锁 W15（守卫）与 W24（R2 收紧）。
