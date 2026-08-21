# W5 验收报告：等价性测试骨架（pi fixture + live≡reload 雏形）

> verifier 独立对抗式验收（builder 自报均经实测证实）。验收时间 2026-08-19 03:13-03:19（本地时钟）。
> 基线 commit `337a7c79d`（HEAD `118e6169e` 为基线之上的 harness pre-stage，仅新增 w2-acceptance.md + ledger 更新，未触碰验收权威文件）。

## 总结论：PASS

## 一、防篡改

| 检查 | 结果 |
|------|------|
| `git diff 337a7c79d -- .xyz-harness/.../acceptance/w5-acceptance.md` | 空（无改动） |
| `git diff 337a7c79d -- docs/architecture/data-source-governance-plan.md` | 空（无改动） |

sha256（验收时点）：

```
3968d16c63911778862bed56c7c0440f25aab4417441e2aa062fb8346d1a32a2  w5-acceptance.md
f76097ed3055fd88b6d29e6bdbcc0c5216d78e0dc14e105519ca6795cc1f06c4  docs/architecture/data-source-governance-plan.md
f43a934b07d850436cd0e4bd7f2e1dac657b3d3b579abcac8bfaa99703ab1383  packages/runtime/src/__tests__/equivalence/pi-fixture.ts
21551b45de3f2735bfd618c4679bae9a9ffbef3b215d8f1b2385dbecf4f02672  packages/runtime/src/__tests__/equivalence/live-reload.test.ts
```

两交付文件在全部对抗抽查结束后复测 sha 不变（字节级还原验证的一部分）。

## 二、领地扫描（git status 全量）

W5 交付物 = 两个 untracked 文件（`packages/runtime/src/__tests__/equivalence/pi-fixture.ts` 315 行 / `live-reload.test.ts` 86 行），与 builder 自报一致，均为净新增。

工作区另有一批 modified/untracked 文件，分两类：

1. **W1 豁免领地内（8 文件，任务简报明示豁免）**：rpc-client.ts、pi-engine.ts、session-lifecycle.ts、session-service.ts、types.ts、test/rpc-client.test.ts、test/session-service.test.ts、test/session-service-w3.test.ts。
2. **超出豁免清单的改动（记录 + 归因 W1，非 W5 越界）**：
   - `packages/runtime/src/index.ts`、`services/session/event-interpreter.ts`、`services/session/session-internal.ts`（注释级改动，内容全是 W1「label 持久化移交 pi set_session_name RPC」语义）
   - `src/__tests__/message-dispatcher-bash(-race)?.test.ts`、`message-dispatcher-compact.test.ts`、`test/dispatcher-bus.test.ts`、`fork-orphan-cleanup.test.ts`、`message-dispatcher-precheck.test.ts`（各删 1 行 `labelPersisted: false,`——W1 删除该字段所致连锁）
   - `test/event-interpreter-w3.test.ts`、`test/helpers/event-adapter-test-fixture.ts`、untracked `test/session-lifecycle-rename.test.ts`
   - 验收期间新增：`src/infra/pi/session-file-utils.ts`（纯注释改动，同样为 W1 label 持久化语义）

   **判定依据**：对全部 runtime diff grep `equivalence|pi-fixture|live-reload|dsg` 零命中——所有超豁免改动与 W5 范围无任何关联，属 W1 builder 并行中途态外溢。W5 未越界。超豁免文件清单移交主 agent（W1 verifier 处置范围）。

## 三、命令实跑

| 命令 | 结果 |
|------|------|
| `cd packages/runtime && pnpm typecheck` | exit 0 |
| `cd packages/runtime && pnpm exec vitest run src/__tests__/equivalence/` | **1 passed**（真实 spawn，见下） |
| `cd packages/runtime && pnpm test`（全量） | **267 files / 3105 tests 全 passed，0 failed** |

真实 spawn 输出尾部：

