# W1 验收报告（verifier 对抗式独立验收）

> 验收对象：活跃 session label 直写全量切 pi `set_session_name` RPC（+ tryPersistLabel 机制删除）
> 验收基线：commit `337a7c79d` 的 `w1-acceptance.md`；规格 SSOT = `docs/architecture/data-source-governance-plan.md` §2 W1 节
> 验收时间：2026-08-19 · verifier 独立实跑（builder 自报全部待证实，未采信任何自报数字）
> **总结论：PASS**（全部门槛项通过；2 条非阻断观察，见 §7）

## 1. 防篡改检查

| 检查项 | 结果 | 证据 |
|--------|------|------|
| `git diff 337a7c79d -- w1-acceptance.md` | 空（无篡改） | 实跑输出空 |
| `git diff 337a7c79d -- docs/architecture/data-source-governance-plan.md` | 空（无篡改） | 实跑输出空 |
| w1-acceptance.md sha256 | `09bd117a5a1ff787a066c8253a64e9f6e51b59e0c24dc80c68d62539b586b6ce` | shasum -a 256 |
| data-source-governance-plan.md sha256 | `f76097ed3055fd88b6d29e6bdbcc0c5216d78e0dc14e105519ca6795cc1f06c4` | shasum -a 256 |
| `git status -uall` 全量扫描 | 无越界 | 见下 |

**git status 逐项归类**（20 M + 1 新增 = 21 个 W1 文件 + W5 领地 2 untracked）：

- W1 交付物 9 文件：`src/infra/pi/rpc-client.ts`、`src/services/ports/pi-engine.ts`、`src/services/session/session-lifecycle.ts`、`src/services/session/session-service.ts`、`src/services/session/types.ts`、`test/rpc-client.test.ts`、`test/session-service.test.ts`、`test/session-service-w3.test.ts`、`test/session-lifecycle-rename.test.ts`（新增）——与交付清单 8 条（第 7 条含 2 文件）一一对应
- 清单外 11 机械适配：6 fixture 单行删 `labelPersisted: false,`（`src/__tests__/message-dispatcher-bash-race.test.ts` / `message-dispatcher-bash.test.ts` / `message-dispatcher-compact.test.ts`、`test/dispatcher-bus.test.ts` / `fork-orphan-cleanup.test.ts` / `message-dispatcher-precheck.test.ts`）+ 5 机制注释清理（`src/index.ts`、`src/services/session/event-interpreter.ts`、`src/services/session/session-internal.ts`、`test/event-interpreter-w3.test.ts`、`test/helpers/event-adapter-test-fixture.ts`）——逐文件 diff 核对，全部注释/单行删除，零行为夹带
- 授权注释修复 1 文件：`src/infra/pi/session-file-utils.ts`——两段 docstring 改写，diff 核对确认代码本体零改动（persistSessionName 逻辑、existsSync 守卫、warn 文案全部原样）；与 ledger 2026-08-19「W1 打回修复一轮 → 主 agent 裁决授权仅注释修正」轨迹一致
- W5 领地（豁免）：`src/__tests__/equivalence/live-reload.test.ts` + `pi-fixture.ts`（untracked）
- 基线后唯一 commit `118e6169e`（chore(harness): pre-stage W2 acceptance + ledger）仅触碰 `.xyz-harness/` 2 文件，主 agent 协调产物，符合账本目录豁免

**越界改动：0 项。**

## 2. 命令实跑（限定范围）

### 2.1 typecheck

```
cd packages/runtime && pnpm typecheck   →  tsc --noEmit  exit 0
```

### 2.2 全量测试（排除 equivalence，W5 并行豁免）

```
npx vitest run --exclude 'src/__tests__/equivalence/**'
 Test Files  266 passed (266)
      Tests  3104 passed (3104)
   Duration  35.64s
```

与 builder 自报 266 文件 / 3104 用例**精确一致**。无跳过、无失败，无需 W5 竞态归因。

### 2.3 四条 grep 断言（acceptance「通过命令」第 2 条）

