---
review:
  type: code_review
  round: 2
  timestamp: "2026-05-28T08:45:00"
  target: "第1轮 4条 MUST_FIX 的修复验证"
  verdict: fail
  summary: "第2轮审查完成。4条 MUST_FIX 中 3 条已修复，1 条未修复，需继续修改后重审。"

statistics:
  total_issues_rechecked: 4
  fixed: 3
  not_fixed: 1
  must_fix_remaining: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "runtime/test/plugin-activator.test.ts:181,185"
    title: "Mock 类型转换直接 as Mock<Function>，存在类型安全风险"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    fix_verification: "已改为 `as unknown as ReturnType<typeof mock.fn>` 双重转换，类型安全。✓"

  - id: 2
    severity: MUST_FIX
    location: "runtime/test/plugin-storage.test.ts:99"
    title: "Error 类型直接 as { code: number } 缺少 code 属性"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    fix_verification: "已改为 `(err as unknown as { code: number }).code` 双重转换，类型安全。✓"

  - id: 3
    severity: MUST_FIX
    location: "runtime/src/services/plugin-service/plugin-activator.ts:98"
    title: "参数 _rpcServer 定义但从未使用（ESLint error）"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    fix_verification: "`_rpcServer` 参数已从构造函数中完全移除，grep 无匹配。✓"

  - id: 4
    severity: MUST_FIX
    location: "runtime/src/services/plugin-service/plugin-bootstrap.js:8"
    title: "CJS require() 导入违反 ESM 项目规范（ESLint error）"
    status: unresolved
    raised_in_round: 1
    resolved_in_round: null
    fix_verification: "❌ 未修复。`plugin-bootstrap.js` 仍包含 `require('node:worker_threads')` 且无 eslint-disable 注释。运行 `npx eslint ...plugin-bootstrap.js` 仍报 `@typescript-eslint/no-require-imports` 错误。虽然 `fixtures/mock-bootstrap.cjs` 已创建并含 eslint-disable，但源文件 `plugin-bootstrap.js` 本身未修改。"
    required_action: |
      两种方案任选其一：
      方案A：在 `plugin-bootstrap.js` 文件顶部添加 `/* eslint-disable @typescript-eslint/no-require-imports */`
      方案B：将 `plugin-bootstrap.js` 重命名为 `plugin-bootstrap.cjs`，并更新 `plugin-host.ts:182` 的引用路径

verification_details:
  - issue_id: 1
    verified_at: "2026-05-28T08:45:00"
    method: "读取 plugin-activator.test.ts，grep 无 'as Mock' 残留，确认使用 `as unknown as ReturnType<typeof mock.fn>`"
    result: PASS

  - issue_id: 2
    verified_at: "2026-05-28T08:45:00"
    method: "读取 plugin-storage.test.ts:99，确认使用 `(err as unknown as { code: number }).code`"
    result: PASS

  - issue_id: 3
    verified_at: "2026-05-28T08:45:00"
    method: "读取 plugin-activator.ts，grep '_rpcServer' 无匹配，构造函数已完全移除该参数"
    result: PASS

  - issue_id: 4
    verified_at: "2026-05-28T08:45:00"
    method: "读取 plugin-bootstrap.js，确认 require() 仍存在；执行 `npx eslint ...plugin-bootstrap.js` 验证仍报 error"
    result: FAIL
    evidence: "ESLint 报错: `8:24 error A require() style import is forbidden @typescript-eslint/no-require-imports`"

notes:
  - "mock-bootstrap.cjs 已正确添加 eslint-disable 注释，但插件系统使用的 bootstrap 源文件 plugin-bootstrap.js 本身未修改。"
  - "plugin-host.test.ts 测试会动态将 mock-bootstrap.cjs 的内容复制到 plugin-bootstrap.js 路径覆盖；但源文件仍存在于 source tree 中，触发 lint error。"
  - "剩余 6 条 LOW 级别问题（空 catch、魔数、未使用的 eslint-disable）未纳入本轮重点验证，后续可继续处理。"
---

# 编码规范审查 v2 — 修复验证

## 验证记录
- 验证时间：2026-05-28 08:45
- 验证类型：第1轮 MUST_FIX 修复回归验证
- 验证方法：逐条读取文件 + 运行 ESLint 确认

---

## MUST_FIX 验证结果