```
$ which pi → /Users/zhushanwen/.nvm/versions/node/v24.11.1/bin/pi（pi 0.84.0）
 ✓ src/__tests__/equivalence/live-reload.test.ts (1 test) 5492ms
     ✓ 实时累积的消息快照 == get_entries 全量重放快照  5492ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

任务简报预告的「全量 4 failed（session-service 两文件，W1 中途态）」**未复现**——W1 并行开发已推进至全绿时点，无需归因记录失败项。

## 四、条款对照表（w5-acceptance.md 单测验收 / 契约锁定）

| 条款 | 实测 | 结论 |
|------|------|------|
| live≡reload 断言 deep equal 非只断长度 | `live-reload.test.ts:69-71`：`length > 0` 非空守卫（防 0==0 空转）+ `expect(liveMessages).toEqual(reloadMessages)` 全对象 deep equal；另 L74-78 parentId 线性链逐字段断言 | 满足 |
| skipIf 语义真实存在 | `live-reload.test.ts:31` `describe.skipIf(!PI_PATH)`；`pi-fixture.ts:115` 模块顶层 `export const PI_PATH = detectPi()`；文件头 L4-10 写明契约 | 满足 |
| dispose 后 existsSync === false 在测试内 | `live-reload.test.ts:81-84`：记录 sessionDir → `await fx.dispose()` → `expect(existsSync(sessionDir)).toBe(false)` | 满足 |
| pi 探测命令形态与生产一致 | `pi-fixture.ts:100-101` `isWindows ? 'where pi' : 'which pi'` + `execSync(...).trim()` + `split('\n')[0].trim()` + `existsSync` 校验，与 `process-manager.ts`（PATH fallback 分支，L52 起）逐形态一致 | 满足 |
| 禁 mock pi 子进程 | 两文件 grep `vi.mock` 零命中（仅文件头注释陈述禁令）；测试为真实 spawn（实测 5.49s 真实 LLM turn） | 满足 |
| 禁 `any` | 两文件 grep `\bany\b` 零命中；类型收窄用运行时 guard（`isRpcResponse`/`asStreamEvent`，`Array.isArray` 后 `as unknown[]`） | 满足 |
| spawn 命令形态 | `pi-fixture.ts:149` `['--mode','rpc','--session-dir',<tmp>,'--model',model,'--approve']`；model 默认 `xiaomi-token-plan-cn/mimo-v2.5-pro` | 满足 |
| 冷启动等待上限 5s | `pi-fixture.ts:35` `DEFAULT_COLD_START_TIMEOUT_MS = 5_000`；探针 RPC `get_state`（毫秒级只读） | 满足 |
| vitest 沿用既有配置、零改动 | `packages/runtime/vitest.config.ts` 无改动（不在 git status modified 列表）；include `src/**/*.test.ts` 覆盖 equivalence 目录 | 满足 |
| message_end 等价源依据自洽 | 见下「协议事实核验」 | 满足 |

### 协议事实核验（fixture 文件头声明 vs pi-mono 0.84 源码）

pi 源码位置 `~/Code/git-fork/pi-mono-workspace/main/packages/coding-agent/src/`：

1. 「pi 0.84 不为常规 entry append 发 entry 事件，entry_appended 仅 extension appendEntry 路径」——`core/agent-session.ts:2266-2270`：`entry_appended` 全仓唯一 emit 点在 extension host 的 `appendEntry: (customType, data) => {...}` 回调内。**属实**。
2. 「message_end 先 emit、随后 appendMessage 持久化」——`core/agent-session.ts:515/545/561`：`_handleAgentEvent` 中 `event.type === "message_end"` 分支先处理，`sessionManager.appendMessage(event.message)` 随后持久化；L625-628 注释明确 agent-core 在 emit 前已定稿 message 对象。**属实**。
3. 「rpc 模式启动即 session.subscribe 并转发事件到 stdout，无独立 session.subscribe RPC」——`modes/rpc/rpc-mode.ts:354` `unsubscribe = session.subscribe((event) => {...})`。**属实**。

测试「从 message_end 流累积快照后与 get_entries 全量对比」为真实行为：`live-reload.test.ts:51-54` collectEvents 过滤 `message_end` 取 `.message`，L57-66 `get_entries` RPC 取 message entry 的 `.message`，L71 deep equal——实测通过即两快照在真实 turn 上逐字段相等。

## 五、对抗抽查记录（4 条，均真实执行）

### 对抗 1：断言非空转复验（验收条款 2）

- 篡改：`toEqual(reloadMessages)` → `toEqual([...reloadMessages, { role: 'ghost' }])`（perl 单点替换）
- 结果：**1 failed**，diff 输出显示 live 快照不含 ghost 元素——deep equal 真实比较对象内容，非空转
- 还原：`cp` 备份回拷，sha256 复测 = `21551b45...`（与篡改前逐字节一致），复跑 **1 passed**

### 对抗 2：pi 缺席 skip（验收契约「skip 计数 >0 且 fail=0」）

- 第一次尝试 `PATH=/tmp/dsg-nopi-bin:/usr/bin:/bin pnpm exec vitest run ...`（bin 目录 = nvm bin 去 pi 符号链接）：**测试仍真实跑通而非 skip**——排查发现非 fixture 缺陷：`pnpm exec` 会向 PATH 注入 `node_modules/.bin`，而仓库根 `node_modules/.bin/pi` 存在（`@earendil-works/pi-coding-agent` devDependency 提供的 bin 链接）。注入诊断证实 worker PATH = `./node_modules/.bin:<repo>/node_modules/.bin:...`，`which pi` 解析到仓库内 .bin/pi
- 改用绕过注入的方式直跑：`env PATH=/tmp/dsg-nopi-bin:/usr/bin:/bin node ../../node_modules/vitest/dist/cli.js run src/__tests__/equivalence/` →

```
 ↓ src/__tests__/equivalence/live-reload.test.ts (1 test | 1 skipped)
 Test Files  1 skipped (1)
      Tests  1 skipped (1)
