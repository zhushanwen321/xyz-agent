# W4 验收报告：R2 骨架 + R3 taste-lint 两规则（verifier 独立验收）

- **验收对象**：W4 builder 交付（R3 `require-data-owner-annotation` + R2 骨架 `no-non-owner-store-mutation` + base.mjs 注册 + 存量补注解裁定）
- **验收基线**：commit `2dc3c443c`（验收时 HEAD `e411a010f`，W4 交付物在工作树未 commit）
- **规格 SSOT**：`docs/architecture/data-source-governance-plan.md` §2 W4 节（L172-197）
- **验收人**：verifier subagent（对抗式，builder 自报逐项复验）
- **验收时间**：2026-08-19

## 1. 防篡改

| 项 | 结果 |
|----|------|
| `git diff 2dc3c443c -- .../w4-acceptance.md` | 空 |
| `git diff 2dc3c443c -- docs/architecture/data-source-governance-plan.md` | 空（`--stat` 亦空） |
| w4-acceptance.md blob hash | `c9bb913d3337bfca94f74dfb4b49cb8841c17a85` == 基线 `c9bb913d3337bfca94f74dfb4b49cb8841c17a85` |
| plan blob hash | `96035741a609623769b7aa118091af3c8d281c02` == 基线 `96035741a609623769b7aa118091af3c8d281c02` |
| sha256（w4-acceptance.md） | `209c3df4bb54a5a85e666aef2d72a1f7c8c10b370a82a4ee98a0593ceba5ac16` |
| sha256（plan） | `f76097ed3055fd88b6d29e6bdbcc0c5216d78e0dc14e105519ca6795cc1f06c4` |

**越界扫描**（`git status -uall`）：变更全集 = W4 五文件（`taste-lint/base.mjs` modified + `taste-lint/rules/` 4 个 untracked）+ 豁免项（`.githooks/install-hooks.sh` modified、`.githooks/check_pi_direct_write.py` untracked = W3 领地；`ledger.md` = 主 agent）。无越界文件。验收结束再次 `git status -uall` 与开始时一致（探针已全部删除）。

## 2. 命令实跑（验收「通过命令」4 条）

| 命令 | 结果 | 输出尾部 |
|------|------|----------|
| `pnpm run lint`（全仓，无探针） | **exit 0** | `✖ 464 problems (0 errors, 464 warnings)` |
| `cd packages/renderer && pnpm typecheck` | **exit 0** | `vue-tsc --noEmit` 无输出 |
| `cd packages/renderer && pnpm test` | **exit 0** | `Test Files 293 passed \| 1 skipped (294)`；`Tests 3054 passed \| 3 skipped (3057)` |
| `node --test taste-lint/rules/require-data-owner-annotation.test.mjs taste-lint/rules/no-non-owner-store-mutation.test.mjs` | **18/18 pass，0 fail** | `tests 18 / pass 18 / fail 0` |

464 warnings 与 builder 自报一致（全仓存量，非本次引入）。

## 3. 真实性探针（临时文件，用后已删）

eslint 直跑（仓库 flat config，即 taste-lint 挂载链路）：

| 探针 | 内容 | 期望 | 实测 |
|------|------|------|------|
| A | `stores/` 临时文件 `const cache = new Map()` 无注解 | error + registry 指引 | **命中**：`taste/require-data-owner-annotation` error，文案含 `docs/architecture/data-source-registry.md` 指引 |
| B | 补 `// @data-owner #2` | 通过 | **通过**（eslint exit 0，无 error） |
| C | `// @data-owner #99`（不存在条目） | 报错（条目真实性） | **命中**：unknownEntry error 文案含 `#99`，`ESLINT_EXIT=1` |
| D | `stores/` 临时文件 defineStore setup 体内 `new Map()` + `ref(0)` | 不报（函数作用域） | **通过**（exit 0）——「存量 0 的机制原因」证实 |
| E | `composables/` 临时文件 `import { useSessionStore } from "@/stores/session"` 后 `store.updateLabel(sid, label)` | R2 error | **命中**：文案含 `updateLabel` + 登记条目 `#1（session 标签）` + registry 指引，`ESLINT_EXIT=1` |
| G | 模块级 `new Set()` / `shallowRef(0)` / `reactive({})` / `new WeakMap()` | 全拦 | **4/4 命中**（检测面同类扩展证实） |
| H（对抗） | 文件头 `// @data-owner #1` 隔空行后 `const s = new Set()`（注释冒充）+ `export const m = new Map()`（export 包裹形态） | 冒充不生效 + export 形态也拦 | **双命中**（:4 与 :5 各 1 missingOwner error）——注释归属防冒充机制 + ExportNamedDeclaration 覆盖均有效 |
| 全仓阻断 | 探针 A/E 在场时 `pnpm run lint` | exit 1 | **exit 1**（`ELIFECYCLE Command failed`，两探针文件均列报错）——error 级经 `pnpm run lint` 真实阻断（pre-commit 链路同型） |

R2 许可文件通过性：双重证明——① `pnpm run lint` 全仓 0 errors，而许可文件内真实存在受管调用（`useSidebar.ts:258` updateLabel / `:411` setGroups、`useModel.ts:47/:67` updateSessionState，grep 实证）；② 测试用例「许可文件（useSidebar.ts）直调 → 通过」在 18/18 内。

## 4. 条款对照（plan W4 步骤 1-4 / 验收标准 1-4）

