# 实施任务书：Agent-Managed Session（Phase 1 + Phase 2）

## 任务背景

xyz-agent 仓库（你所在的 git worktree，对应分支基于 `feat-firstmate-new-session`）要实施一份已通过 4 轮对抗式审查的技术设计文档 v4.1：

**权威设计文档（必读，实施前完整读一遍）**：
`/Users/zhushanwen/Code/xyz-agent-workspace/feat-firstmate-new-session/.tmp/agent-managed-session.md`

注意：该文档在 `.tmp/`（gitignore），你的 worktree 里**没有**这个文件——必须用上面的绝对路径跨 worktree 读取。文档 778 行，含完整的机制拆解、伪代码、现役先例引用（文件:行号）、验收场景、待验证检查点。**文档中所有"文件:行号"引用都指向主 worktree `/Users/zhushanwen/Code/xyz-agent-workspace/feat-firstmate-new-session/` 下的源码**，读代码时用该绝对路径前缀。

方案一句话：新建 pi extension `extensions/session-manager/` 暴露 6 个 session 管理工具，跨进程通信复用 pi 现役 `extension_ui_request`/`extension_ui_response` 骨架（extension 工具内 `ctx.ui.select('\x00XYZ_SESSION_MANAGER', [请求JSON], {timeout:60s, signal})` → runtime event-adapter marker 分支拦截 → interpreter 新 case → handler 调 SessionService → `sendExtensionUiResponse` 回写 JSON 结果）；元数据 Phase 1 内存态、Phase 2 sidecar `.spawn.json` 持久化 + 侧栏 [AI] badge。

## 目标范围

实施设计文档 **Phase 1（U1-U7）+ Phase 2（U8-U9）**，Phase 3（权限治理）明确 out-of-scope。

交付后达成（设计文档 §7.2 + §7.3 验收场景全部可判定）：
- agent 经工具创建独立 session、注入 prompt，侧栏自动出现条目
- 用户可点击进入继续对话；agent 可 send/read/status/list/abort 管理子 session
- Phase 2：重启后 badge 与父子关系保留（sidecar）

## 拆分建议（designer 参考设计文档 §9，可调整但须保持验收覆盖）

| unit | 内容 | 依赖 |
|------|------|------|
| U1 | `packages/extension-protocol/src/extensions/session-manager/marker.ts`：marker 常量 + 请求/结果 schema 类型 + 审计 entry schema（单一 SSOT） | 无 |
| U2 | `extensions/session-manager/` extension 骨架（package.json、tsconfig、入口，包名 `@zhushanwen/pi-session-manager`，对齐现有 19 个 extension 结构） | U1 |
| U3 | runtime 拦截与路由：event-adapter marker 分支（`packages/runtime/src/infra/pi/event-adapter.ts` handleExtensionUIRequest 内，ASK_USER_MARKER 分支同位置后）+ `PiTranslatedEvent` 联合新增 kind（`packages/runtime/src/services/session/types.ts`）+ interpreter case（event-interpreter.ts）+ 组合根 fire-and-forget 接线 | U1 |
| U4 | `packages/runtime/src/services/session/session-manager-handler.ts`：6 个 action 分支 + `broadcastSessionList` opts 注入（handoff-service.ts:40/:305 先例）+ malformed 兜底 + modelId 从 state.model 组装 | U3 |
| U5 | extension 侧 6 个工具（requestSessionManager 通信核心 + 审计 entry，`pi.appendEntry` 闭包写法） | U2,U4 |
| U6 | 元数据：`packages/shared/src/session.ts` SessionSummary 扩展 + session-lifecycle options + 内存态透传（Phase 1） | U4 |
| U7 | sidecar `.spawn.json`（persistSpawnSidecar 三件套照搬 persistHandoffSidecar + scanSessionMeta 提取 + scannedToSummary 透传）+ 前端 SessionItem badge（Phase 2） | U6 |
| U8 | 测试与端到端验收脚本（vitest 单测 + pi CLI 级 e2e 探针） | U5 |

## 验收硬性要求（spec 设计约束，designer 必须遵守）

