# W15 验收标准：scannedToSummary 空值守卫

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §4 W15 节（L490-511）是 W15 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W13（守卫挂 applySnapshot 合并策略——全量路径唯一入口成形）。

## 目标（一句话）

磁盘扫描占位值（modelId: '' / tokenCount: 0）永不覆盖已知真值——#2 空串覆盖的最后防线（D1b：空值守卫仅用于磁盘扫描占位值路径，与 owner 快照整字段覆盖语义不混用）。

## 交付物

1. `packages/runtime/src/services/session/session-scanner.ts`（修改：scannedToSummary L81-82 占位字段语义显式化——DTO 加来源标记（`modelSource: 'scan-placeholder'` 之类，字段名以 W13 DTO 定义为准，倾向显式标记）或维持空值 + 合并侧按来源判定，二选一以 W13 DTO 结构为准）
2. `packages/core/src/domain/session/store.ts`（修改：applySnapshot 合并规则加一条**仅扫描来源生效**的守卫：modelId === '' 且来源=扫描 → 保留当前非空值；tokenCount === 0 且来源=扫描 → 同；**不与 owner 快照空值语义混用**——sessionName undefined 是权威空值必须覆盖，两条并存于同一合并函数但按来源分流）
3. 历史注释更新：core/src/domain/session/store.ts:70 附近「setGroups 全量覆盖曾把真值抹成空串」踩坑注释保留并指向本守卫
4. 用例 ≥4：扫描占位 modelId 不覆盖真值 / 扫描占位 tokenCount 不覆盖真值 / owner 快照 sessionName=undefined **必须**覆盖旧名（防守卫扩大化）/ owner 快照 modelId 真值正常覆盖

## 通过命令（builder 自验 + verifier 实跑）

1. `cd packages/core && pnpm typecheck && pnpm test`（含 ≥4 新用例）+ `cd packages/runtime && pnpm typecheck && pnpm test`（session-scanner 相关）
2. 行为级（重启 app 空串不回退闪烁）留 P2 gate
3. 回归：重开后列表条目数与 sessions 目录文件数一致（扫描全量不丢条目）——单测层

## 禁改清单

- 验收权威文档；登记表；W13 领地（session store 其余逻辑）；runtime 六实例；chat 域；extensions
- 禁 git 写操作；禁 any

## 备注

- 完成后 P2 收官 → P2 gate。
