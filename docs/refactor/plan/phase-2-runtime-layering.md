# 阶段 2 · Runtime 目录分层（机械重构，低风险）

> 上游：[migration-plan.md](../migration-plan.md) · 关联决策：D4 / D7 / T1 · spec：design.md §D4、§4.3 T1

## 目标

把 `runtime/src/` 29 个平铺文件按 4 层归位（transport/services/adapters/infra），防腐层从 infra 独立；`SidecarServer` 重命名。**纯 `git mv` + import 路径修正**，无逻辑改动。

## 前置依赖

无强依赖（可与阶段 1 并行，不同进程）。

## 现状（已核对，29 个平铺 .ts）

按目标层预分类（执行时逐个 git mv）：

| 目标层 | 文件 |
|--------|------|
| `transport/` | `server.ts`、`bridge-handler.ts`、`session-message-handler.ts`、`extension-message-handler.ts`、`plugin-message-handler.ts`、`settings-message-handler.ts`、`tree-message-handler.ts` |
| `adapters/`（防腐层，NEW） | `event-adapter.ts`、`message-converter.ts`、`navigate-interceptor.ts`、`pi-config-bridge.ts`、`pi-paths.ts`、`pi-provider-store.ts`、`session-file-utils.ts`、`session-tree-reader.ts` |
| `infra/` | `rpc-client.ts`、`process-manager.ts`、`npm-installer.ts`、`extension-resolver.ts`、`scanner-base.ts`、`skill-scanner.ts`、`agent-scanner.ts` |
| `services/`（已存在，保持） | `extension-service.ts`、`extension-timeout-manager.ts` + 现有 session/config/model/tree + `plugin-service/` |
| 根（保持） | `index.ts`、`interfaces.ts`、`types.ts` |
| 待定 | `trash.ts`（工具函数，归 `infra/` 或 `utils/`） |

## 改动清单（有序 task）

### 1. 建目录 + git mv（每个文件独立或小批）

```bash
cd src-electron/runtime/src
mkdir -p transport adapters infra
git mv server.ts transport/
git mv *-message-handler.ts bridge-handler.ts transport/
git mv event-adapter.ts message-converter.ts navigate-interceptor.ts transport/  # 误——这些是 adapters
```
> 注意：按上表分类 mv，handlers → transport，event-adapter/message-converter 等 → adapters，rpc-client/process-manager 等 → infra。

### 2. 修正所有 import 路径

- 全仓搜索引用被移动文件的 import，更新相对路径。
- 重点检查：`index.ts`（组合根引用最多）、`services/*.ts`、handler 互相引用。
- `rg "from '\.\./.*adapter|from '\./rpc-client" src-electron/runtime/src/` 逐个核对。

### 3. `SidecarServer` → `RuntimeServer`（D7）

- `transport/server.ts`：`class SidecarServer` → `class RuntimeServer`。
- 修正注释「pure Transport layer」与实现不符 → 改为「纯路由 + 连接管理 + 广播；业务逻辑在 services，经 handler 调用」。
- 全仓搜索 `SidecarServer` 引用更新（`index.ts`、测试）。

### 4. ⚠️ 同步 tsup.config.ts（CLAUDE.md #12，违反必出 bug）

- `src-electron/runtime/tsup.config.ts`：`entry` 数组更新新路径（含 `transport/server.ts` 等）。
- `noExternal`：若新增 dependencies 需追加（本阶段应无新增依赖）。
- `src-electron/electron-builder.yml`：确认 `files` 仍含 `dist/runtime/**/*`、`asarUnpack: dist/runtime/**/*` 不变。
- **关键**：tsup 改动与目录 mv **必须同 commit**，逐个验证。

### 5.（可选）T1 路由表声明式

- `transport/server.ts` 的 `handleMessage` 大 switch（~37-40 case）可重构为 `type → handler` 映射表。
- 非本阶段必须；若做，单独 commit。

## 验证标准

- [ ] `npm run build` 成功。
- [ ] `bash scripts/validate-runtime-bundle.sh` 通过（含 runtime bundle 深度验证 + smoke test）。
- [ ] `bash scripts/preflight-check.sh` + `postbuild-validate.sh` 通过。
- [ ] `npm run dev` 启动正常，全功能可用。
- [ ] `rg "SidecarServer" src-electron/` 无残留。
- [ ] 打包产物 `app.asar.unpacked/dist/runtime/` 结构正确。

## 回滚

单阶段 commit（目录 mv + import + tsup 必须在一起）。`git revert <commit>` 还原目录与 tsup。

**禁止**：把 tsup 改动与目录 mv 拆成两个 commit（中间态打包必崩）。

## 风险

| 风险 | 应对 |
|------|------|
| tsup entry 漏更新 → `Cannot find module` | mv 后立即跑 `validate-runtime-bundle.sh`；逐文件核对 entry |
| import 路径漏改 → 编译失败 | `npm run build` 即可暴露；rg 全仓扫描被移文件名 |
| Worker 入口 `plugin-bootstrap` 路径 | 确认 tsup entry 仍含 `plugin-bootstrap.ts`（CLAUDE.md #12） |
