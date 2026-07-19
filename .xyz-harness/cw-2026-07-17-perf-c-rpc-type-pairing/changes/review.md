# Code Review：perf-c-rpc-type-pairing（方案C 精简版）

**审查方法**：主 agent 自审（subagent 限额到）。逐 commit `git show` 看 diff，结合 runtime handler reply 调用、ClientMessageMap payload 定义、domain 返回类型交叉核对。跑 vue-tsc/tsc/vitest 验证。
**审查日期**：2026-07-17

## 审查结论：1 must-fix + 2 should-fix

6 个 commit 的核心实现（ReplyPayloadMap 62 key + command() 类型化 + 60 RPC 迁移）正确。类型安全到位（vue-tsc/tsc 三包零 error，迁移前后 domain 对外签名一致）。但发现契约测试的类型断言防线是假的（tsconfig exclude test 文件），且测试自身有字段名错误。

## 逐 commit 评价

### W1（5e35491a）：ServerMessageMapBase 补条目 + ReplyPayloadMap — ✅ 通过

- ServerMessageMapBase 补 17 条精确 payload，逐条抽样核对 runtime handler reply 字面量一致（session.created `{session}`、session.history `{sessionId, session?, messages, historyTruncated}`、model.switched `{sessionId, provider, modelId}`、file.read:result `{sessionId?, content, truncated, path}` 等）
- ReplyPayloadMap 62 key = 28 payload 型（引用 ServerMessageMap）+ 34 ack 型（void）。ack/payload 分类正确（model.switch 确认 register<void>）
- session.history 的 session 字段 optional（switch 路径有、history 路径无）——SR2 shape 分流正确
- message.status 的 status 用 string（CL10 决策，不收窄字面量）✅

### W2（14d9bd8e）：command() 类型化 + session.ts — ✅ 通过（R1 should-fix）

- command() 签名 `command<K extends keyof ReplyPayloadMap>(type:K, payload:ClientMessageMap[K], timeoutMs?)=>Promise<ReplyPayloadMap[K]>` 正确
- session.ts 16 个迁移正确，解包字段对（getCommands→reply.commands 等）
- 旧 request() 完全删除（无残留别名）✅
- **R1**：payload 默认值 `{} as ClientMessageMap[K]`（L37）——对必需 payload 的 RPC（如 message.send 需 {sessionId, content}），默认值让调用方可漏传必需字段不报错。实际调用都显式传了，非阻塞，但断言不安全

### W3（d6c2690c）：chat/config/model 迁移 — ✅ 通过

- 19 个 RPC 迁移正确。抽样 config.scanSkills：迁移前 `register<{skills,success}>` 解包 `.skills`，迁移后 `command('config.scanSkills')` reply 有 `.skills`（ServerMessageMap['config.scannedSkills']={skills,success}）——类型一致
- chat.getHistory 返回 HistoryResult {messages, historyTruncated}，与 ReplyPayloadMap['session.history'] 兼容
- chat.compact 传 COMPACT_TIMEOUT_MS 作为 command 第 3 参 ✅
- import 清理：chat/config/model 移除 pending/transport（保留 events 给订阅函数）

### W4（5d411c3a）：extension/file/git/composer/workspace — ✅ 通过

- 25 个 RPC 迁移正确。git.status 直接 `return command('git.status', {sessionId})` 返回 GitStatusResult（ServerMessageMap['git.status:result']=GitStatusResult）
- extension.ui_response 保留裸 transport.send（fire-and-forget，不在 ReplyPayloadMap）✅
- extension.getPendingRequests 的 reply.requests 是 unknown[]，前端 `as ExtensionUIRequest[]` 收窄（PendingUIRequest 是 runtime 专有，shared 依赖最小化）✅
- domain 零 pending.register 残留（grep 确认）

### W6（7ce996ed）：验证 + ADR — ✅ 通过

- baseline 对比法（W1 前 commit detached worktree）确认 vitest 零回归——所有失败是 pre-existing（markdown/session-sync/new-task/system-prompt 主题遗留）
- ADR-0040 verdict pass 合理

## Issues

### R1（should-fix）：command() payload 默认值不安全
- **file**：packages/renderer/src/api/request.ts:37
- **问题**：`payload: ClientMessageMap[K] = {} as ClientMessageMap[K]`。对必需 payload 的 RPC，默认 {} 让调用方可漏传必需字段不报错（`as` 断言绕过空对象赋值检查）
- **实际影响**：低。所有 domain 调用都显式传 payload。但断言本身不安全——未来新增 RPC 若忘传 payload 不报错
- **建议**：移除默认值，让必需 payload 的 RPC 必须传。无 payload 的 RPC（如 session.list）显式传 `{}`。或保留默认值但加注释说明取舍

### R2（must-fix）：契约测试类型断言无防线 + 测试自身字段名错误
- **file**：packages/renderer/tsconfig.json（exclude test）+ packages/renderer/src/__tests__/api/rpc-type-pairing.test.ts
- **问题**：tsconfig.json `exclude: ["src/**/__tests__/**", "src/**/*.test.ts"]` 导致 vue-tsc **不检查测试文件**。rpc-type-pairing.test.ts 的 U1-U4 类型断言（`@ts-expect-error`、赋值检查）**从未被验证**——U1-U4 的 vitest passed 是假绿灯（esbuild 剥离类型）。临时删 exclude 后 vue-tsc 发现测试自身 3 个 error：
  - L20 `ClientMessageMap` 导入未使用
  - L107/L115 `git.stage`/`git.unstage` 的 payload 写 `paths`，实际 ClientMessageMap 是 `filePaths`——**测试断言了错误的字段名却没被发现**
- **修复**：修 rpc-type-pairing.test.ts 的 3 个 error（paths→filePaths、删未用 import）。tsconfig exclude 是历史决策（测试文件有 130 个 pre-existing error），不宜全局去掉——改为加一个 tsconfig.typecheck-test.json 专门检查契约测试文件

### R3（should-fix）：契约测试需独立 typecheck 机制
- **问题**：R2 的根因——测试文件不参与 vue-tsc，契约测试的类型断言无自动化验证。需一个独立 typecheck 入口（tsconfig.typecheck-test.json 只 include 契约测试 + 其依赖），在 test 阶段或 CI 跑
- **建议**：W6 的 E1（vue-tsc gate）应含契约测试文件的 typecheck。可加 `"typecheck:test": "vue-tsc --noEmit -p tsconfig.typecheck-test.json"` 脚本

## 正面发现

1. **ReplyPayloadMap 配对精确**：62 个 key 逐条核对 runtime handler reply + domain register，无遗漏无错配
2. **迁移零运行时变更**：command() 内部仍是 pending.create+register+transport.send，domain 对外签名不变
3. **baseline 对比验证扎实**：W6 用 detached worktree 跑 W1 前 baseline，严格区分 pre-existing vs 本次引入
4. **extension.ui_response 处理得当**：正确识别为 fire-and-forget，保留裸 transport.send 不误用 command()
5. **import 清理干净**：迁移后无用的 pending/transport import 全部移除