```

**skip 语义真实生效（1 skipped，0 failed）**。附注（观察项，非缺陷）：在本仓经 `pnpm exec` 运行时 node_modules 装好即恒能找到 pi（.bin 注入），skip 分支实际触发场景为「未 install / CI 精简环境」；生产 `process-manager.ts` 探测 PATH 同样会命中 .bin 注入路径，行为一致。

### 对抗 3：临时目录清理

- 正常路径：测试内置 `existsSync === false` 断言（实测通过）
- 失败路径（对抗 4 执行期间同步验证）：冷启动失败 → `dispose()` 走 error 清理分支后，`ls -d $TMPDIR/pi-equiv-* /tmp/pi-equiv-*` 零残留
- 终态复扫：全部对抗抽查结束后 `$TMPDIR` 与 `/tmp` 均无 `pi-equiv-*`/`dsg-equivalence-*` 残留；`pgrep -fl "mode rpc"` 无孤儿 pi 进程（SIGTERM→SIGKILL 升级逻辑未遗留进程）

### 对抗 4（自扩）：冷启动等待边界

- 篡改：`spawnPiFixture()` → `spawnPiFixture({ coldStartTimeoutMs: 1 })`
- 结果：**1 failed**，错误信息 `pi 冷启动就绪等待失败（上限 1ms）：RPC "get_state" timed out after 1ms`——冷启动等待逻辑真实执行且有上限强制；失败路径自动 dispose（临时目录无残留，见对抗 3）
- 还原：sha256 复测一致，复跑绿

### 终态一致性（硬性约束）

对抗抽查前后 `git status --porcelain -uall` 与 `git diff 337a7c79d` 快照对比：**唯一差异为 W1 并行新改的 `session-file-utils.ts`（见领地扫描第 2 类，与本验收无关）**；equivalence 两文件、受保护两文档、其余全部文件 byte-identical。verifier 探针产物（/tmp/dsg-nopi-bin、备份副本）已清理。

## 六、观察项（不影响 PASS）

1. **规模**：pi-fixture.ts 315 行，略超 acceptance 备注 M 档上限「~250-300 行」约 5%。备注明示「超预算形态上报调级而非压缩清理逻辑」——超出部分为 stderr tail 诊断、非 JSONL 行截留、SIGKILL 升级等清理/诊断逻辑，符合该备注取向。记录不扣分。
2. **`pnpm exec` 下 skip 难以触发**：见对抗 2 附注。后续 wave 若需在 CI 验证 skip 分支，须知 node_modules 存在时 pi 恒在场。
3. **超豁免清单的 W1 外溢文件**（index.ts / event-interpreter.ts / session-internal.ts / session-file-utils.ts / 6 个 labelPersisted 删除的测试文件 / session-lifecycle-rename.test.ts 等）：内容与 W5 无关，但 W1 的实际触达面大于任务简报豁免清单——移交主 agent 决定是否需要 W1 侧补声明。

## 七、结论

W5 全部验收条款实测通过：净新增两文件、真实 pi 子进程 fixture 可复用、live≡reload deep equal 断言非空转、skip/清理/冷启动边界均真实生效、全量回归零失败、验收权威文件零篡改。**PASS**。