| # | 断言 | 实跑结果 | 判定 |
|---|------|---------|------|
| 1 | `grep -n "set_session_name" src/infra/pi/rpc-client.ts` ≥1 | 3 命中（L512 注释 / L520 注释 / **L521 `sendCommand('set_session_name', { name }, FAST_TIMEOUT_MS)`**） | PASS |
| 2 | renameSession `if (session)` 分支无 `persistSessionName` 且 `else` 分支有 | 实跑 `sed -n '305,345p'`：活跃分支为 getClient guard + `await client.setSessionName(newName)`，无 persistSessionName；`else` 分支 `this.sessionStore.persistSessionName(target.filePath, newName, target.id, target.cwd)` 原样保留 | PASS |
| 3 | `grep -rn "tryPersistLabel\|labelPersisted" src test --include="*.ts"` = 0 | **0** | PASS |
| 4 | `grep -n "setSessionName" src/services/session/session-lifecycle.ts` ≥2 | 3 命中：L119（helper 内 `client.setSessionName(label)`）、L323（活跃 rename）、L121（错误上报字符串）——代码调用点 2 处 = 活跃 rename + create/fork helper | PASS |

行号漂移如实记录：plan 引用 renameSession L284（基线），现实现移至 L310（W1 注释 + helper 插入所致），按符号名定位核验，符合 acceptance 备注「行号漂移按符号名定位」。

## 3. 真实性抽查（防空洞断言）

### 3.1 session-lifecycle-rename.test.ts 四断言组 ↔ acceptance「单测验收」条款

| acceptance 条款 | 测试名 | 断言语义核验 |
|----------------|--------|-------------|
| 活跃 rename 走 RPC | 「活跃 rename 调 client.setSessionName(newName)，不再调 persistSessionName」 | **真实双断言**：`setSessionName` calledTimes(1) + calledWith('重构计划')；`persistSessionName` **not called**（回归守卫）；另断言内存 label / sessionMetaCache.getLabel / invalidateScanCache / refreshAll | 
| （契约：client undefined 必须 throw） | 「pi client 不可用（崩溃窗口）→ throw，不静默丢写、内存保留旧名」 | `rejects.toThrow('pi process is not available')` + persistSessionName not called + `session.label` 仍为旧名——非只断言不抛错 |
| （契约：RPC 失败抛错） | 「RPC 失败（success:false / 超时 reject）→ throw 给上层 toast」 | mockRejectedValue → `rejects.toThrow('set_session_name')` + 旧名保留 |
| create/fork 显式 label 走 RPC | 断言组 2 三用例 | create/fork 各断言 calledTimes(1)+calledWith(显式名)+persistSessionName not called；RPC 失败用例断言 summary 正常返回（id/label）+ console.error 被调——失败不阻断被真实验证 |
| 派生 label 不触发 RPC | 断言组 2 用例 3「create 不传 label」 | `setSessionName` **not called** + `initializeManagedSession` 收到 `basename(tmpDir)`（显示派生仍存在）+ persistSessionName not called；fork 不传 label 同款 |
| 非活跃分支不变 | 断言组 4 | persistSessionName calledTimes(1)+四参精确断言；**遍历 clientMap 断言所有 client 的 setSessionName 未被调**（非活跃不经 RPC） |

### 3.2 rpc-client U7a/U7b

- U7a：断言 `sent.type === 'set_session_name'` **且** `sent.name === '重构计划'`——命令名与 `{ name }` 参数是接口契约锁定项，断言直指 JSONL 写出内容（`lastWrittenJson()` 捕获 stdin），非 mock 自证
- U7b：pi 回 `success: false` → `rejects.toThrow('pi internal error')`——success 检查遵循 sendCommand 既有约定，实测通过

### 3.3 session-service-w3.test.ts 回归守卫语义

改写后断言的是：**「session 文件已存在时 handleTurnUsageSideEffects / handleTurnEndSideEffects 也不再调 `persistSessionName`」**（真实 tmp 文件 + writeFileSync 让 existsSync 返回 true——即便写路径技术上可行也不写）。守卫语义正确：锁死「turn/agent 结束不再直写 session_info」，防机制回潮。原 3 个 tryPersistLabel 行为用例（主路径/文件缺失跳过/labelPersisted 幂等）随机制删除，符合 acceptance「删除/改写」条款。

