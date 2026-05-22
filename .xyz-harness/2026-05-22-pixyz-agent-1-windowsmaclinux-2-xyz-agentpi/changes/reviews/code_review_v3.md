---
verdict: "pass"
must_fix: 0
review:
  type: code_review
  round: 3
  timestamp: "2026-05-22T22:30:00"
  target: ".xyz-harness/2026-05-22-pixyz-agent-1-windowsmaclinux-2-xyz-agentpi (Bundle pi Binary into xyz-agent)"
  summary: "编码评审第3轮增量验证通过，1条MUST_FIX仍为已修复状态，无新增问题，119测试全部通过"

statistics:
  total_issues: 3
  must_fix: 0
  must_fix_resolved: 1
  low: 1
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "src-electron/runtime/src/process-manager.ts:135"
    title: "打包模式下 createSession() 的 spawn 失败错误消息仍指向全局安装"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "catch 块已添加 if (process.env.XYZ_AGENT_PACKAGED === '1') 分支，抛出 'Failed to start bundled pi process...'，非打包模式保留原始消息"

  - id: 2
    severity: LOW
    location: "src-electron/runtime/src/process-manager.ts:75"
    title: "ProcessManager 构造函数在打包模式下冗余日志"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    note: "findPiExecutable() 在打包模式下已打印 'using bundled pi:'，构造函数的 'using pi at:' 日志冗余。建议用 if (process.env.XYZ_AGENT_PACKAGED !== '1') 包裹。非阻塞项。"

  - id: 3
    severity: INFO
    location: "scripts/prepare-pi-resources.sh"
    title: "pi release asset 命名约定需外部验证"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    note: "需验证 pi release 中 Windows binary 是否含 .exe 后缀、解压后文件名与 BINARY_NAME 是否一致。外部依赖项，CI 阶段验证即可。"
---

# 编码评审 v3（第 3 轮增量验证）

## 增量审查模式

按 skill 方法论，第 3 轮启用增量审查模式：读取前一轮 MUST_FIX 列表，验证修复状态，检查回归，跳过全量扫描。

## MUST FIX 验证

### #1: createSession catch 块打包模式分支 — ✅ 仍为已修复

**检查目标**: `src-electron/runtime/src/process-manager.ts` createSession 中客户端 `client.start()` 的 catch 块

**实际代码（第 135 行）**:
```typescript
if (msg.includes('spawn') || msg.includes('ENOENT')) {
  if (process.env.XYZ_AGENT_PACKAGED === '1') {
    throw new Error(
      `Failed to start bundled pi process. The application installation may be corrupted. `
      + `Attempted binary: ${this.piPath}. Original error: ${msg}`,
    )
  }
  throw new Error(
    `Failed to start pi process. Ensure pi is installed globally ...`
  )
}
```

**状态**: 代码未退化，仍然包含正确的打包模式分支。✅

## 代码变更审查

本轮增量审查的新增代码变更（对比 HEAD）：

### 变更文件清单（10 个文件，+75/-1 行）

