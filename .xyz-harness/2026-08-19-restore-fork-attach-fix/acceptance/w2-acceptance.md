# W2 验收基线：护栏收尾（F4：attach 断言 + 生命周期等价测试 + ADR + 登记表 + checklist）

> 防篡改声明：本文件是 W2 的验收 SSOT，builder/verifier 禁止修改。设计依据 = `docs/architecture/restore-fork-attach-fix.md` §3.4（F4 护栏表 + D3/D4）与 §5 W2 行。W1 已入库（commit 668273adb）。

## pi 语义锚点（主 agent 已一手核实，直接采信）

- `get_state` 响应含 `sessionFile?: string` 字段（pi-mono `modes/rpc/rpc-types.ts:101`），附着后 = `setSessionFile` resolvePath 后的永久写目标（`core/session-manager.ts:815-816`）。
- 附着即绑定：`switch_session` → `SessionManager.open` + createRuntime 永久采纳（`core/agent-session-runtime.ts:193-209`）。

## 交付物

1. **attach 断言 helper**（`packages/runtime/src/infra/pi/process-manager.ts`）：`switchSession` 成功后调用 `getState()`，比对 `data.sessionFile` 与期望登记路径（**双侧 `path.resolve()` 归一**后比较——pi 侧 resolvePath = path.resolve；macOS `/var` vs `/private/var` symlink 差异以真实探针确认，若 resolve 不足以归一需在 helper 内说明并处理），不一致即 **throw**（fail loud，错误信息含两路径 + 上下文 + 恢复指引：检查 attach 目标是否 sessions 目录内正式文件）。helper 供三处共用。
2. **三接线点**：restoreSession（switchSession 后）、forkSession（switchSession 后）、withEphemeralPi（raceReadyTimeout 后）——「附着必断言」成为无例外结构。
3. **生命周期等价测试**（`packages/runtime/src/__tests__/equivalence/` **新建文件**，真实 pi 子进程 spawn——先例：同目录 `live-reload.test.ts` 与 W25 pi-protocol-contract，测试环境/模型配置/RUNTIME_TEST 变量全部参照先例，禁自创）：两用例——
   - restore 路径：真实会话文件 attach（switchSession）→ 发一轮真实 prompt → 等 assistant entry → destroySession → `loadEntriesFromFile`（或等价读取）断言**登记文件包含该轮 entry** → 重新 spawn 附着同一文件断言状态（entry 数/最后消息）一致。
   - fork 路径：同构（fork 文件 attach → 真实轮次 → destroy → 文件含该轮 → 重附着一致）。
4. **ADR-0062 §2 修订**：合法边界形态清单增补第三类（restore-time 归一化：inactive-only + 同目录 `.tmp-migrate-` 临时名 + renameSync 原子替换 + 变换仅限 strip session_end / header cwd fallback + 每文件最多一次幂等收敛），并澄清与 ⑥ fork 创建型「禁止演进为重写既有 session 文件」禁令的关系（F3 是独立受限形态、不经 ⑥ 入口、非 ⑥ 演化）。
5. **ADR-0063 新建**（`docs/adr/0063-session-attachment-invariants.md`）：附着不变量 I1（登记路径 ≡ pi 写路径 + 断言机制）、I2（会话内容只存在于 sessions 目录 + 内存，禁入 $TMPDIR）、I4（pi 行为断言必须引 pi-mono 源码行号，附本次根因与 MF1 教训作 [HISTORICAL] 案例）、I3（持久性屏障 + 等价测试引用）、I5（指向登记表条目）。状态 Accepted。
6. **登记表 I5 条目**：`docs/architecture/data-source-registry.md` §4（或主表）补「会话文件身份（sessionFilePath / attach 状态）」条目——owner = runtime 记账层（initializeManagedSession 登记 + attach 断言守卫），权威源 = sessions 目录扫描 + pi get_state 对账。
7. **review checklist 增补**：`.agents/skills/pr-cr-fix/agents/` 下 review-data-governance 对应文件增两条 MUST：对话数据禁入 $TMPDIR（I2）/ pi 内部行为断言须带 pi-mono 源码锚点（I4）。

## 验收条款（每条可证伪）

| # | 条款 | 证伪点 |
|---|------|--------|
| C1 | helper 存在 + 三接线生效：源码结构可指认（restore/fork/ephemeral 三处调用点） | 源码 |
| C2 | 断言行为：真实 `switchSession(A)` 成功后以期望路径 B 调 helper → throw；错误信息含 A、B 两路径与恢复指引；resolve 归一覆盖 `/var` vs `/private/var`（用例实测） | 真实用例（禁 mock getState 返回伪造值的空洞断言——真实附着 + 错误期望才是真验证） |
| C3 | withEphemeralPi 接线后既有 ephemeral 相关测试全绿（真实文件天然通过断言） | 命令 |
| C4 | 生命周期等价测试两用例绿（真实 pi spawn + 真实 prompt；文件含新轮次 entry 的断言逐 entry 类型可指认，非只断言行数） | 命令 + 断言语义 |
| C5 | 红性（verifier 执行）：断言 helper 改为 no-op（或删接线）→ C2 断言用例必须红；等价测试注入「读错文件」→ C4 必须红 | verifier 红性验证 |
| C6 | ADR-0062 §2 含第三类且与 ⑥ 禁令关系澄清；ADR-0063 覆盖 I1/I2/I3/I4/I5 五条且 pi 锚点真实（行号可对上 pi-mono 源码） | 文档逐条对照 |
| C7 | 登记表 I5 条目 + checklist 两条 MUST 增补落位 | 文档对照 |
| C8 | 回归：`cd packages/runtime && pnpm typecheck && pnpm exec vitest run` 全绿；`python3 .githooks/check_pi_direct_write.py` exit 0；`pnpm run lint` 零 error | 命令 |

## 边界（违反 = 越界）

- 只许新建/修改：`packages/runtime/src/infra/pi/process-manager.ts`（helper + ephemeral 接线）、`packages/runtime/src/services/session/session-lifecycle.ts`（两接线）、`packages/runtime/src/__tests__/equivalence/` 下**新建**测试文件、`docs/adr/0062-single-data-owner-absolute-write-rule.md`（§2 增补，只加不删原文风格参照其「修订追认」先例）、`docs/adr/0063-session-attachment-invariants.md`（新建）、`docs/architecture/data-source-registry.md`、`.agents/skills/pr-cr-fix/agents/`（checklist 对应文件）。
- **认知外未提交改动豁免（不碰不提交）**：`packages/runtime/src/infra/pi/rpc-client.ts`、`event-adapter.ts`、`equivalence/broadcast-getstate.test.ts`、equivalence/ 下其他已 modified 文件、packages/core、packages/renderer、packages/shared、taste-lint、`.github/workflows/ci.yml`、`TEST-STRATEGY.md` 及其他 git status 中非本 wave 清单的改动——一律不修改不还原不提交。等价测试若需与 equivalence 既有 helper 复用，只 import 不改动。
- 禁止 git 写操作；测试禁 mock pi 子进程（等价测试必须真实 spawn）；断言禁 `any`。

## 验收命令

```bash
cd /Users/zhushanwen/Code/xyz-agent-workspace/fix-chat-flow-order/packages/runtime && pnpm typecheck && pnpm exec vitest run
cd /Users/zhushanwen/Code/xyz-agent-workspace/fix-chat-flow-order && python3 .githooks/check_pi_direct_write.py && pnpm run lint
```
