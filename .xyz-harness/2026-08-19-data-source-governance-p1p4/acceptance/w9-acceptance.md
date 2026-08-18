# W9 验收标准：删除 sessionMetaCache（影子状态库退场）

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §3 W9 节（L314-341）是 W9 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W7（label/thinkingLevel 实例就位并已承接读方）。

## 目标（一句话）

label/thinkingLevel 影子状态库 `sessionMetaCache` 退场，读写全部走 W7 的实例。

## 防误删澄清（附录 A #2，本 wave 最重要边界）

存在**两个同名** `sessionMetaCache`：
- **本 wave 删除对象**：`packages/runtime/src/services/session/session-meta-cache.ts`（sessionId 键，label/thinkingLevel 影子缓存）+ 其测试文件
- **任何 wave 不得动**：`packages/runtime/src/infra/pi/session-file-utils.ts` 内模块级 `const sessionMetaCache = new Map<string, CachedSessionMeta>()`（filePath 键，(mtimeMs,size) 文件头解析**纯派生**缓存，D1 表「保留」类）

## 交付物

1. `packages/runtime/src/services/session/session-meta-cache.ts`（删除）+ `session-meta-cache.test.ts`（删除）
2. `packages/runtime/src/services/session/session-lifecycle.ts`（修改：renameSession 的 sessionMetaCache.setLabel 删除，label 内存态读实例）
3. `packages/runtime/src/index.ts`（修改：sessionMetaCache 直写/注入点删除，改经实例/markDirty）
4. `packages/runtime/src/services/session/session-service.ts`（修改：getThinkingLevel 等读点改读实例；写点删除）
5. 全量找引用机械适配：`grep -rn "from.*session-meta-cache" packages/runtime/src --include="*.ts"` 逐文件改（写点清单已核实于 plan：session-lifecycle / index / event-interpreter 注入点——W7 已 markDirty 化，此处删注入）
6. broadcastSessionList 类读 label 路径改「实例快照 + 磁盘扫描合并」（扫描侧仍走 session-scanner，占位值守卫 W15 补）

## 通过命令（builder 自验 + verifier 实跑）

1. 删除性：`test ! -f packages/runtime/src/services/session/session-meta-cache.ts && echo DELETED`；`grep -rn "session-meta-cache" packages/runtime/src --include="*.ts"` 命中 = 0；`grep -rn "sessionMetaCache" packages/runtime/src/services/session/ --include="*.ts"` 命中 = 0（services/session 下彻底退场）
2. **保留性断言（防误删）**：`grep -n "const sessionMetaCache" packages/runtime/src/infra/pi/session-file-utils.ts` 仍命中（文件头纯派生缓存完好）
3. `cd packages/runtime && pnpm typecheck && pnpm test` 全量通过（原 session-meta-cache.test.ts 删除后无悬挂 import）
4. 行为级（手动改名侧栏显示 / auto-rename / 重开列表）留 P1 gate；单测层：既有 rename/session-list 相关测试全绿

## 执行纪律

- **独立 commit**（回滚保障：revert 本 commit 即完整恢复 cache 与全部写方——主 agent 保证 commit 粒度，builder 无需操作）
- 禁改清单：验收权威文档 / replicated-state.ts（W6）/ replicated-states.config.ts 配置语义（W7/W8 交付——机械 import 适配允许，语义改动上报）/ session-file-utils.ts 内的 sessionMetaCache（防误删边界）/ extensions/（W17）/ event-adapter（W18/W21 段）
- 禁 git 写操作；禁 any

## 备注

- 完成后解锁 W10（同文件串行）。
