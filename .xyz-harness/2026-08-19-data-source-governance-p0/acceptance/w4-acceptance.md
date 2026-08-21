# W4 验收标准：R2 骨架 + R3 taste-lint 两条规则

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §2 W4 节（L172-197，基线 commit 见 ledger）是 W4 的验收权威。builder 与 verifier 禁止修改两者。
> 规格 SSOT = plan W4 节全文；本文档只做锁定提炼。两者冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W2 已 committed（R3 注解引用登记表条目编号；R2 许可表来自登记表）。

## 目标（一句话）

新增模块级缓存必须带 `@data-owner <登记表条目>` 注解且条目真实（R3）；store mutation 只能被 owner 文件直呼（R2 首版拦直呼形态，调用图收紧留 W24）。

## 交付物

1. `taste-lint/rules/require-data-owner-annotation.mjs` [新增]（R3）
2. `taste-lint/rules/no-non-owner-store-mutation.mjs` [新增]（R2 骨架）
3. `taste-lint/base.mjs`（修改：注册两条规则，对齐现有 13 条规则的注册方式）
4. `packages/renderer/src/stores/` 下存量带模块级缓存的文件（修改：补 `@data-owner` 注解使存量合规——执行时 grep 找出全部命中，预估 ≤3 个）

## 核心规格锁定（plan W4 步骤 1-4）

1. **R3**：检测模块级 `new Map(` / `ref(` 缓存声明；无 `@data-owner <登记表条目编号>` 注释则报错，文案指向 registry。豁免：测试文件、`useSessionScopedState` 内部实现（原语本体豁免，登记为规则内注释）。
2. **R2 骨架**：首版拦直呼形态——import 某 store 后在其 owner 文件之外直调 mutation（`setGroups` / `updateLabel` / `updateSessionState` 等首版许可清单 = 空之外的登记表条目）；AST 遍历模式复用现有规则；调用图分析留 W24。
3. 注册 + 存量修复：两条规则在 base.mjs 注册；R3 首扫命中全部正面补注解（条目编号引用 W2 登记表；plugin sessionData 等已 owner 化条目直接引用）。
4. **误报豁免闭环**：规则支持行内豁免注释 + 要求同步在登记表补条目（对齐 check-domain-boundaries allowlist 先例，写在规则 docstring）。

## 通过命令（builder 自验 + verifier 实跑）

1. R3 检出力：在 `packages/renderer/src/stores/` 临时文件写 `const cache = new Map()` 无注解 → lint 报错（文案含 registry 指引）；补 `@data-owner` 注解后通过；删除临时文件。
2. R2 检出力：临时文件 import session store 并直调 `updateLabel` → 报错；删除后通过。
3. 回归：`pnpm run lint` 全仓通过（存量已补注解零新增违规）；`cd packages/renderer && pnpm typecheck && pnpm test` 通过（存量补注释零行为影响）。
4. 规则自检：read `taste-lint/rules/` 现有规则是否带测试文件，按同一方式为两条新规则补最小用例，全部通过。

## 禁改清单（越界 = 验收失败）

- 两个验收权威文档（w4-acceptance.md / data-source-governance-plan.md）
- 任何 packages/ 生产代码除「存量补注解」清单第 4 条外（发现需要改生产行为 = 规格冲突，停下上报）
- taste-lint 既有规则文件（只新增两条 + 改 base.mjs 注册段）
- W3 领地（.githooks/ 全部）——W3 可能并行派发中
- 禁止 git add/commit/push；禁止 eslint-disable-next-line 静默（误报修正规则本体，全局 AGENTS.md 原则）

## 备注

- 派发前置：W2 committed。
- 与 W3 领地不相交可并行。