### MUST_FIX #1: `plugin-activator.test.ts` Mock 类型转换

**状态:** ✅ 已修复

**修复内容:**
- 将 `as Mock<Function>` (不安全直接转换) 改为 `as unknown as ReturnType<typeof mock.fn>` (双重转换)
- 变更位置：幂等性测试用例（idempotent test）第 181 行和第 185 行
- 全文件 grep 确认无 `as Mock` 遗留

**验证结论:** 通过。双重转换是 TypeScript 类型安全的做法，Runtime 的 type assertion 不会带来运行时风险。

---

### MUST_FIX #2: `plugin-storage.test.ts` Error `code` 属性

**状态:** ✅ 已修复

**修复内容:**
- 将 `err as { code: number }` 改为 `(err as unknown as { code: number })`
- 变更位置：第 99 行，`assert.rejects` 回调中的类型断言

**验证结论:** 通过。`unknown` 作为中转类型是标准的安全转换模式。

---

### MUST_FIX #3: `plugin-activator.ts` 未使用参数 `_rpcServer`

**状态:** ✅ 已修复

**修复内容:**
- `_rpcServer` 参数已从 `PluginActivator` 构造函数中完全移除
- 全文件 grep `_rpcServer` / `rpcServer` 无匹配

**验证结论:** 通过。移除未使用参数是最干净的解决方案。如果未来需要 RPC Server 依赖，可通过属性注入或其他模式添加。

---

### MUST_FIX #4: `plugin-bootstrap.js` CJS `require()` ESLint error

**状态:** ❌ 未修复

**当前状态分析:**

`src-electron/runtime/src/services/plugin-service/plugin-bootstrap.js` 仍然包含：

```js
const { parentPort } = require('node:worker_threads')
```

且文件顶部**没有** `/* eslint-disable @typescript-eslint/no-require-imports */` 注释。

**实际验证:**

```bash
npx eslint src-electron/runtime/src/services/plugin-service/plugin-bootstrap.js
# → 8:24 error A require() style import is forbidden @typescript-eslint/no-require-imports
```

ESLint error 仍然存在。

**已做的更改（但不够完整）：**
- 在 `test/fixtures/mock-bootstrap.cjs` 中创建了复制版本的 mock bootstrap，添加了 eslint-disable 注释
- `plugin-host.test.ts` 在 `before()` 中将 `mock-bootstrap.cjs` 内容复制到 `plugin-bootstrap.js` 路径

**为什么这不足以修复第4个问题：**
- `plugin-bootstrap.js` 本身仍存在于 source tree 中
- 运行 `eslint src-electron/runtime/src/services/plugin-service/` 会扫描到它并报错
- ESLint error 导致 CI 和 pre-commit 检查失败

**建议的修复方案（任选其一）：**

| 方案 | 操作 | 风险 |
|------|------|------|
| A | 在 `plugin-bootstrap.js` 顶部添加 `/* eslint-disable @typescript-eslint/no-require-imports */` | 低，与 `mock-bootstrap.cjs` 做法一致 |
| B | 将 `plugin-bootstrap.js` 重命名为 `.cjs`，更新 `plugin-host.ts:182` 引用路径 | 中，需确认 Worker 线程对 `.cjs` 文件的支持 |

---

## 未纳入本轮验证的问题

以下 LOW/INFO 级别问题不在本轮 MUST_FIX 验证范围内：

| ID (v1) | 严重程度 | 位置 | 描述 |
|---------|---------|------|------|
| 5 | LOW | plugin-activator.ts:255 | 空 catch 块 |
| 6 | LOW | plugin-bootstrap.ts:76 | catch 仅 console |
| 7 | LOW | plugin-host.ts:54,77,123 | 魔数 |
| 8 | LOW | plugin-storage.ts:5,6,173,190 | 魔数 |
| 9 | LOW | plugin-storage.ts:138 | 空 catch 块 |
| 10 | LOW | plugin-service.ts:11 | 未使用的 eslint-disable |
| 11 | INFO | plugin-activator.ts:93-96 | 观察记录 |

---

## 结论

**需修改后重审。** 4条 MUST_FIX 中 3 条已正确修复并验证通过，但第 4 条（`plugin-bootstrap.js` CJS `require()`）仍未修复。请选择以上任一方案修复后提交第 3 轮审查。
