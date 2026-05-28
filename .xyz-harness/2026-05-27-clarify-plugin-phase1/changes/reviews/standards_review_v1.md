---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-28T08:15:00"
  target: "src-electron/runtime/src/services/plugin-service/ (11 files) + modified tracked files (index.ts, interfaces.ts, server.ts, protocol.ts) + test files"
  verdict: fail
  summary: "编码规范审查完成，第1轮，4条 MUST FIX，需修改后重审"

statistics:
  total_issues: 11
  must_fix: 4
  low: 6
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "runtime/test/plugin-activator.test.ts:157,159"
    title: "Mock 类型转换直接 as 到 Mock<Function>，存在类型安全风险"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "runtime/test/plugin-storage.test.ts:99"
    title: "Error 类型直接 as 到 { code: number } 缺少 code 属性"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "runtime/src/services/plugin-service/plugin-activator.ts:98"
    title: "参数 _rpcServer 定义但从未使用（ESLint error）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "runtime/src/services/plugin-service/plugin-bootstrap.js:8"
    title: "CJS require() 导入违反 ESM 项目规范（ESLint error）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "runtime/src/services/plugin-service/plugin-activator.ts:255"
    title: "空 catch 块吞掉错误，至少需要记录日志"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "runtime/src/services/plugin-service/plugin-bootstrap.ts:76"
    title: "catch 块只有 console 调用，错误未传播给调用方"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "runtime/src/services/plugin-service/plugin-host.ts:54,77,123"
    title: "魔数未抽取命名常量（10, 10000, 30000）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: LOW
    location: "runtime/src/services/plugin-service/plugin-storage.ts:5,6,173,190"
    title: "魔数未抽取命名常量（1024, 2, 12 等）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: LOW
    location: "runtime/src/services/plugin-service/plugin-storage.ts:138"
    title: "空 catch 块吞掉错误，至少需要记录日志"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 10
    severity: LOW
    location: "runtime/src/services/plugin-service/plugin-service.ts:11"
    title: "未使用的 eslint-disable 指令（@typescript-eslint/no-explicit-any）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 11
    severity: INFO
    location: "runtime/src/services/plugin-service/plugin-activator.ts:93-96"
    title: "_rpcServer 参数为未来接口预留但当前未使用"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 编码规范审查 v1

## 评审记录
- 评审时间：2026-05-28 08:15
- 评审类型：编码规范审查（自动检查 + 手工逐条对比）
- 评审对象：
  - 新建源文件（11 个）：`plugin-service/index.ts`, `plugin-types.ts`, `plugin-service.ts`, `plugin-registry.ts`, `plugin-storage.ts`, `plugin-activator.ts`, `plugin-host.ts`, `plugin-rpc-client.ts`, `plugin-rpc-server.ts`, `plugin-bootstrap.ts`, `plugin-bootstrap.js`
  - 修改文件（4 个）：`runtime/src/index.ts`, `runtime/src/interfaces.ts`, `runtime/src/server.ts`, `shared/src/protocol.ts`
  - 测试文件（6 个）：`plugin-activator.test.ts`, `plugin-storage.test.ts`, `plugin-host.test.ts`, `plugin-integration.test.ts`, `plugin-registry.test.ts`, `plugin-rpc.test.ts`

---

## Phase A: 自动检查结果评估

### A.1 TypeScript 类型检查

**命令:** `npx tsc --noEmit -p runtime/tsconfig.json`

**结果:** ❌ 3 errors

| # | 文件 | 行 | 错误 |
|---|------|---|------|
| 1 | `plugin-activator.test.ts` | 157 | `as Mock<Function>` 类型转换不安全，目标类型不兼容 |
| 2 | `plugin-activator.test.ts` | 159 | 同上（重复） |
| 3 | `plugin-storage.test.ts` | 99 | `Error` 缺少 `code` 属性，直接 as `{ code: number }` 不安全 |

**评估:** 3 个 TypeScript 错误集中在 2 个测试文件中。生产代码无类型错误，这是好的。但测试文件的类型安全同样重要——Mock 类型转换和 Error 类型转换都应使用 `as unknown as TargetType` 双重转换。

**影响:** 测试代码存在类型安全隐患，但不会影响运行（运行时不存在类型擦除问题）。

### A.2 ESLint 检查

**命令:** `npx eslint src-electron/runtime/src/services/plugin-service/ --max-warnings=0`

**结果:** ❌ 2 errors + 14 warnings

#### Errors（2）:

| # | 文件 | 行 | 规则 | 描述 |
|---|------|---|------|------|
| 1 | `plugin-activator.ts` | 98 | `@typescript-eslint/no-unused-vars` | `_rpcServer` 参数声明但从未使用 |
| 2 | `plugin-bootstrap.js` | 8 | `@typescript-eslint/no-require-imports` | CJS `require()` 违反 ESM 项目规范 |

#### Warnings（14）：

