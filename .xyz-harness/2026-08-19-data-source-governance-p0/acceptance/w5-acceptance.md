# W5 验收标准：等价性测试骨架（pi fixture + live≡reload 雏形）

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §2 W5 节（L199-223，基线 commit 见 ledger）是 W5 的验收权威。builder 与 verifier 禁止修改两者。
> 规格 SSOT = plan W5 节全文；本文档只做锁定提炼与协调条款补充。两者冲突时以 plan 为准并上报主 agent。

## 目标（一句话）

`packages/runtime/src/__tests__/equivalence/` 目录就绪——真实 pi 子进程 fixture 可复用（净新增基建，仓库无先例），`live ≡ reload` 断言雏形可运行，后续 wave（W7-W12、W20-W22、W25）的等价性断言都在此挂载。

## 交付物（文件级）

1. `packages/runtime/src/__tests__/equivalence/pi-fixture.ts` [新增]：
   - `spawnPiFixture()`：临时目录 session-dir、spawn 真实 `pi --mode rpc` 子进程
   - pi 可执行文件定位：`execSync('which pi')`（macOS/Linux）/ `execSync('where pi')`（Windows）——命令形态与生产代码 `process-manager.ts:52` 完全一致（`isWindows ? 'where pi' : 'which pi'`）；探测失败返回 null 进入 skip 语义
   - `sendCommand` 封装（stdin 写 JSONL 行）、`collectEvents()`（收事件流）、`dispose()`（kill + 清理临时目录）
   - 冷启动就绪等待：上限 5s（探针结论中位数 ~500ms）
2. `packages/runtime/src/__tests__/equivalence/live-reload.test.ts` [新增]：
   - 最小操作序列（发一条 prompt 等 turn 完成）→ 断言「实时累积的 entry/消息快照 == `get_entries` 全量重放快照」
   - 此阶段断言对象为原始 entry 序列（W20-W21 后升级 store 级）
   - vitest 配置沿用 `packages/runtime/vitest.config.ts`（注意：runtime 测试有双目录布局——`test/` 与 `src/__tests__/`，本 wave 归属后者，equivalence 目录随本 wave 创建）

## 契约锁定

- skip-if-no-pi 语义（本 wave 净新增约定，写入 fixture 文件头注释，作为后续 equivalence 用例唯一引用点）：fixture 模块顶层 `const PI_PATH = detectPi()`；测试用 `describe.skipIf(!PI_PATH)` / `it.skipIf(!PI_PATH)` 包裹真实 spawn 用例——pi 缺席时 skip（skip 计数 >0）而非 fail。
- 临时目录清理：dispose 后 session-dir `existsSync` 断言 false（测试内验证）。
- 禁止 mock pi 子进程（`vi.mock('node:child_process')` 形态）——本 wave 价值就在真实 spawn；pi 缺席走 skip 而非 mock。
- spawn 命令形态：`pi --mode rpc --session-dir <tmp> --model <model> --approve`；model 用低成本模型（如 `xiaomi-token-plan-cn/mimo-v2.5-pro`，workspace AGENTS.md pi 实测流程同款）。

## 单测验收

- live-reload.test.ts 至少一条真实 spawn 用例（pi 在场时跑通）：实时累积 entry 快照与 `get_entries` 全量重放逐条一致（deep equal 或逐字段断言，禁止只断言长度）。

## 通过命令（builder 自验 + verifier 实跑）

1. `cd packages/runtime && pnpm exec vitest run src/__tests__/equivalence/` → 通过（环境有 pi binary 时真实跑；无 pi 时 skip 且 skip 计数 >0，fail 数 = 0）
2. 断言非空转验证（plan W5 验收 2）：临时注入断言失败对照（如 `expect(a).toBe(b+1)`）→ 测试确实红；还原后绿。verifier 复现此验证。
3. 回归：`cd packages/runtime && pnpm typecheck && pnpm test` 全量通过（含清理断言）。

## 禁改清单（越界 = 验收失败）

- `docs/architecture/data-source-governance-plan.md`、本 acceptance 文档
- **W1 领地**（另一 builder 并行中）：`packages/runtime/src/infra/pi/rpc-client.ts`、`services/ports/pi-engine.ts`、`services/session/session-lifecycle.ts`、`services/session/session-service.ts`、`services/session/types.ts`、`test/rpc-client.test.ts`、`test/session-service*.test.ts`——一律不碰
- runtime 既有源码与测试文件（本 wave 只新增 equivalence 目录两文件，不改任何既有文件；若 vitest 配置确需改动，停下上报主 agent，不得擅自改）
- 禁止 git add/commit/push；禁止 mock pi 子进程；禁止 `any`

## 备注

- 净新增基建无先例可抄，按 M 档上限（~250-300 行）执行；若发现需多 pi 版本矩阵等超预算形态，上报调级而非压缩清理逻辑（plan 规模复核要求）。
- 此测试族成为 W7-W12、W20-W22 各 wave 验收运行基线，不另起炉灶。