1. **通道端到端闭环是最高优先验收**（设计文档 §10 首项）：e2e-real 型，用 pi CLI + 探针 runtime 验证——临时/真实 extension 发 `ctx.ui.select(MARKER, ...)`，node 探针脚本模拟 runtime 侧（解析 pi stdout 的 extension_ui_request、检测 marker、回写 extension_ui_response 到 stdin），断言工具内 await 拿到结果。pi 启动参照：`pi --mode rpc --session-dir <tmpdir> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <path>` + stdin JSONL 发 prompt。探针脚本自包含（e2e-sh 适配器要求输出 `<验收id> PASS|FAIL` 标记行；cw verify 是干净 checkout 重跑，脚本内依赖自含）。
2. **测试框架 vitest**（项目红线：禁 node:test / tsx --test；配置在子包 vitest.config.ts，从子包目录运行）。vitest 用例 fullName 须以词边界包含验收 id。
3. **GUI 级验收（侧栏出现条目/badge）不要用 manual 型**：用 pi CLI 级 / runtime 层 e2e 替代（断言 broadcastSessionList 回调被触发、SessionSummary 含 spawnSource 字段、sidecar 文件内容正确）；真实桌面 GUI 走查由主会话人工执行，不在 cw 验收内。
4. 至少一条 unit 级验收（spec gate 规则⑤）。
5. 验收命令用 pnpm（项目包管理器纪律：本项目开发者/CI 一律 pnpm；npm 例外仅限外部消费者场景）。
6. **extension 三连必须进验收**：`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test`（从仓库根运行）。

## 实施约束（违反即返工）

- **[MANDATORY] 不修改 pi 源码、不 fork**（node_modules/@earendil-works 只读）。pi 语义断言以 node_modules 实装 0.84.1 dist 为准。
- 设计文档 §6 的伪代码是经 4 轮审查验证的实施蓝本，关键细节不可偏离：
  - marker 值 `'\x00XYZ_SESSION_MANAGER'`（NUL 前缀约定，禁改可读字符串）
  - `appendEntry(customType, data)` 在 ExtensionAPI 闭包实例 `pi` 上（extension 入口函数参数），**不在**工具 execute 的 `ctx: ExtensionContext` 上
  - `ctx.ui.select(title, options: string[], opts?: {timeout?, signal?}): Promise<string | undefined>`——超时/中止 resolve undefined
  - event-adapter marker 检测失败也必须 return 专用事件（`__malformed__`），禁 fall-through（会弹前端对话框）
  - interpreter 回调 fire-and-forget（onBridgeUIRequest 同款，禁 await）
  - handler create 分支：create 成功 → broadcast（opts 注入回调）→ sendMessage → respond；catch 时 create 已成功则 error 附 sessionId + hint
  - `sendExtensionUiResponse(id, JSON.stringify(payload), 'select')`（第三参必须 'select'，走 value 分支）
  - sidecar 三件套：atomicWrite + existsSync 守卫（pi 延迟写窗口绝不预创建文件）+ sessionMetaCache.delete
- **SessionService 现有 API 不改动语义**，只加 options（spawnSource/parentAgentSessionId）。handler 是新增文件，不动 session-service.ts 主逻辑。
- 新 extension 目录结构与 tsconfig/package.json 对齐 `extensions/` 下现有包（参照 `extensions/ask-user/`、`extensions/rename-session/`）。
- 前端改动遵守 `~/Code/xyz-ui/CONVENTIONS.md`（禁原生 HTML/emoji、样式三层、badge 样式见设计文档 §6.4）。
- git commit 英文 conventional 风格。
- 所有新代码遵守仓库根 AGENTS.md（Electron 打包约束：runtime 新依赖同步 tsup noExternal；runtime 源码禁 import.meta.url）。

## 完成定义

设计文档 §10 待验证检查点中适用项全部有证据：
- 通道端到端闭环 e2e 通过（含延迟测量 <1s 量级）
- marker 请求不产生前端 WS 帧 / malformed 路径回 cancelled
- handler create 后 broadcast 生效（机器可判定）
- 大 payload 回传稳定（read_session_history 数十 KB）
- sidecar 写入/读取/重启恢复
- `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` 全绿
- runtime 子包 vitest 全绿
