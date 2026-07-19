# Plan Review：perf-c-rpc-type-pairing

**审查方法**：主 agent 自审（spec_review 刚用过禁读重建 fresh 视角，plan 的 wave 直接映射 FR，自审按 coverage/architecture/feasibility 三维度）。
**审查日期**：2026-07-17

## 审查结论：通过，1 must-fix + 2 should-fix

### coverage（FR → wave 映射）

| FR/AC | 对应 wave | 覆盖 |
|-------|----------|------|
| FR-1 ServerMessageMap 补条目 | W1 | ✅ |
| FR-2 ReplyPayloadMap | W1 | ✅ |
| FR-4 command() 升级 | W2 | ✅ |
| FR-5 domain 迁移（63 RPC） | W3(39)+W4(24) | ✅ |
| FR-6 mock 对齐 | W5 | ✅ |
| AC-7 vue-tsc/tsc 零 error | **无显式 wave** | ⚠️ PR1 |
| AC-8 既有测试全绿 | **无显式 wave** | ⚠️ PR1 |

### PR1（must-fix）：W6 缺 AC-7/AC-8 验证步骤

W6 只写「门面三元确认」，没有 vue-tsc/tsc 零 error + 既有测试全绿的显式验证。纯类型重构最大的风险是「类型改动引发编译错误或行为回归」，AC-7/AC-8 是核心验收，必须有 wave 承载。

**修正**：W6 changes 增加 `packages/renderer`（vue-tsc 零 error）、`packages/runtime`（tsc 零 error）、全量 vitest 回归。

### PR2（should-fix）：W2 request→command 改名策略模糊

W2 写「保留 request 名作 deprecated re-export 过渡（或直接改名全量替换）」——二选一未定。session.ts:11 有 `import { request } from '../request'`，W3 改 session.ts 时若 request 还没改名会断裂。

**修正**：W2 明确「全量替换」——request.ts 导出 command()，删除 request()，所有 import 同步改（session.ts 在 W3 改，但 W2 提交时 session.ts 的 import 会断）。或 W2 保留 `request = command` 别名过渡，W3 改 session.ts 时换 import。

**决策**：W2 直接改名 command() + 同步改 session.ts 的 import（W2 提交时一并改 session.ts 的 import 行，RPC 调用体留 W3）。避免过渡态别名。

### PR3（should-fix）：W3 偏重（4 文件 39 RPC）

W3 改 session(17)+chat(8)+config(13)+model(1)=39 RPC，4 文件。每个 RPC 改动机械（泛型手写→command 字面量），但 39 个一次 commit 出错排查面大。

**评估**：可接受。改动模式高度一致（request<{...}>('x') → command('x') 或 pending.register+transport.send → command），出错也是同类错误一次性发现。不拆。

## architecture（wave 拆分 + 依赖链）

- W1（协议层基础设施）→ W2（command 原语）→ W3/W4（domain 迁移，并行无依赖）→ W5（mock）→ W6（验证）。依赖链无环、无遗漏前置 ✅
- W3/W4 按 domain 域分组（session/chat/config/model vs extension/file/git/composer/workspace），高内聚 ✅
- W1 单文件改最多（protocol.ts 补 25 条 + 建 63 key map），但是类型声明机械工作，可接受

## feasibility（可执行性）

- W1：补 ServerMessageMap 条目需逐条核对 runtime handler 的 reply payload shape。约 25 条，机械但需仔细。ReplyPayloadMap 63 key 需逐条判定 ack(void) vs payload(引用)。可行
- W2：command() 类型推导链已在 spec_review 前用 tsc 验证可行（/tmp/verify-slim.ts）。可行
- W3/W4：domain 迁移是 find-replace 式机械改动。可行
- W5：mock 对齐——mock 返回类型手写对齐 domain 最终返回类型（SR3）。需逐个 domain 函数核对返回类型。可行
- W6：验证步骤。可行

## 修正后的 wave 摘要

W1 protocol.ts（补条目 + ReplyPayloadMap 63 key）→ W2 request.ts（command 改名+类型化，同步改 session.ts import）→ W3 session/chat/config/model（39 RPC）→ W4 extension/file/git/composer/workspace（24 RPC）→ W5 mock（手写对齐）→ W6（门面确认 + vue-tsc/tsc 零 error + 全量测试回归）
