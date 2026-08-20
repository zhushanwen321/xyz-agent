# W7 Verifier Report: label / thinkingLevel / modelId 三实例 + 失效接线

> 验收人：verifier（对抗式独立验收，builder 自报全部待证实）
> 验收基线：commit `962e51c5e` 的 `w7-acceptance.md`；规格 SSOT：`docs/architecture/data-source-governance-plan.md` W7 节（L257-285）
> 日期：2026-08-19

## 总结论：**PASS**（2 条 minor 观察，无 must-fix）

---

## 1. 防篡改

| 检查项 | 结果 |
|---|---|
| `git diff 962e51c5e -- .xyz-harness/.../w7-acceptance.md` | 空 ✓ |
| `git diff 962e51c5e -- docs/architecture/data-source-governance-plan.md` | 空 ✓ |
| w7-acceptance.md sha256（工作区 == 基线 commit） | `b5b5694408fa415446e9bec591fd6ee429d26c11b967ec2fc625ee9eb6ae83a9` ✓ |
| data-source-governance-plan.md sha256（工作区 == 基线 commit） | `f76097ed3055fd88b6d29e6bdbcc0c5216d78e0dc14e105519ca6795cc1f06c4` ✓ |

越界扫描（`git status -uall`）：

- 工作区未提交改动 = W7 五文件（`packages/runtime/src/index.ts`、`services/session/event-interpreter.ts`、`services/session/session-service.ts` [modified]；`services/session/replicated-states.config.ts`、`__tests__/equivalence/scalar-state-invalidation.test.ts` [untracked]）+ `w8-acceptance.md`（主 agent 预置的下一 wave baseline，与 `962e51c5e` 同模式的 harness 预置，非 builder 产物）。
- ledger（登记表）相对 HEAD 无改动 ✓（W7 禁改登记表——遵守）。
- W6 原语 `replicated-state.ts` 工作区无改动 ✓（W6 领地未碰；相对 962e51c5e 的 292 行 diff 是 W6 commit `3e44c514c` 的已提交内容）。
- W16/W20 已 committed，无残留 ✓。

## 2. 命令实跑（verifier 独立执行）

| 命令 | 结果 |
|---|---|
| `grep -n "markDirty" .../event-interpreter.ts` | **10 命中**（真实调用 L316 thinking-level / L324 session-renamed；其余为注释与类型声明）。条款 ≥2 ✓。**builder 自报 11，实测 10，偏差 1**（见 §6 观察 1） |
| `grep "sessionMetaCache.setLabel\|sessionMetaCache.setThinkingLevel" event-interpreter.ts` | **0 命中** ✓ |
| `cd packages/runtime && pnpm typecheck` | 通过（tsc --noEmit 无输出）✓ |
| `cd packages/runtime && pnpm test` | **Test Files 269 passed，Tests 3124 passed** ✓（builder 自报 3124 属实） |
| `pnpm exec vitest run src/__tests__/equivalence/` | **2 文件 / 7 用例全绿**（live-reload 1 + scalar-state-invalidation 6 = mock 4 + 真实 pi 2）✓ |

## 3. 条款对照（w7-acceptance.md）

| 条款 | 证据 | 判定 |
|---|---|---|
| 交付物 1 配置工厂 | `replicated-states.config.ts`：`createLabelStateConfig` / `createThinkingLevelStateConfig` / `createModelIdStateConfig`，`SCALAR_STATE_DEBOUNCE_MS = 300`，`THINKING_LEVEL_POLL_INTERVAL_MS = 30_000`，`projectSessionScalars` 投影 | ✓ |
| 交付物 2 session-service | `ScalarReplicatedStates` 接口 + `replicatedStates` Map；注册点 `initializeManagedSession` L1244（create/restore/fork 三入口汇聚——实测调用方 `session-lifecycle.ts` L255/L484/L661）；switchModel 成功后 `markDirty()`（L508，失败路径 throw 在前不经过）；`fetchStateSnapshot`（复用 `pm.getClient().getState()`）；dispose 挂 `removeSessionEntry` | ✓ |
| 交付物 3 interpreter | 两事件 markDirty（L316/L324）+ 旧回调保留双写过渡（`onThinkingLevelChanged` / `onSessionRenamed` 照调） | ✓ |
| 交付物 4 index.ts | L296-306 `onSessionRenamed` 直写点改读实例快照（播种未就绪 fallback payload）；L309-310 注入 `labelState`/`thinkingLevelState` 延迟解析器（捕获 `createAdapter` 闭包的 sessionId） | ✓ |
| 交付物 5 equivalence 用例 | `scalar-state-invalidation.test.ts` 6 用例 | ✓ |
| 配置锁定 label | fetch `sessionName`；失效 `session_info_changed`；空值 `'explicit-null'` | ✓ |
| 配置锁定 thinkingLevel | fetch `thinkingLevel`；失效事件 + `pollIntervalMs: 30_000`；`'required'` | ✓ |
| 配置锁定 modelId | fetch `model` 投影 `'${provider}/${id}'`；失效 switchModel RPC 响应；`'required'` | ✓ |
| 禁改清单 | event-adapter.ts / message-converter.ts / extensions/ / session-meta-cache.ts 本体均无工作区改动；无 git 写操作；grep `: any`（新代码）无命中 | ✓ |