| 规则 | 实例数 | 文件 |
|------|-------|------|
| `taste/no-silent-catch` | 3 | `plugin-activator.ts:255`, `plugin-bootstrap.ts:76`, `plugin-storage.ts:138` |
| `no-magic-numbers` | 8 | `plugin-host.ts:54,77,123`, `plugin-storage.ts:5,6,173,190` |
| `@typescript-eslint/no-explicit-any` (unused directive) | 1 | `plugin-service.ts:11` |
| Others | 2 | — |

**评估:** 2 个 ESLint error 必须修复。14 个 warning 中，`taste/no-silent-catch` 是品味规则（低风险但应改进），`no-magic-numbers` 是代码质量规则（建议抽取命名常量以增强可读性）。`plugin-bootstrap.js` 的 `require()` 有功能目的（Worker mock 期望 CJS），但仍应改为 ESM import 以保持项目一致性。

---

## Phase B: 逐条对比 CLAUDE.md 编码规范

### B.1 关键规则对比

#### 规则 1: emit 只传单个 payload 对象
- **检查结果:** ✅ 不适用（当前代码为 runtime/sidecar 后端，无 Vue emit）
- **说明:** 协议消息使用 `{ type, id, payload }` 格式，符合单对象规范。

#### 规则 2: Event bus listener 防重复注册
- **检查结果:** ✅ 不适用（无前端 event bus 注册点）
- **说明:** Runtime 侧消息路由使用基于 `switch` 的直接分发，不需要防重复保护。

#### 规则 3: 错误必须重置 isGenerating + streamingMessage
- **检查结果:** ✅ 不适用（无 Vue store 状态）
- **说明:** 后端错误处理通过 `sendError(ws, code, message)` 直接通知客户端。

#### 规则 4: 外部系统对接先验证再编码
- **检查结果:** ✅ 不适用（plugin 系统是内部 Worker 通信，非外部系统对接）
- **说明:** PluginWorker ↔ 主线程的通信协议定义在 `plugin-types.ts` 中，类型定义集中管理，符合规范。

#### 规则 5: pi 适配层不信任外部格式
- **检查结果:** ✅ 不适用（plugin 系统不是 pi 适配层）
- **说明:** PluginRpcClient/RpcServer 实现了独立的 RPC 协议，与 pi 协议无关。

#### 规则 6: pi session 文件延迟写入
- **检查结果:** ✅ 不适用（plugin 系统不读写 pi session 文件）

#### 规则 7: Session 隔离
- **检查结果:** ✅ 不适用（plugin 系统不涉及前端 session 路由）

#### 规则 8-10: Worktree / 端口 / Bare Repo
- **检查结果:** ✅ 流程规则，不构成代码问题

### B.2 前端编码规范对比

| 规则 | 适用性 | 结果 |
|------|--------|------|
| 禁止原生 HTML 表单元素 | ❌ 不适用 | — |
| 禁止 Emoji | ❌ 不适用 | — |
| 样式统一 Tailwind 类 | ❌ 不适用 | — |
| 行数上限 `<template>`/`<script setup>` | ❌ 不适用 | — |
| **禁止 `any`** | ✅ 适用 | **✅ 通过** — 所有文件均未使用 `any` 类型。`plugin-service.ts:11` 的 eslint-disable 是多余的（无对应 `any` 实例），已标 LOW |
| v-model 绑定 | ❌ 不适用 | — |
| Promise.allSettled | ❌ 不适用 | — |
| 禁止硬编码颜色 | ❌ 不适用 | — |
| 禁止魔数间距 | ❌ 不适用 | — |
| border-radius 限制 | ❌ 不适用 | — |

### B.3 架构约定对比

| 规则 | 适用性 | 结果 |
|------|--------|------|
| 视图切换：状态驱动 | ❌ 不适用 | — |
| Mock 模式：`VITE_MOCK` | ❌ 不适用 | — |
| 共享类型：`shared/src/` | ✅ 适用 | **⚠️ 部分通过** — 插件类型 `PluginDescriptor` 等定义在 `plugin-types.ts`（runtime 内部），API 协议类型 `PluginInfo`/`PluginCrashedPayload` 等已在 `protocol.ts` 中定义。但 `PluginDescriptor` 被 `interfaces.ts:IPluginService` 直接引用（`import('./services/plugin-service/plugin-types.js').PluginDescriptor`），绕过了共享类型约束。 |
| Sidecar 通信：WebSocket | ❌ 不适用（内部 Worker 通信） | — |
| Electron IPC | ❌ 不适用 | — |

### B.4 外部系统对接规范对比

#### 规则 1.1 对接前先写验证脚本
- **检查结果:** ✅ 不适用（plugin 系统是内部 Worker 通信，非外部系统）

#### 规则 1.2 为外部协议建类型定义文件
- **检查结果:** ✅ **通过** — 所有内部协议类型集中定义在 `plugin-types.ts` 中，RPC 通信使用 JSON-RPC 2.0 标准格式。

#### 规则 1.3 适配层隔离
- **检查结果:** ✅ **通过** — PluginRpcServer/RpcClient 形成了清晰的 RPC 适配层隔离，Worker 内部的 `plugin-bootstrap.ts` 不直接访问主线程文件系统。

