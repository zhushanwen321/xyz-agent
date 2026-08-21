# W24 验收报告：R2 调用图收紧 + R3 全域扩围

> verifier 独立验收（对抗模式）。基线 commit `ed26b3da8`；builder 交付为工作区未提交变更（ledger：W24 in flight）。
> 验收权威：`w24-acceptance.md` + plan §6 W24（L724-745）。冲突以 plan 为准。

## 结论：PASS

验收标准 4 条全部实测通过；附 1 个 major 检测面缺口（不阻断验收——超出验收字面要求的新增检测面存在未声明逃逸，建议下一 wave 或顺手修复）+ 5 个 minor 观察项。三上报裁决均倾向接受 builder 定案。

## 各检查点实测

### 1. 防篡改 — PASS

- `git diff ed26b3da8 -- .xyz-harness/.../w24-acceptance.md` → 空。
- `git diff ed26b3da8 -- docs/architecture/data-source-governance-plan.md` → 空（stat 与内容均空）。
- `docs/architecture/data-source-registry.md` 不在工作区变更清单（builder 未改登记表；豁免登记草稿交主 agent 的说法与实际一致）。

### 2. 范围 — PASS（minor：自报 35 vs 实际 34）

工作区 33 条目 = 32 修改 + 2 新增（`taste-lint/lib/parse-registry.mjs` + `.test.mjs`），合计 **34 文件**，builder 自报 35，差 1（未见第 35 个文件；无害计数差）。

生产代码 28 文件（renderer 20 + core 8）全量机检（超出抽验 5 个的要求）：diff 中所有 +/- 行均为注释行（`//` 开头、`taste:allow-no-data-owner W24-EX-x`、`@data-owner #N`）或空行，**零逻辑改动**。抽读 `useSessionDerivations.ts`（#11 statusCache + #7 digestCache）、`lru.ts`（EX-C）确认。

### 3. R2 调用图读码 — PASS

`/Users/zhushanwen/Code/xyz-agent-workspace/fix-chat-flow-order/taste-lint/rules/no-non-owner-store-mutation.mjs`：

- 形参转发链完整：`CallExpression` 收集 `f(store)` 实参为 store 表达式的调用 → `paramChannels`（L233-238）；`Program:exit` 时 `paramOwnerFn`（形参名 → 函数名，L285-292）；裁决要求候选调用的 `fnStack` 包含该函数（L302-304）——实参绑定 + 函数栈双重判定，声明晚于引用（hoisting）因延迟裁决天然正确。
- 方法引用（`MemberExpression` 值位置 + store 接收者，L241-250）与工厂包装（`ReturnStatement` 返回 store 表达式 → `storeReturningFns`，L204-209）两面均实现。
- 跨文件深形态 docstring 声明存在（L16-21：「转发函数定义在其他文件……跨文件数据流静态不可判定处维持 S1」），检测激活前提 = 本文件 import store 工厂（L252-254）。
- 许可表 `PERMITTED_FILES` 4 条目全部挂登记条目号（#1/#2）。

### 4. 许可表运行时解析 — PASS

- `parse-registry.mjs` 纯函数 + `loadRegistryEntries` fail loud（不可读/0 条目均 throw，错误信息指向登记表路径与恢复动作）。
- 真实登记表实测：正则命中 13 行（#1-#12 + P1），**全部**来自 §1 主表（逐行核 section），§3（`| 1. ` 行首）/§4（`| ① ` 行首）0 误收；测试文件的合成 §3/§4 用例同样覆盖。
- 条目引用核对：R2 `#1`/`#2`、R3 注解 `#7`/`#11` 均在 13 条集合内。
- **stalePermittedEntry 路径实测**：临时将规则 `PERMITTED_FILES` 首条 `'#1'` 改 `'#99'` → 探针 lint 输出 `stalePermittedEntry`（文案含登记表路径 + 许可文件后缀 + 双向核对指引）+ 原 `nonOwnerMutation`；还原后 `git diff` 无 `#99` 残留。

### 5. 三层转发独立复跑 — PASS（发现 1 个 major 检测面缺口，见下）

独立构造探针（非 builder 测试原文），直挂真实规则：

