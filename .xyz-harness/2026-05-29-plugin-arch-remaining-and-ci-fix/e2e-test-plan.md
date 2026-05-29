---
verdict: pass
---

# E2E Test Plan — plugin-arch-remaining-and-ci-fix

## Test Scenarios

### TS-1: PluginsPane Tab Navigation (AC-1)

验证用户能在 Settings 页面导航到 Plugins tab。

1. 启动 xyz-agent dev 模式
2. 打开 Settings 页面
3. 确认侧栏出现 "Plugins" / "插件" tab
4. 点击 Plugins tab
5. 确认内容区显示 PluginsPane（插件列表或空状态）
6. 切换到其他 tab 后再切回 Plugins，确认状态保持

### TS-2: Worker Tool Execute RPC (AC-2)

验证 Worker 端能正确处理主线程发来的 tool execute RPC 请求。

1. 单元测试覆盖（`plugin-bootstrap-tool-execute.test.ts`）：
   - 注册 handler → 发 `plugin.tool.execute` request → 收到正确 result
   - 未注册 handler → 收到 METHOD_NOT_FOUND error
   - handler 抛异常 → 收到 INTERNAL_ERROR error
   - 未知 method → 收到 METHOD_NOT_FOUND error

### TS-3: Windows CI — pi Resource Preparation (AC-3)

验证 Windows runner 上 pi 资源准备步骤成功。

1. 推送代码到 PR 分支
2. 触发 CI workflow
3. 检查 Windows Build 的 "Download and prepare pi resources" step 日志
4. 确认 `pi.exe` 成功重命名为 `pi-windows-x64.exe`
5. 确认 `chmod +x` 成功

### TS-4: Windows CI — Extension Service Tests (AC-4)

验证 Windows runner 上 extension-service 测试全部通过。

1. 检查 CI Windows Build 日志
2. 确认 `extension-service.test.ts` 的 20 个测试全部 PASS
3. 本地验证：测试在路径包含 `\` 时也能正确匹配

### TS-5: macOS/Linux CI Regression (AC-5)

验证现有平台不受影响。

1. 推送代码到 PR 分支
2. 检查 macOS 和 Linux Build 日志
3. 确认 lint、typecheck、test 全部通过

## Test Environment

| 平台 | Runner | 验证方式 |
|------|--------|---------|
| macOS (arm64) | GitHub Actions | CI 自动运行 |
| Linux (x64) | GitHub Actions | CI 自动运行 |
| Windows (x64) | GitHub Actions | CI 自动运行 |

**本地验证（开发机）：**
- `npm run lint` — 全量 lint
- `cd src-electron && npx vitest run` — 全量测试
- `cd src-electron && npx vue-tsc --noEmit` — 类型检查

**CI 验证（push 后检查）：**
- `.github/workflows/ci.yml` — lint + typecheck + test
- `.github/workflows/release.yml` — 全平台 build（含 pi 资源准备）
