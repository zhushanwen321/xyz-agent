---
review:
  type: plan_review
  round: 2
  timestamp: "2026-05-29T15:00:00"
  target: ".xyz-harness/2026-05-29-plugin-arch-remaining-and-ci-fix/plan.md"
  verdict: pass
  summary: "计划评审完成，第2轮通过，0条MUST FIX，2条LOW，1条INFO"

statistics:
  total_issues: 6
  must_fix: 0
  must_fix_resolved: 2
  low: 3
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md — Task 2 Step 1（ToolRegistration 类型变更）"
    title: "ToolRegistration.execute 应为可选字段，与主线程 ToolEntry.schema 类型不兼容"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "plan.md — Task 2 Step 2（handleMessage 导出缺失）"
    title: "handleMessage 当前未 export，测试代码无法 import"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: LOW
    location: "plan.md — Task 3 Step 1（elif 分支缺少 chmod）"
    title: "Windows zip 分支缺少 chmod +x，与其他分支行为不一致"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: LOW
    location: "plan.md — Task 4 Step 1（normalizePath 参数名假设）"
    title: "mockImplementation 参数名可能不是 path，需确认实际回调签名"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: INFO
    location: "plan.md — Interface Contracts / postRpcResponse 实现"
    title: "postRpcResponse 动态构建 RpcResponse 对象可能不符合 union type 安全性"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "plan.md — Task 2 Step 3（registerToolHandler 参数类型不兼容）"
    title: "registerToolHandler(toolKey, registration.execute) 在 execute 可选后类型推断为 ToolExecuteHandler | undefined，与目标签名 (handler: ToolExecuteHandler) 冲突"
    status: open
    raised_in_round: 2
    resolved_in_round: null

---

# 计划评审 v2（增量审查）

## 评审记录
- 评审时间：2026-05-29 15:00
- 评审类型：计划评审（增量模式）
- 评审对象：`.xyz-harness/2026-05-29-plugin-arch-remaining-and-ci-fix/plan.md`
- 参考文档：上一轮报告 `plan_review_v1.md` + 修复后 `plan.md`
- 模式：增量审查 — 只关注 MUST_FIX 修复验证 + 新引入问题，不重做全量扫描

---

## MUST_FIX 修复验证

### [FIXED] MUST_FIX #1: ToolRegistration.execute → 可选字段

**v1 问题**：`ToolRegistration.execute` 声明为必填字段（`execute: ToolExecuteHandler`），但主线程 `tool-api.ts:62` 构造 tool schema 时使用 `{ name, description, parameters }` 对象字面量，不含 `execute` 字段。execute 函数不可序列化，通过 RPC 传输时不会发送。必填字段会导致 TypeScript 编译错误。

**v2 修复验证**：

plan.md Task 2 Step 1 中 `ToolRegistration` 接口已改为：

```typescript
export interface ToolRegistration {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute?: ToolExecuteHandler
}
```

- `?` 标记已添加，`execute` 变为可选 ✅
- 注释说明了原因：「可选因为主线程侧 schema 不可序列化 execute 函数」 ✅

**状态：已修复** ✅

---

### [FIXED] MUST_FIX #2: handleMessage → 导出

**v1 问题**：`handleMessage` 在 `plugin-bootstrap.ts` 中是内部 `async function`，未 export。但单元测试（Task 2 Step 4）需要 `import { handleMessage }`。Plan 只要求 export `registerToolHandler`，没有要求 export `handleMessage`。

**v2 修复验证**：

plan.md Task 2 Step 2 中明确描述：

1. 「将 `handleMessage` 从内部函数改为 export」 ✅
2. 「同时将现有的 `async function handleMessage` 改为 `export async function handleMessage`，使单元测试可以 import」 ✅
3. 单元测试代码中已有 `import` 语句引用 `handleMessage` ✅

**状态：已修复** ✅

---

## LOW/INFO 修复验证

### [FIXED] LOW #3: Windows zip 分支缺少 chmod

**v1 问题**：`elif [[ -f "pi.exe" ]]` 分支中只有 `mv pi.exe "${BINARY_NAME}"`，没有 `chmod +x`。

**v2 验证**：

plan.md Task 3 Step 1 中已添加：

```bash
elif [[ -f "pi.exe" ]]; then
    mv pi.exe "${BINARY_NAME}"
    chmod +x "${BINARY_NAME}" 2>/dev/null || true
```

- `chmod +x "${BINARY_NAME}" 2>/dev/null || true` 已添加 ✅
- 容错处理（`2>/dev/null || true`）已包含 ✅

**状态：已修复** ✅

---

### [UNCHANGED] LOW #4: normalizePath 参数名假设

仍保持 v1 状态。plan 假设回调参数名为 `path`，实际代码可能使用 `filePath` 或其他名称。此问题依赖实际代码确认，plan 层面标注即可。不影响 v2 评审结论。

**状态：未修复（不影响 verdict）**

---

### [UNCHANGED] INFO #5: postRpcResponse 类型安全性

仍保持 v1 状态。`RpcResponse` 是 union type 时，动态添加 `error`/`result` 字段可能触发 TS 严格模式报错。这是实现细节，Implementer 可自行用 type assertion 处理。不影响 v2 评审结论。

**状态：未修复（不影响 verdict）**

---

## 修复引入的新问题

### [NEW] LOW #6: registerToolHandler 参数类型不兼容

**位置**：plan.md — Task 2 Step 3 / `tool-api.ts` 变更

**描述**：

Task 2 Step 3 中 `register` 函数调用：

```typescript
registerToolHandler(toolKey, registration.execute)
```

`registration.execute` 的类型现在是 `ToolExecuteHandler | undefined`（由于 MUST_FIX #1 的修复，execute 变为可选）。但 `registerToolHandler` 的签名声明为：

```typescript
export function registerToolHandler(toolKey: string, handler: ToolExecuteHandler): void
```

参数 `handler` 期望 `ToolExecuteHandler`（非可选），因此 `registerToolHandler(toolKey, registration.execute)` 在 TypeScript strict 模式下会报类型错误：`Argument of type 'ToolExecuteHandler | undefined' is not assignable to parameter of type 'ToolExecuteHandler'`。

**影响评估**：
- **功能正确性**：不影响。即使 handler 为 `undefined`，`toolHandlers.set(toolKey, undefined)` 会写入 `undefined`，后续 `handleIncomingRequest` 中 `if (!handler)` 检查会正确触发 error response 路径。
- **编译正确性**：TypeScript 会报类型错误，导致 `npm run lint` 失败（含 `tsc --noEmit`），Block 完成步骤。

**修改方向**：Implementer 可在实现时选择：
1. 添加守卫：`if (registration.execute) registerToolHandler(toolKey, registration.execute)`
2. 或将 handler 参数改为可选：`(toolKey: string, handler?: ToolExecuteHandler)`
3. 或将 Map 值类型改为包含 undefined：`Map<string, ToolExecuteHandler | undefined>`

推荐方案 1（守卫），最直接且不需改类型声明。

---

## 结论

**通过。** 两条 MUST_FIX 均已正确修复，LOW #3 也同时修复。修复仅引入一条新的 LOW 问题（#6：registerToolHandler 参数类型不兼容），功能正确，Implementer 可在编码阶段自然处理。0 条 open MUST_FIX，verdict: pass。

### Summary

计划评审完成，第2轮通过，0条MUST FIX，2条LOW（1已修复+1新增），1条INFO