| 探针 | 结果 |
|---|---|
| 三层转发 A（箭头函数 `const flush = (st,p)=>{st.applySnapshot(p)}` + `flush(store,p)`） | 检出 `forwardedMutation`，文案含 `#1/#2` 登记条目 |
| 三层转发 B（`createSessionStore` from `@xyz-agent/core` 深路径 import + 函数声明） | 检出 `forwardedMutation`，文案含登记条目 |
| 方法引用 `const h = useSessionStore().applySnapshot` | 检出 `detachedMethodRef`，含登记条目文案（不含登记表路径——见 minor） |
| 工厂包装 块体 `function getStore(){return useSessionStore()}` / 块体箭头 / async | 检出 `wrappedFactoryMutation` |
| 工厂包装 **表达式体箭头** `const grab = () => useSessionStore()` | **漏检（major）** |
| 工厂包装 对象方法 `box={grab(){return useSessionStore()}}` + `box.grab()…` | 漏检（调用点 receiver 为 MemberExpression 也不进 candidates） |
| 非 store 实参（`keep=useSessionStore` 保激活 + `applyVia(o,p)`） | 0 报错（超集未扩大误报面） |

W4 直呼用例保留且通过：测试文件 8 条 W4 用例（含词法序盲点、许可文件、type-only import、测试豁免、行内豁免）在 38/38 中全绿。

### 6. R3 扩围抽验 — PASS（61 处口径已复核）

- 标记计数实测：`W24-EX-A` 14 / `EX-B` 30 / `EX-C` 10 / `EX-D` 4 = 58 豁免；`@data-owner` 生产注解 3 处（useSessionDerivations #11/#7 + useChat #7 historyTruncatedSessions）；W24 前存量注解 0（HEAD grep 空）。
- **全量复算**（329 文件内存 lint，剥除标记行后按 ruleId 过滤）：规则可标记声明 **60 处**；61 标记 = 60 + 1 处 `i18n/index.ts` `loadedLocales`（`new Set(['zh-CN'])` 字面量初始化——按 W24 口径属「常量查表」不受规则约束，builder 保守补标）。原样 lint 0 违规。
- EX-C 抽验：`api/pending.ts:36 pendingMap`（RPC pending promise 去重/超时表，传输层簿记）、`useFileChangeInvalidation.ts:76 overlayTimers`（one-shot 防抖定时器句柄表）确非 GUI 数据——分类合理。EX-D 4 处全在 `api/mock/index.ts`（VITE_MOCK 基建）——合理。

### 7. 注释 attach 修复验证 — PASS

- 2 个回归用例在套件内且绿（`export const + 紧贴豁免注释`、`docstring 块中部 @data-owner`）。
- 独立探针 5 例：export const + 紧贴豁免注释 → 0；docstring 中部 @data-owner #3 → 0；无注解 → 报错；**注解与声明隔空行 → 正确不归属（报错）**；注解上方隔代码行但紧贴声明 → 归属（正确——上方代码行不在注解与声明之间）。行回溯语义（声明行 + 向上连续注释行，空行/代码行断）全部符合 docstring 声明。

### 8. 回归 — PASS

- `node --test --test-timeout=60000 taste-lint/rules/*.test.mjs taste-lint/lib/*.test.mjs` → **38/38**（R2 14 + R3 18 + parse-registry 6）。
- `pnpm run lint` → **exit 0**（0 errors, 461 warnings——与 W4 基线一致的自报吻合）。
- renderer `pnpm typecheck` exit 0；`pnpm test` 3054 passed | 3 skipped。
- core `pnpm typecheck` exit 0；`pnpm test` 999 passed | 6 todo（77 files）。
- 「node --test 目录形式 MODULE_NOT_FOUND 须 glob」声明实测属实（`node --test taste-lint/rules/` → Cannot find module），测试文件头注释更正有效。

## 红性 / 复跑记录

- stale 注入正控：改 `#1`→`#99` 报 `stalePermittedEntry` → 还原 diff 干净。
- 剥标记正控：61 标记剥除后 60 处违规复现（规则确有咬合力，非恒绿）。
- 三层转发/方法引用/工厂包装独立正控探针（见检查点 5）。
- verifier 全程临时改动（规则文件 `#99` 注入、`.tmp-probe*.mjs`）均已还原/删除，`git status` 回到验收前 33 条目。