| 文件 | 类型 | 行数 |
|------|------|------|
| `src-electron/runtime/src/process-manager.ts` | modify | +31 |
| `src-electron/runtime/src/rpc-client.ts` | modify | +5 |
| `src-electron/main/runtime-manager.ts` | modify | +5/-1 |
| `src-electron/runtime/src/config-store.ts` | modify | +6 |
| `src-electron/electron-builder.yml` | modify | +10 |
| `scripts/prepare-pi-resources.sh` | create | +110 |
| `.github/workflows/release.yml` | modify | +9 |
| `.gitmodules` | create | +6 |
| `vendor/xyz-pi-extensions` | create | +1 |
| `vendor/xyz-harness` | create | +1 |
| `eslint.config.mjs` | modify | +1 (vendor/** ignore) |

### Spec 合规检查

| Spec 要求 | 实现文件 | 状态 |
|-----------|----------|------|
| FR-4: 打包模式 bundled binary 发现 | `process-manager.ts:13-38` | ✅ 完整实现 |
| FR-4: 打包模式 spawn 失败错误消息 | `process-manager.ts:135-140` | ✅ 完整实现 |
| FR-5: `PI_CODING_AGENT_DIR` 注入 | `rpc-client.ts:65-68` | ✅ 在 buildProviderEnv 前注入 |
| FR-5: `XYZ_AGENT_PACKAGED` 环境变量 | `runtime-manager.ts:195-199` | ✅ `app.isPackaged` 驱动 |
| FR-5: 不读 `~/.pi/`（config.json） | `config-store.ts:41-42` | ✅ `loadPiConfig` return null |
| FR-5: 不读 `~/.pi/`（models.json） | `config-store.ts:154-156` | ✅ `readPiDefaultModel` return null |
| FR-6: electron-builder extraResources | `electron-builder.yml:21-29` | ✅ filter 排除压缩包 |
| FR-7: Git Submodule（2 个） | `.gitmodules` | ✅ xyz-pi-extensions + xyz-harness |
| FR-8: CI 下载 pi binary | `release.yml:84-90` | ✅ 复用 prepare-pi-resources.sh |
| FR-9: 本地构建脚本 | `scripts/prepare-pi-resources.sh` | ✅ 完整实现 |

### 代码质量检查

| 维度 | 评估 |
|------|------|
| **可读性** | 注释清晰（解释了"为什么"），命名一致，函数长度适中 |
| **错误处理** | `findPiExecutable()` 在 binary 不存在时抛出明确错误，含 binaryName + path；createSession catch 区分打包 vs 开发模式 |
| **边界条件** | Windows `.exe` 后缀正确处理；`existsSync` 检查 binary 存在性；打包模式未找到时抛出异常而非静默 fallback |
| **架构合规** | 不违反 CLAUDE.md 中的架构约束；分层正确（runtime 层改动不影响前端）；不跨层调用 |
| **性能/安全** | 无引入安全问题；`vendor/**` 加入 eslint ignore 避免 lint 子模块代码 |

### 回归检查

| 检查项 | 结果 |
|--------|------|
| 开发模式是否受影响 | ✅ 所有包更改均以 `XYZ_AGENT_PACKAGED === '1'` 守卫，开发模式路径不变 |
| `findPiExecutable()` 原生路径 | ✅ 打包模式 return 后不执行 `isWindows` 等后续代码，无冲突 |
| `buildProviderEnv` 覆盖风险 | ✅ `PI_CODING_AGENT_DIR` 在 `Object.assign(env, buildProviderEnv(...))` 前设置 |
| TypeScript 编译 | ✅ npm -w @xyz-agent/runtime run typecheck → 0 errors |
| ESLint | ✅ 0 errors, 3 warnings（预存） |
| 测试 | ✅ 46 runtime + 73 frontend = 119 全部通过 |

### 关键关注点验证

#### `process.cwd()` 假设
代码中 `join(process.cwd(), 'pi', binaryName)` 假设 Sidecar 在打包模式下 cwd = `process.resourcesPath`。已验证 `runtime-manager.ts` 第 188 行设置 `cwd = app.isPackaged ? process.resourcesPath : projectRoot`。runtime 代码无 `chdir()` 调用。✅

#### Windows `.exe` 后缀
`findPiExecutable()` 在 `platform === 'win32'` 时拼接 `.exe` 后缀；`scripts/prepare-pi-resources.sh` 中 `BINARY_NAME` 也正确处理 Windows 平台。两者一致。✅

#### `PI_CODING_AGENT_DIR` 注入顺序
rpc-client.ts 中 `PI_CODING_AGENT_DIR` 在 `buildProviderEnv(providerId)` 调用前注入。provider env 不会意外覆盖 pi 的 agent 目录指向。✅

## 测试证据验证

**文件**: `changes/evidence/test_results.md`

| 检查项 | 结果 |
|--------|------|
| Runtime tests（46 个） | ✅ 全部通过（7 个测试文件） |
| Frontend tests（73 个） | ✅ 全部通过（10 个测试文件） |
| Runtime typecheck | ✅ 无错误 |
| Frontend typecheck (vue-tsc) | ✅ 无错误 |
| ESLint | ✅ 0 errors, 3 warnings（预存） |

测试结果验证了代码变更在编译和测试层面是干净的。

## 结论

**通过** — 无 open MUST_FIX。第 2 轮已验证的 MUST_FIX #1 代码未退化，新增代码符合 spec 全部 10 项要求（FR-4 到 FR-9），无回归，119 个测试全部通过。

## Summary

编码评审第3轮增量验证通过，0条MUST FIX，1条MUST_FIX仍为已修复状态，无新增问题，119测试全部通过。