### B.5 架构规范对比

#### 规则 6.1 进程间通信
- **检查结果:** ✅ 插件系统使用 Worker Thread 通信，不涉及 Electron IPC，符合架构约束。

#### 规则 6.2 目录结构
- **检查结果:** ✅ 插件相关文件位于 `runtime/src/services/plugin-service/` 下，目录结构合理。

### B.6 重要观察

#### 1. `interfaces.ts` 直接引用 plugin-types 内部类型
`IPluginService` 接口的返回值类型直接使用了 `import('./services/plugin-service/plugin-types.js').PluginDescriptor`。这使得前端如果想消费插件数据，必须知晓 runtime 内部的类型路径，违反了"共享类型通过 `shared/src/` 统一暴露"的约定。好在 `protocol.ts` 中已定义了 `PluginInfo` 接口作为 WS 协议的类型，前端应该使用 `PluginInfo` 而不是 `PluginDescriptor`。

#### 2. PluginBootstrap.js 使用 CJS
`plugin-bootstrap.js` 使用 `require()` 和 CJS 语法。虽然有功能原因（Worker mock），但在 ESM 项目中存在风格不一致的问题。应考虑改用 ESM 语法或标记为 `.cjs` 文件。

#### 3. 协议类型与内部类型的分离
`protocol.ts` 中的 `PluginInfo` 和 `plugin-types.ts` 中的 `PluginDescriptor` 存在字段差异（`PluginInfo.enabled` vs `PluginDescriptor.status`）。这种映射转换发生在 `server.ts` 的 `sendInitialState` 和 `broadcastPluginList` 方法中，但没有显式的适配层转换函数，存在 future drift 风险。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | `plugin-activator.test.ts:157,159` | Mock 函数 `assignWorker` 被直接 `as Mock<Function>` 转换，TypeScript 报错 TS2352 | 改为 `as unknown as Mock<Function>` 双重转换 |
| 2 | MUST FIX | `plugin-storage.test.ts:99` | `err as { code: number }` 不安全，Error 类型没有 `code` 属性 | 改为 `(err as unknown as { code: number }).code` 或先 `instanceof` 检查 |
| 3 | MUST FIX | `plugin-activator.ts:98` | `_rpcServer` 参数定义但未使用，ESLint `no-unused-vars` 报 error | 移除该参数（或如果接口要求保留则使用 `// eslint-disable-next-line` 带具体说明） |
| 4 | MUST FIX | `plugin-bootstrap.js:8` | CJS `require()` 导入，ESLint `no-require-imports` 报 error | 改为 ESM `import` 语法，或重命名为 `.cjs` 文件并配置 ESLint 豁免 |
| 5 | LOW | `plugin-activator.ts:255` | 空 catch 块吞掉错误 | 添加 `console.error` 或 `try-catch` 中记录原因 |
| 6 | LOW | `plugin-bootstrap.ts:76` | catch 块仅 console，错误未传播 | 至少记录日志，考虑是否向上传播 |
| 7 | LOW | `plugin-host.ts:54,77,123` | 魔数 10, 10000, 30000 未命名 | 抽取为模块级 `const`（如 `MAX_TRUSTED_WORKERS`） |
| 8 | LOW | `plugin-storage.ts:5,6,173,190` | 魔数 1024, 2, 12 未命名 | 抽取为命名常量（如 `KB`, `MB`, `FILE_VERSION`） |
| 9 | LOW | `plugin-storage.ts:138` | 空 catch 块吞掉文件不存在/解析失败的错误 | 添加 `console.error` 日志 |
| 10 | LOW | `plugin-service.ts:11` | 未使用的 eslint-disable 指令 | 移除该注释行 |
| 11 | INFO | `plugin-activator.ts:93-96` | `_rpcServer` 参数为未来接口兼容性预留，但当前未使用 | 无需操作，保留或按 MUST FIX #3 处理 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程。包含 TS 类型错误和 ESLint error
> - **LOW**：建议修复，但不阻塞。用于空 catch、魔数、未使用的 eslint-disable
> - **INFO**：观察记录，无需操作

---

## 结论

**需修改后重审。** 存在 4 条 MUST FIX 问题，主要集中在测试文件的类型安全性和 ESLint error 上。生产代码的架构设计基本符合 CLAUDE.md 规范（无 `any`、适配层隔离、类型集中定义），但有几点值得注意：
1. `interfaces.ts` 直接引用内部类型而非通过 `shared/src/` 共享
2. `plugin-bootstrap.js` 的 CJS/ESM 风格不一致
3. 批量魔法数字建议抽取命名常量

---

## Summary

编码规范审查完成，第1轮，4条MUST FIX，需修改后重审。自动检查产出 3 个 TS 错误 + 2 个 ESLint error；手工审查逐条对比 CLAUDE.md 规范，未发现违反 `禁止 any`、适配层隔离、等关键规则的情况。