## 三上报裁决意见

1. **留 mjs 体系（vs scripts/ node 扫描器）：接受**。plan W24 明文允许二选一并要求汇报理由；交付语义与 plan 操作定义逐字吻合（「检测文件 import store 后经任意中间函数转发调用 mutation（一层起步）」= import 边激活 + 文件内一层转发）；单文件 AST 确为该语义的正确工具，scripts/ 体系无 AST parser 复用面；存量 0 误伤实测（lint exit 0）。注：acceptance doc 头条「跨文件调用图分析」是愿景式标题，跨文件深形态按 plan 归 S1（docstring 已诚实声明）——以 plan 为准，不构成冲突。
2. **W13 遗留用例修复：接受，流程教训成立**。实测 HEAD 版测试用例仍为 `updateLabel`/`setGroups` 直呼形态，而 HEAD 版规则 `WATCHED_MUTATIONS` 已只剩 `applySnapshot`（W13 收敛）——旧用例 `assert.equal(messages.length, 1)` 必红，W13 verifier 漏跑 node --test 属实。修复（改 applySnapshot 形态）正确且保留超集证明。教训建议主 agent 记入 harness：verifier 验收含 `node --test`（glob 形式，目录形式 node 24 不发现用例）。
3. **17→61 口径差：接受**。W4 的 17 为 stores 外正则/人工口径；AST 口径（ref/shallowRef/reactive 任意初值 + 空容器构造 + renderer/core 全域）实测 60 处可标记 + 1 处口径外保守补标 = 61 标记。数字按标记口径成立，分项（3 + 58 = 14/30/10/4）全部对上。

## 问题清单

**major（不阻断 PASS——属超出验收字面要求的新增检测面的未声明逃逸，建议修复）**

- `taste-lint/rules/no-non-owner-store-mutation.mjs` L204-209 + L219-231：工厂包装检测面漏「表达式体箭头函数」——`const grab = () => useSessionStore(); grab().applySnapshot({})` 0 报错（`ReturnStatement` 访问器对 `ArrowFunctionExpression` 表达式体不触发，无 ReturnStatement 节点）；同面漏「对象方法包装」`box={grab(){return useSessionStore()}}` + `box.grab().applySnapshot()`（后者调用点 receiver 为 MemberExpression，candidates 只收 Identifier/CallExpression-Identifier receiver，双重不进）。docstring「已知检出边界」4 条未声明此边界；表达式体箭头是 Vue 代码惯用形态，构成静默绕过路径。builder 自测仅覆盖块体形态。

**minor**

1. `no-non-owner-store-mutation.mjs` L252-254：`stalePermittedEntry` 检查位于「factoryBindings.size === 0 提前 return」之后——条目失真仅在存在「import store 工厂的非许可文件」时报出；该类文件为 0 时护栏配置失真静默。现实影响小（生产多处 import），列为健壮性观察。
2. 自报 35 文件 vs 实际 34（32 M + 2 新增 lib）。
3. 「61 处」为标记口径：规则可标记声明实测 60 + 1 处 `i18n/index.ts` `loadedLocales`（`new Set(['zh-CN'])` 字面量初始化，按 W24 口径放行）。该处实况是运行时被 `loadedLocales.add('en-US')`（i18n/index.ts:73）变异——印证 docstring 自声明的「字面量初始化后仍运行时写的罕见形态归 S1」边界并不罕见（61 分之一即命中）；建议登记草稿落表时把该形态显式记为例外而非口径内豁免。
4. `detachedMethodRef` 文案含登记条目号但不含登记表文件路径，与同规则另 4 条 message 风格不一致（验收只要求含登记条目文案——含，不违规）。
5. `paramOwnerFn` 同名形参多函数绑定为 last-write-wins（`f(store)` 与 `g(store)` 并存时仅其一建通道，另一函数体内同名言参调用漏检）——docstring「文件级宽松集合」精度边界已覆盖此形态，观察项。