## 4. 真实性抽查

1. **「事件只做失效」差异化值手法**——真实存在。mock it 3（test L114-144）用三值区分：播种 `'旧名'`、get_state mock 返回 `'权威新名'`、事件 payload `'事件payload名'`。断言链：事件后立即 `get()` = `'旧名'`（不直写）→ 防抖到点后 = `'权威新名'`（快照来自 get_state 而非事件 payload）。手法有效证明数据来源。
2. **switchModel 失败不失效**——it 2（L99-112）：`setModel.mockRejectedValue('rpc down')` → `switchModel` rejects → `markDirtySpy` not called ✓（实现侧 markDirty 在 RPC throw 之后，L508）。
3. **thinking_level_changed 同构 + 双写保留**——it 4（L146-171）：`'low'` → 快照 `'high'` vs payload `'事件payload档位'` 三值；`onThinkingLevelChanged` 双写回调保留断言 L166 ✓。
4. **真实 pi 两次改名收敛**——it 1（L198-254）：播种 → 第一次改名 `'equiv-w7-label'` 收敛 → 第二次改名 `'equiv-w7-label-2'` 收敛（L244-250，防首次播种空转）✓；modelId 播种一致性断言独立重算 `${provider}/${id}` 与实例快照相等（L216-223）✓；终态等价断言（L240-242）防 0==0 空转。
5. **dispose 编排（ADR-0049）**——`removeSessionEntry`（L1135-1170）是全部删除路径汇聚点（主动删 `lifecycle.delete` 与进程退出 `onSessionExit` L233→L253 均汇入）；三实例 `dispose()` + Map delete 与 `historyCache.delete` 同点（L1155-1164）。thinkingLevel 的 30s pollInterval 定时器随 dispose 清除。

## 5. 行为对抗抽查

### 5.1 红性验证（字节级还原）

- 备份：`cp event-interpreter.ts /tmp/...`，sha256 `671720ab892612722e26d98ae9d69ad346dcca083ecd7a9371c5508e9e924d36`。
- 注入直写回退：session-renamed 分支临时改为运行时直写实例 `snapshot` 字段（`snapshot = { sessionName: ev.name }`，模拟事件直写），保留 markDirty。
- 结果：it 3 **红**——`AssertionError: expected { sessionName: '事件payload名' } to deeply equal { sessionName: '旧名' }`。「事件到达后立即读值为旧快照」断言真实有效。
- 还原：从备份 cp 回，sha256 与原值一致（`671720ab...`），复跑该文件 6/6 绿 ✓。

### 5.2 modelId 投影事实独立核实（pi-mono 源码）

- `~/Code/git-fork/pi-mono-workspace/main/packages/coding-agent/src/modes/rpc/rpc-mode.ts` L442-458：`get_state` 返回 `model: session.model`（**Model 对象**，非裸字符串）；`set_model` 参数为 `command.provider` + `command.modelId`（裸 id）。
- `rpc-types.ts` L94：`model?: Model<any>`。
- `ai/src/types.ts` L666：`interface Model { id: string; name: string; provider: ProviderId; ... }`。
- **结论：builder 事实修正属实**。config 投影 `` `${m.provider}/${m.id}` `` 与 runtime `session.modelId` 的 `'provider/model'` 口径一致；测试 `set_model` 传裸 provider+id 也与 pi 参数形态一致。