### 3.4 session-service.test.ts rename 用例

seedSession 走真实 `service.create(cwd, 'seed')`（显式 label → seeding 期 setSessionName('seed') 已被调一次），故 `toHaveBeenLastCalledWith('new name')` 是精确断言（第 2 次调用覆盖第 1 次）；client undefined 用例 `setup.clientMap.delete(id)` 后 rejects.toThrow + label 仍 'seed'——装置真实，非空洞。

## 4. 行为对抗抽查（6 条，全部代码路径级核验 + 测试佐证）

1. **throw guard 无可选链静默**：session-lifecycle.ts 活跃分支 `const client = this.pm.getClient(sessionId); if (!client) { throw new Error(...) }`——显式 guard，无 `?.` 静默 no-op。RPC 失败路径：`await client.setSessionName(newName)` 未包 try/catch，sendCommand reject（U7b 实证 success:false → reject）直接向上传播。**throw 可达既有失败路径**：transport/session-message-handler.ts:388 `await renameSession(...)` → server.ts `handleMessage` L346-352 统一 catch → `sendError(ws, 'handler_error', message, msg.id, { sessionId })` → 前端既有错误通路（toast）。「静默丢写 = 验收失败」条款无违反。
2. **create/fork 显式 label RPC 失败不阻断**：`persistExplicitLabel` 内 `try { await client.setSessionName(label) } catch (e) { console.error(...) }`——吞错 + 上报 + 继续；断言组 2 用例实测 summary 正常返回。**派生 label 不触发 RPC**：helper 首行 `if (label === undefined) return`，且调用点传的是**原始 label 参数**（`create(tmpDir)` 不传 → undefined），派生值 `label ?? basename(sessionCwd)` 只进 `initializeManagedSession` 显示层——代码路径与测试双重确认，basename 永不进 RPC。
3. **非活跃分支原样**：`git diff 337a7c79d -- session-lifecycle.ts` 中 else 分支（findScannedSession → persistSessionName 四参调用）不在 diff 中 = 字节级原样；断言组 4 独立测试覆盖。
4. **FAST_TIMEOUT_MS 对齐声明核验**（自选扩展）：rpc-client.ts:87 `FAST_TIMEOUT_MS = 10_000`；setSessionName（L520-521）与 getState（L605-606）、getCommands（L586-587）同为「L6 毫秒级操作用 FAST_TIMEOUT_MS」既有模式，方法签名/JSDoc 风格对齐 getState——与 plan 步骤 1「对齐现有 getState 的方法风格」一致。
5. **pi 上游 RPC 存在性对抗核实**（自选扩展，不采信 plan 预验证）：pi-mono 源码 `coding-agent/src/modes/rpc/rpc-mode.ts:632 case "set_session_name"` 实存（与 plan 所引行号精确一致）；`rpc-types.ts:66` 命令参数即 `{ name: string }`，与 xyz rpc-client 发送 payload 字段名一致；上游空名 guard（rpc-mode.ts:635）在空名时回 success:false → xyz 侧 throw——现有调用方（renderer rename 输入/handoff label）不产空名，无风险。
6. **注释清理无行为夹带**（自选扩展）：event-interpreter.ts / index.ts / session-internal.ts / event-adapter-test-fixture.ts / event-interpreter-w3.test.ts 五文件 diff 逐行核对，改动全部位于 docstring/行注释（tryPersistLabel 机制自述退场），零可执行行变更；session-service.ts 中 tryPersistProjectBinding 仅 docstring 内「对齐 labelPersisted 模式」措辞替换，方法本体未动。`existsSync` import 在 session-service.ts 仍有 8 处真实消费（L952/1280/1442/1479/1540/1586 等），无未用 import。

## 5. 三项偏差裁决

