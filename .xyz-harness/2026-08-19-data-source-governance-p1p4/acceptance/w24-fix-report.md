# W24-fix 针对性复审报告：R2 表达式体箭头 + 对象方法包装收口

> verifier 独立复审（对抗模式）。复审对象 = w24-report.md 问题清单 major 项的修复
> （工作区未提交变更，3 文件声明）。只验本次修复面，不重验 W24 全量（全量已 PASS）。
> verifier 探针自建（表驱动 driver，与 builder 自验探针不同源），全程临时产物用毕即删。

## 结论：PASS

修复面三项检测能力（表达式体箭头工厂 / 词法序陷阱 / 对象方法 + MemberExpression receiver）独立探针全部实测检出；回归 42/42 + `pnpm run lint` exit 0（0 errors，461 warnings 与全量基线一致）；篡改三处关键修复行各自导致新用例精确变红（非恒真）；改动面核查无越界。

附：5 个生僻语法面静默逃逸（非 Vue 惯用形态，均不构成 FAIL，见「逃逸形态清单」）、1 个超收方向观察（解构 receiver 实测被检出而非放行）、1 个 builder 会话残留物上报（`.w24fix-verifier-probe.tmp.mjs` 未删）。

## A. 红性独立复证 — PASS

探针 driver：`.v-w24fix2-probe.tmp.mjs`（verifier 自建表驱动，已删除）；挂真实规则 + typescript-eslint parser，filename = 非许可普通文件 `packages/renderer/src/stores/zz-review-probe.ts`。

| 探针 | 形态 | 实测 | 判定 |
|---|---|---|---|
| A1 | `const reachStore = () => useSessionStore()` + `reachStore().applySnapshot(p)` | `wrappedFactoryMutation@L4`（文案含 reachStore） | 检出 OK |
| A1b | 正常序实例绑定变体（`const first = useSessionStore(); const wrap = () => first`） | `wrappedFactoryMutation@L5` | 检出 OK |
| A2 | 对象方法简写 `{ storeSource() { return useSessionStore() } }` + `registry.storeSource().applySnapshot(p)` | `wrappedFactoryMutation@L8` | 检出 OK |
| A3 | 词法序陷阱 `const lazyReach = () => target; const target = useSessionStore()`（body 引用绑定声明晚于箭头） | `wrappedFactoryMutation@L5` | 检出 OK（pending 列表方案核心价值点独立证实） |
| A4a | `async () => useSessionStore()` 表达式体（AST body 仍为 CallExpression） | `wrappedFactoryMutation@L4` | 检出 OK |
| A4b | 对象方法 `storeSource: function () {...}`（function 关键字 vs 简写） | `wrappedFactoryMutation@L8` | 检出 OK（简写与 function 无差异） |
| A4c | 箭头作为属性值 `{ storeSource: () => useSessionStore() }` | `wrappedFactoryMutation@L6` | 检出 OK（Property 分支 + pending 双路覆盖） |
| A4d | 嵌套对象 `nested.inner.storeSource().applySnapshot(p)` | `wrappedFactoryMutation@L10` | 检出 OK |
| A4e | 解构 receiver `const { storeSource } = src; storeSource().applySnapshot(p)` | `wrappedFactoryMutation@L9` | **实测检出（非放行）**——对象方法名进文件级 storeReturningFns，Identifier callee 命中裁决分支 2。超收方向（比 docstring L26「解构…不追踪」声明更宽），非逃逸，记录 |
| A4f | computed key（定义 `['storeSource'](){...}` + 调用 `srcC['storeSource']()`） | SILENT(0) | 逃逸（生僻） |
| A4g | 定义 Identifier key + computed 调用 `srcD['storeSource']()` | SILENT(0) | 逃逸（生僻；调用点裁决分支 3 要求 property.type === 'Identifier'） |
| A4h | IIFE 工厂 `(function () { return useSessionStore() })().applySnapshot(p)` | SILENT(0) | 逃逸（生僻；函数表达式无名 + 调用点 callee 是 FunctionExpression） |
| A4i | 赋值表达式箭头 `let lateReach; lateReach = () => useSessionStore()` | SILENT(0) | 逃逸（生僻；parent 是 AssignmentExpression，name=null 不进 pending） |
| A4j | 类方法 `class C { storeSource() {...} }` + `new C().storeSource().applySnapshot(p)` | SILENT(0) | 逃逸（生僻；MethodDefinition 非 Property 分支，方法名不进集合） |
| A4k | 同名碰撞正控（真工厂函数 `storeSource` + 无关对象同名属性返回非 store） | 报 `wrappedFactoryMutation@L9` | 理论误报实测复现，与 docstring L27-29「同名属性碰撞的理论误报可接受」声明一致 |
| A5 | 反例：非 store 表达式体箭头 + 非 store 对象方法（`plain()/toolkit.pick()` 返回普通对象）调 `.applySnapshot` | SILENT(0) | 0 误报 OK（收口未扩大误报面） |

**A1-A3 判据全部满足**（任一不报 = FAIL 的红线未触发）。

## B. 回归独立复跑 — PASS

| 命令 | 实测 | 判定 |
|---|---|---|
| `node --test --test-timeout=60000 taste-lint/rules/*.test.mjs taste-lint/lib/*.test.mjs` | **42/42 pass, 0 fail**（R2 19 内含本次 +4；篡改还原后复跑同 42/42） | PASS |
| `pnpm run lint` | **exit 0，0 errors / 461 warnings**（与 W24 全量验收基线一致——329 文件零新误报硬门槛达成） | PASS |

