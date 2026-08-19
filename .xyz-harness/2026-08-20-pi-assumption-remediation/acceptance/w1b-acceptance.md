# W1b 验收基线：provider-repair 八字段有效性对齐（数据丢失级）

> 防篡改：本文件是 W1b 验收 SSOT，builder/verifier 禁改。设计依据 = `docs/architecture/pi-assumption-remediation.md` §3.1 W1b；证据 = 审计报告 A-02。

## pi 语义锚点（已核实，直接采信）

- 0.84.1 `applyModelsJson` 抛错条件 = **八字段全空**（`node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js:86-93`）：`models` 非空 / `baseUrl` / `headers` / `compat` / `modelOverrides` 非空 / `apiKey` / `oauth` / `authHeader !== undefined` ——任一存在即合法。
- xyz 侧 `pi-provider-repair.ts`（`packages/runtime/src/infra/pi/`）的 `isInvalidProvider` 沿用 0.80.3 五字段空壳判定（配合 `pi-provider-store.ts:427-460` 的 sanitizeInvalidProviders）→ 只配 apiKey 的合法 provider 被 phys本删除。

## 交付物

1. `isInvalidProvider` 判定对齐 pi 0.84.1：八字段任一存在 = 有效（判定逻辑与 pi `applyModelsJson` 抛错条件同构，注释附 dist 锚点）；`sanitizeInvalidProviders` 仅清真空壳。
2. 防误删测试：models.json 含「只配 apiKey」provider → sanitize 后完好；真空壳 → 被清；「只配 oauth」「只配 authHeader」边界各一。真实文件系统（测试 tmp，禁 mock fs）。
3. 注释修正：旧五字段判定的出处说明 + 「曾在本 bug 下被误删的配置不追溯恢复（用户手动重配），修复只保证今后不删」known-issue 声明。
4. 既有 provider 相关测试更新（若有断言旧五字段行为，按新语义改写并标注 [W1b 语义变更]）。

## 验收条款

| # | 条款 | 证伪点 |
|---|------|--------|
| C1 | isInvalidProvider 与 pi applyModelsJson 抛错条件同构（逐字段对照） | 源码 + 注释锚点 |
| C2 | 防误删三例 + 空壳清理例全绿 | 测试实跑 |
| C3 | `cd packages/runtime && pnpm typecheck && pnpm exec vitest run` 全绿 | 命令实跑 |
| C4 | R1：`python3 .githooks/check_pi_direct_write.py` exit 0 | 命令实跑 |

## 边界

- 只许改：`packages/runtime/src/infra/pi/pi-provider-repair.ts`、`pi-provider-store.ts`（若判定在其内）+ 对应测试文件。
- 禁碰：model-switch（W1a 领地）、event-adapter/pi-protocol（W3）、extensions、shared。
- 禁 git 写。