| # | 偏差 | 裁决 | 依据 |
|---|------|------|------|
| 1 | `pm.getClient(sessionId)` 替代 plan 的 `svc.getRpcClient(sessionId)` | **接受** | ① `ISessionServiceInternal`（session-internal.ts）grep 无 `getRpcClient`/`getClient` 任何声明——`this.svc.getRpcClient` 在 svc 类型为 ISessionServiceInternal 下 typecheck 必失败；② session-service.ts:522 `getRpcClient(sessionId) { return this.pm.getClient(sessionId) }` 是纯委托单行；③ `IProcessManager.getClient`（pi-engine.ts:216）返回 `IPiEngine | undefined`，与 plan 所述语义/类型完全等价。语义零漂移，属接口可达性的正确落点 |
| 2 | rename 失败语义「先 RPC 后改内存」（失败时内存保持旧名） | **接受** | 代码序：`await client.setSessionName(newName)` 先于 `session.label = newName` 与 `sessionMetaCache.setLabel`；断言组 1 两个失败用例均断言旧名保留。与 plan「保留旧名可重试，与 RPC 失败抛错自洽」原文一致，且优于「先改内存后 RPC」（后者失败时 UI 已显新名、实际未持久化——恰是 acceptance 点名的静默丢写形态）。plan 未规定语句顺序，此实现是对契约的严格满足 |
| 3 | 12 个清单外适配（6 fixture 单行删 + 5 注释清理）+ 2 行授权注释 | **接受，全部机械** | 6 fixture：diff 逐文件核对，各删且仅删 `labelPersisted: false,` 一行（types.ts 字段删除的必然编译适配）；5 注释清理：全部为已删机制 docstring 的措辞退场，无可执行行变更；session-file-utils.ts 两段注释：代码本体零改动，与 ledger 记录的主 agent 授权（2026-08-19 打回修复轮裁决）轨迹一致。**行为夹带：0** |

## 6. 条款对照总表

| acceptance 条款 | 结果 |
|----------------|------|
| 交付物 8 条（9 文件） | 全部落地，diff 与清单逐条对应 |
| 接口契约：命令名字面量 `'set_session_name'` + 参数 `{ name }` | PASS（L521 + U7a 直证 stdin JSONL） |
| 接口契约：client undefined 必须 throw（禁可选链静默） | PASS（显式 guard + 独立测试 + throw → sendError 链路核验） |
| 接口契约：RPC 失败抛错 | PASS（无 try/catch 包裹 + U7b + 断言组 1 用例 3） |
| 接口契约：create/fork RPC 失败不阻断 | PASS（catch + console.error + summary 正常返回实测） |
| 接口契约：保留 session.label 内存更新 + sessionMetaCache.setLabel | PASS（断言组 1 显式断言两者） |
| 禁碰：非活跃分支 persistSessionName / persistHandedOff / patchSessionCwd / session-file-utils 实现本体 | PASS（else 分支字节级原样；session-file-utils 仅注释，且经主 agent 授权） |
| 单测验收 3 条（rpc-client 用例 / 四断言组 / w3 断言删除） | PASS（§3 逐条核验） |
| 通过命令 3 条（typecheck+test / 四 grep / 行为级留给 P0 gate） | PASS（§2 实跑） |
| 禁改清单 | PASS（§1 防篡改 + 越界 0 项） |
| 工程约束（禁 mock 框架、禁 any、fixture 用真实 tmp） | 抽查未见违反：新测试 mock 仅注入协作对象（svc/pm/store 接口替身），fs fixture 用 mkdtempSync 真实 tmp；无 `any`（typecheck 0 错） |

## 7. 非阻断观察（不影响 PASS）

1. **create/fork 尾延迟上界 10s**：`persistExplicitLabel` 在 create/fork 返回前 `await`，RPC 挂死时最坏延迟 FAST_TIMEOUT_MS（10s）才返回 summary。plan 措辞是「失败不阻断」（≠ 不等待），10s 有界且成功路径毫秒级，合规；后续 wave 若在意创建延迟可改 fire-and-forget + 失败上报，此处仅登记。
2. **ledger 状态滞后**：ledger.md W1 行仍为 `building`，主 agent 在 verifier PASS 后流转即可，非 builder 责任。

## 8. 验证环境与只读声明

- 验收分支：fix-chat-flow-order（HEAD = `118e6169e`，工作区含 W1 未提交改动）
- 全程零 git 写操作、零代码/测试/文档修改；唯一写入 = 本报告文件
- 测试运行与 builder 交付态完全同一工作区（无篡改类验证，无需还原）