## C. 改动面核查 — PASS

| 核查项 | 实测 | 判定 |
|---|---|---|
| `packages/renderer/src/i18n/index.ts` | diff 仅 +1 行注释（`taste:allow-no-data-owner W24-EX-C`，措辞改为「运行时经 add() 变异……归 S1 语义层兜底，显式例外登记」，对应 w24-report minor 3 的建议落实），逻辑零改动 | PASS |
| `.xyz-harness/**` 验收文档 | `w24-report.md` untracked（W24 全量验收产物，mtime 14:09 早于本次 fix 会话 18:16+），非 modified——本次 fix 未触碰 | PASS |
| `docs/architecture/data-source-governance-plan.md` / `data-source-registry.md` | `git diff` 空、不在变更清单 | PASS |
| eslint-disable 新增 | 全工作区 diff `grep eslint-disable` 零命中 | PASS |
| 声明 3 文件之外的 taste-lint 改动 | `require-data-owner-annotation.mjs/.test.mjs` 改动属 W24 全量（R3 扩围 + parse-registry 运行时解析，w24-report §6/§7 已验收），diff 内容与本次修复面无交集，非越界 | PASS |
| docstring「已知检出边界」如实性 | 新增第 4 条边界（L27-29）如实声明对象方法 receiver 按方法名命中的同名碰撞误报（A4k 正控实测吻合）。5 个逃逸语法面未逐一点名（见清单裁量） | PASS（附记录） |

## D. 测试咬合力（剥除-变红-字节还原） — PASS

方法：篡改前 `cp` 备份 + sha256 锚定（`8d8690f9…`），每轮剥除 → `node --test taste-lint/rules/no-non-owner-store-mutation.test.mjs` → `cp` 还原 → `cmp` 字节校验。

| 剥除行 | 实测 | 还原 |
|---|---|---|
| `Program:exit` 内 pendingExprBodyArrows 解析循环（词法序陷阱方案本体） | fail=2：恰好「表达式体箭头工厂」+「词法序陷阱」两新用例红 | `cmp` 字节一致 |
| `enterFn` Property 父级函数名派生分支（对象方法命名） | fail=1：恰好「对象方法包装 box.grab()」新用例红 | `cmp` 字节一致 |
| candidates 裁决分支 3（MemberExpression receiver 的 property 名命中 storeReturningFns） | fail=1：恰好「对象方法包装 box.grab()」新用例红 | `cmp` 字节一致 + sha256 回到 `8d8690f9…` |

三处剥除均导致新用例精确变红且不影响其余用例——修复代码与新用例一一咬合，非恒真。还原后全量复跑 42/42。

## 逃逸形态清单（上报记录，均裁量 PASS）

| # | 形态 | 惯用性 | docstring 声明 | 建议 |
|---|---|---|---|---|
| 1 | computed key 定义 + computed 调用（A4f） | 生僻（Vue 代码不用 `obj['method']()` 访问已知方法名） | 未点名；检测面 4「函数名取 Property key」隐含 Identifier 限定 | 下 wave docstring 边界补点名 |
| 2 | Identifier 定义 + computed 调用（A4g） | 生僻 | 未点名 | 同上 |
| 3 | IIFE 工厂（A4h） | 生僻（composable 风格不用匿名 IIFE 持有工厂） | 未点名 | 同上 |
| 4 | 赋值表达式箭头 `g = () => store`（A4i） | 生僻（惯用 const 一次性绑定） | 未点名 | 同上 |
| 5 | 类方法 MethodDefinition（A4j） | 生僻（Vue 3 composable 库罕用 class 持有 store 工厂） | 未点名（声明的是对象方法 Property 面） | 同上 |

裁量依据：W24 major 判例以「表达式体箭头是 Vue 惯用形态」为由判 major；上表 5 形态均非惯用，且 docstring 已有「解构/rest 形参、同名函数作用域混淆等**间接形态不追踪（文件级宽松集合，同 W4 精度）**」的总括精度声明兜底。建议下一 wave 在「已知检出边界」补一行点名 computed key / IIFE / 类方法 / 赋值箭头四个语法面，消除声明盲区。

另记录（非逃逸）：**A4e 解构 receiver 实测被检出**——任务预期其为「已声明边界放行」，实测因对象方法名进文件级名字集合而命中裁决分支 2 报错。方向为超收（收窄逃逸面），不构成 FAIL；docstring L26 边界措辞（「解构…不追踪」）与该实测不完全对齐，属声明精度问题，同建议下 wave 澄清。

## 残留物上报（认知外文件，verifier 未处置）

- `.w24fix-verifier-probe.tmp.mjs`（仓库根，untracked，mtime 2026-08-19 18:19，属本次 fix 会话窗口）：文件头注释自称「verifier 独立探针 driver（对抗复证用，跑完即删）」但未删除。builder/前序 verifier 的自验探针残留，违反探针清理纪律。按全局规则 0 未动，待主 agent 授权处置。
- verifier 本轮产物：`.v-w24fix2-probe.tmp.mjs`（已删除，`git status` 确认无痕）；规则文件三轮篡改均已 sha256 证实字节还原（`8d8690f9490e4ef4c3e68c4c62c6d8f636fe20dc34b124f361f0c5e08d60442f`）。