| 条款 | 结果 |
|------|------|
| 步骤 1 R3：检测模块级 `new Map(` / `ref(`；无注解报错、文案指向 registry | 满足（探针 A/G；文案含 `data-source-registry.md` 与条目指引） |
| 步骤 1 R3 豁免：测试文件、`useSessionScopedState` 内部实现（规则内注释登记） | 满足（`EXEMPT_FILES` = renderer 兼容壳 + core 原语本体，文件头 docstring 说明依据；测试用例 6/9 覆盖） |
| 步骤 1 R3 条目真实性（W2 前置） | 满足（探针 C：#99 报错；`REGISTRY_ENTRIES` = #1-#12 + P1，与登记表 L18-30 逐条核对一致，P1 = 登记表 L30「已 owner 化声明」条目） |
| 步骤 2 R2 骨架：import 边直呼检测，受管清单 setGroups/updateLabel/updateSessionState | 满足（`WATCHED_MUTATIONS` 三条与 plan 枚举一致；探针 E） |
| 步骤 2 R2 调用图留 W24 | 满足（docstring 明示检出边界：方法引用传递/形参注入不追踪） |
| 步骤 3 base.mjs 注册两条 + 存量正面修复 | 满足（base.mjs L24-25/L49-50/L98-99；存量命中 0，见裁决 3） |
| 步骤 4 误报豁免闭环（docstring：先登记再加行内豁免，禁只加注释） | 满足（R3 docstring L22-24、R2 docstring L21-23 均含「先在 data-source-registry.md 补条目/例外，再加行内豁免注释……禁止只加注释不登记」闭环文案；行内豁免实测生效——测试用例 10 / 用例 8） |
| 验收 1 R3 检出 + 补注解通过 + 删除恢复 | 满足（探针 A/B；删除后 git status 复位） |
| 验收 2 R2 检出 + 删除恢复 | 满足（探针 E） |
| 验收 3 回归 lint + renderer typecheck/test | 满足（§2 三条 exit 0） |
| 验收 4 规则自检（按既有规则测试方式补最小用例） | 满足（18/18；既有 13 条规则确无测试文件先例，builder 采用 node:test + eslint Linter 直挂——测试文件头 docstring 说明该兜底，合规） |

体例对齐核实：两条新规则与既有规则（对照 `no-unsafe-cast.mjs`）结构一致——default export + `meta.docs.description` + `messages`/`context.report({ messageId })`，ESM `.mjs` 同目录。

## 5. 三项裁决复核

### 裁决 1：R3 首版扫描范围收窄 `packages/renderer/src/stores/` — **合理，维持**

- 依据核实：plan W4 涉及文件第 4 条原文即「`packages/renderer/src/stores/` 下任一现存带模块级缓存的文件」——存量可修复范围仅限 stores/ 是 plan 明文，不是 builder 私自缩水。
- 事实复核：全仓（renderer + core，排除测试）stores 外模块级缓存实测 **17 处**（builder 自报 ~20，量级一致；抽样 3 处属实：`composables/useToast.ts:27` `ref(0)`、`composables/new-task/useNewTaskFlowState.ts:110/:112` `ref(false)`）。若首版扫全仓，这 17 处立即命中且无权修复（禁改清单禁止越 packages/ 生产代码）——收窄是唯一可 exit 0 的合规选择。
- 扩围锚点在位：规则 docstring「范围裁定（首版）」明示「补注解 + 扩围随 W24 调用图收紧同批」。

### 裁决 2：检测面同类扩展（new Set/WeakMap、shallowRef/reactive）— **证实**

探针 G：四种形态模块级全部命中（4 errors）。超出 plan 步骤 1 字面要求的 `new Map(` / `ref(` 最小集，属合理泛化（docstring 声明「可变容器构造 + Vue 可变响应式原语」分类）。

### 裁决 3：存量 0 的机制原因（函数作用域）而非规则失效 — **证实（双证据）**

- 规则活性反证：探针 A/C/G/H 全部命中（规则若失效不可能报错）。
- 机制核实：`packages/renderer/src/stores/` 全量 grep（const/let/var × new Map/Set/WeakMap/ref/shallowRef/reactive）**零命中**；stores/ 模块级现存声明全部是常量（`STORAGE_KEY` 等）、`defineStore` 工厂（其内部状态在 setup 函数作用域，探针 D 证实放行）、`let projectSeq = 0`（数值计数器，非缓存构造形态）。存量 0 是事实结论，plan 预估「≤3 个」上界未达到不构成偏差。

## 6. 偏差与已知边界记录（均不构成 FAIL）

1. **R2 检出边界（docstring 已诚实声明）**：core 包内 `useChat.ts:254/:264/:278` 与 `use-session.ts:285/:404` 直呼受管 mutation（store 经形参/`import type` 注入）不被 R2 拦截——`no-non-owner-store-mutation.mjs` docstring L9-13 明示「方法引用传递与参数注入形态不可见——本规则只看 import 边直呼」，与 plan「首版拦直呼形态，调用图分析留 W24」一致。记录待 W24 收紧。
2. **REGISTRY_ENTRIES 硬编码**与登记表人工同步（docstring 声明「P1 起演进为可执行配置后由配置生成/双向校验」）——首版可接受，登记表演进时需回改。
3. **存量补注解 = 0**：验收文档交付物第 4 条「预估 ≤3 个」未达到——零命中是实测事实（§5 裁决 3），非未执行。

## 7. 总结论

# **PASS**

防篡改（blob hash 双证）✓ · 越界扫描无异常 ✓ · 四条通过命令全 exit 0（lint 0 errors / typecheck / 3054 tests / 18 rule tests）✓ · 真实性探针 7 组全命中（含 #99 条目真实性、注释冒充防御、export 形态、全仓阻断链路）✓ · 三项裁决事实全部成立 ✓ · 工作树复位 ✓
