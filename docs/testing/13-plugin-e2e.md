# 13 · 插件系统非 mock 端到端验收基线

> 定位：插件系统（plugin-service）的**真实加载路径**验收——隔离 runtime + 真实插件文件 + 真实 WS 协议，零 mock。
> 背景：测试金字塔底部全是 mock、真实加载路径零覆盖是 F1-F4 四个 bug 的共同根因（built-in pluginPath 存目录从未激活、dev sandbox fork 崩溃、uninstall 缺清理、shutdown 不 flush 全部在 mock 层不可见）。本基线是结构性防护。

## 1. 运行方式

```bash
bash scripts/verify-plugin-e2e.sh          # 独立运行，~8s
bash scripts/validate-runtime-bundle.sh    # 作为第 7 步自动运行（pre-commit 于 runtime src 变更时触发）
```

前置：node >= 22（全局 WebSocket 客户端）、curl、lsof、`pnpm install` 过的仓库（esbuild / tsx 可解析）。

不依赖 `pnpm dev`（不占用正在跑的 dev app）：随机端口 + `mktemp -d` 隔离数据目录，tsx 源码直跑 `packages/runtime/src/index.ts`（dev 形态）。

## 2. 覆盖场景与断言

脚本内 heredoc 生成两个最小 sandbox 测试插件（放 `<隔离数据目录>/plugins/`）：

| 插件 | 形态 | 用途 |
|------|------|------|
| `e2e-minimal` | sandbox、无权限声明、activate/deactivate 各打一行日志 | A 激活 + B toggle |
| `e2e-hook` | sandbox、permissions `["plugin.hooks.register"]`（permissions.json 预批准）、onBeforeSendMessage 拦截器（`v6magic` → `[V6-HOOK-APPLIED]` transform） | D hook 执行 |

| 步骤 | 断言 | 对应修复 |
|------|------|---------|
| A1 | boot 后 `plugin.list` 中 e2e-minimal `status=active`（onStartupFinished 自动激活，sandbox fork 真实加载） | F1（9068e2692 dev tsx loader） |
| A2 | e2e-hook `status=active`（权限预批准路径） | 权限链路 |
| A3 | built-in `statusline` 出现且 `status=active`（registry 多形态扫描 + prepare-builtin-plugins 预编译链） | F3 + F4 dev 扫描修复 |
| B1 | `plugin.toggle {enabled:false}` 后 status ≠ active 且 `enabled=false` + 日志含 `[e2e-minimal] deactivate called` | toggle 停用链路 |
| B2 | `plugin.toggle {enabled:true}` 后 status 恢复 `active` + 日志再次含 `activate called` | toggle 重激活链路 |
| D1 | `message.send`（fake session，hook 先于 ensureActive 执行，SESSION_NOT_FOUND error envelope 属预期） | message-dispatcher hook 时序 |
| 日志断言 | `[e2e-hook] onBeforeSendMessage fired: hello v6magic marker` + `transform computed`（worker stdout 经 host 转发落 runtime 日志） | hook 真实执行 |
| 负向断言 | 日志 0 次 `failed/timed out`（hook 管道失败）/ `ERR_MODULE_NOT_FOUND`（F1 事故特征）/ `PERMISSION_DENIED` | 回归防护 |

失败行为：任一步 exit 非 0，打印 `[FAIL]` 行 + `[定位]` runtime stdout / 日志目录路径 + stdout 尾部 30 行；**失败现场保留**（`/tmp/xyz-plugin-e2e.*/`，进程照常清理），成功路径全量清理。

## 3. V6 场景关联

本基线 D 步是 [dev-acceptance.md V6 场景](../../.xyz-harness/2026-08-15-perf/dev-acceptance.md)的自动化版本（fake-session 触发）。V6 补测（2026-08-16）在此之上做了真实 session 全链路手工实测：transform 后内容送达 pi 并持久化（session JSONL user 消息为 `hello [V6-HOOK-APPLIED] end-to-end`，原始 `v6magic` 0 次出现）——该全链路（需模型配置）未自动化。

## 4. 已知缺口（记录不修，独立问题）

1. **权限审批等待无人唤醒**：sandbox 插件声明 permissions 时，boot 激活的 30s 等待（`PluginActivator.waitForPermissionApproval`）只能超时——`resolvePermissionApproval` 全仓无调用方，`PluginService.approvePermissions` 只 grant 不 resolve 该 pending；且等待期间 approvePermissions 触发的 re-activate 因 ACTIVATING 幂等守卫 no-op。实测 boot 后台初始化被阻塞 30s（`plugins=30007.5ms`）。脚本用预写 `permissions.json` 模拟「用户此前已批准」绕开。修复方向：approvePermissions 内同时调 `activator.resolvePermissionApproval(pluginId, true)`。
2. **plugin.toggle 停用后的协议状态**：UNLOADED 映射为 `discovered`（`mapStateForProtocol`），非 `inactive`。脚本断言按 `status ≠ active && enabled=false` 表述，不锁具体值。

## 5. 排查指南

| 症状 | 定位 |
|------|------|
| A1/A2 失败（不激活） | 看 `[FAIL]` 指向的 runtime stdout 中 `plugin-process` / `plugin-host-process` 行；`ERR_MODULE_NOT_FOUND` = F1 类回归（fork loader），`PERMISSION_DENIED` = 权限预批准失效 |
| A3 失败（statusline 缺失） | 先手工跑 `bash scripts/prepare-builtin-plugins.sh`；仍缺失查 `plugin-registry.ts` 的 `resolveBuiltinPluginsDir` 候选探测（两形态单测在 `packages/runtime/test/plugin-registry.test.ts` TC-1-09/10/11） |
| D 步无 hook 日志行 | 查 `message-dispatcher` 的 hook 时序（hook 必须先于 ensureActive）；fake session 的 error envelope 属预期，不算失败 |
| 脚本起不来 | `tsx 不可解析` → `pnpm install`；`node < 22` → 升级 node；端口占用 → 脚本自动重试 10 个随机端口，仍失败查 `lsof -nP -i :41000-43999` |