### 5.3 projectSessionScalars 防线（探针实跑，/tmp 临时脚本未入仓）

| 输入 | 行为 | 语义判定 |
|---|---|---|
| `undefined` / `null` / `'garbage'`（三配置） | 抛 `WireSnapshotSchemaError` | ✓ 整包缺失 ≠ sessionName 未命名——label 空值语义关键防线成立 |
| 正常 `{}`（sessionName key 缺失） | label 返回 `{}` 不抛；由 W6 原语 `'explicit-null'` 归一物化 undefined 覆盖 | ✓ 分级正确：state 正常到达且 key 缺失才是未命名 |
| `{}`（thinkingLevel/modelId key 缺失） | fetch 返回 `{}`，原语层 `'required'` 归一抛 → 快照失败退避 | ✓（归一链路为 W6 已测行为） |
| `{ model: { id, provider } }` | 返回 `{ modelId: 'provider/id' }` | ✓ |
| `{ model: 'provider/id' }`（字符串） | 返回 `{}` → `'required'` 抛 | ✓ 协议异常不当字段不动 |

## 6. 三项裁决（builder 上报）

1. **采样数字与登记策略**：采样用例三次运行（builder 1 次 + verifier 2 次）`get_state` 总次数恒定 **5（播种 3 + 失效驱动 2）**；p95 = 4.9ms / 1.1ms / 0.7ms。**裁决：次数结构性可信；p95 为毫秒级且 n=5 样本极小，运行间波动大，登记表建议记「5 次（播种 3 + 失效 2）、p95 毫秒级（<5ms）」数量级表述而非单点值**。落表动作归主 agent（W7 禁改登记表已遵守）。
2. **W6 doFetch 空 catch 观察**：`replicated-state.ts` L234 `} catch {`——快照失败（含 WireSnapshotSchemaError）完全静默无日志，pi 侧故障时实例长期保留旧值且无任何诊断痕迹。接线期无行为影响（退避 + 保旧值语义正确，W7 未动原语）。**裁决：无需新 wave，记 ledger 观察项**（W8 接线 usage 后日志可见性价值上升，可在 W8 顺手加——留给主 agent 决策）。
3. **存量 lint warning 3 条不混修**：实测 3 条 = `session-service.ts` L1130/L1149（catch-only-console，blame `0e69039b6d`/`9e3fae6a1e`）+ `index.ts` L115（空 catch，blame `ece9f95c31`）——**全部既有 commit 产物，非 W7 引入**。W7 五文件自身 lint 无新增 warning（测试文件被 ignore pattern 豁免）。**裁决：builder 遵守领地纪律正确，不混修**。

## 7. 观察项（minor，不阻塞）

1. **builder 自报偏差**：markDirty interpreter 命中数自报 11、实测 10（少计 1，方向无害；验收条款 ≥2 不受影响）。
2. **mock 装置 model 形态与真实 pi 不符**：`makeState` 的 `model: { id: 'test-provider/test-model' }` 缺 `provider` 字段（真实 pi Model 对象含 provider）。后果：mock 用例 it 1/it 2 中 modelId 实例播种实际抛 WireSnapshotSchemaError 进入退避（fetch 投影不出 modelId）。两用例只断言 markDirty 触发、不读 modelId 快照值，断言有效性不受影响——但与 §5.2 事实修正后的口径不一致，建议 W8 补 mock `provider` 字段。
3. **过渡期行为特征（规格指定，非 bug）**：index.ts `onSessionRenamed` 改读实例快照后，sessionMetaCache 的 label 更新滞后一个事件周期（事件 N 到达写入快照 N-1 的值；播种未就绪时 fallback 事件 payload）。代码注释已声明此为 D7 固有代价，W9 删本点。

## 8. verifier 过程纪律

- 唯一写入文件 = 本报告；探针脚本（/tmp/w7-probe.ts、/tmp/event-interpreter.ts.bak）均在 /tmp，未入仓。
- 红性验证篡改已字节级还原（sha256 前后一致 + 复测 6/6 绿）。
- 无 git 写操作。
