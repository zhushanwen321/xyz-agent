# data-source-governance 目标达成度对抗审查报告（G1-G4）

> 审计对象：P1-P4 全部 20 wave committed 后的 HEAD（fix-chat-flow-order 分支）。
> 审计基准：`docs/architecture/data-source-governance.md` §1 设计目标 G1-G4 + 关键术语（绝对写规则 / owner / 投影宿主 / 快照拉取+事件失效 / 单一 reducer 双路喂入 / 按字段分权威）。
> 审计方式：不信账本自报，逐条以代码 / 测试 / 登记表实况证据核验；账本「已达成」条目主动找反证。
> 禁区遵守：session-lifecycle restoreSession/forkSession 的 tmp/switchSession 管线、process-manager withEphemeralPi 附着机制本身、restore 后数据丢失衍生现象——均标注「用户领域」未审未碰（P3 gate FAIL 根因，用户单独在修）。

## 结论（先行）

| 目标 | 判定 | 一句话依据 |
|------|------|-----------|
| **G1** 用户体验 | **PARTIAL** | G1a PASS（手动命名不被覆盖三链路闭环）；G1b PASS（重连对账源=ring+实例快照 stateSnapshot，broadcast 兜底腿已删）；G1c PARTIAL（reducer 双路喂入同一份代码成立，但实时**渲染 ref 是 overlay effect 管线而非 reducer 投影**，custom 通知链仍是两份对称代码，ref 层一致性只有探针无断言）。restore 数据丢失属用户领域，不计入。 |
| **G2** 开发者查表 | **PASS** | 抽验 5 条主表条目（#1/#2/#3/#6/#8/#12）「唯一写入口」列与实码全部一致；58 处 R3 豁免计数分类（A14+B30+C10+D4）与登记表 §4⑧ 逐类吻合，抽点实码类别真实。 |
| **G3** 等价性 CI | **PARTIAL** | 两类断言存在且非恒真（本地实测 chaos 3 用例真实 pi 执行全绿）；CI 接线链条真实（vitest include 覆盖 + test script + ci.yml job）；**但 CI 无 pi 凭证/provider 配置，push 后 test-runtime job 预期失败——「CI 可执行」的 CI 半边未闭环（major）**。 |
| **G4** 双层护栏 | **PASS** | R1 pre-commit 生成体实测含检查段 + 注入反证 exit 2 + 恢复文案指向登记表；R2/R3 规则自测 36/36 过且经 eslint.config.mjs 接入 `pnpm lint` 与 pre-commit ESLint 段；语义层准绳三层（登记表+ADR-0062+父文档）+ 8 步 checklist 可操作。 |

**总 GAP 数：7（major 1 / minor 2 / observation 4）**，详见文末问题清单。

---

## G1 用户体验

### G1a 手动命名永不被覆盖 —— PASS

| 检查点 | 证据 | 判定 |
|--------|------|------|
| 活跃 session rename 走 pi RPC | `packages/runtime/src/services/session/session-lifecycle.ts:339-356`：renameSession 活跃分支调 `client.setSessionName(newName)`；client undefined **显式 throw**（:350-352，禁静默 no-op）；RPC 实现 `packages/runtime/src/infra/pi/rpc-client.ts:519-521`（`sendCommand('set_session_name', …, FAST_TIMEOUT_MS)`） | 闭环 |
| 非活跃 session rename 走短命 pi | `session-lifecycle.ts:357-368`：else 分支 `this.pm.withEphemeralPi(target.filePath, (c) => c.setSessionName(newName))`，注释明示「xyz 直写（persistSessionName openSync('a')）已随 W11 删除」 | 闭环（withEphemeralPi 机制本身=用户领域未审） |
| 直写全删 | `grep -rn "persistSessionName" packages/runtime/src --include="*.ts" | grep -v 注释` → 0 代码命中；W11 verifier 两段式 grep 同结论（账本引用，本次抽验 grep 无反证） | 达成 |
| rename-session 扩展防覆盖守卫 | `extensions/rename-session/src/index.ts:67-71`：LLM 返回后重查 `pi.getSessionName()` 非空即 `skip: name exists`。守卫读 pi 内存——活跃 rename 经 RPC 更新 pi 内存、非活跃 rename 经短命 pi 落盘（重开后 pi 从文件读到名字），**两个写入口对守卫全部可见**，竞态窗口结构性闭合 | 闭环 |
| renderer 乐观更新 + 权威回流 | `packages/core/src/domain/session/use-session.ts:287-290`：`api.rename` → `store.applySnapshot(id, { label })`（乐观）；`packages/core/src/domain/chat/useChat.ts:251-259`：`session.renamed` 广播 → `applySnapshot(sid, { label })`（权威回流，空名 guard） | 闭环 |
| 行为级证据 | P1 gate 报告（p1p2-gate-report.md）实测：非活跃改名短命 pi 546ms spawn→RPC→销毁 + tee 日志 ephemeral 文件名 + 目录 diff 唯一写入；场景 1 skip: name exists（账本引用，本次未重跑 UI） | 采信 |

**遗留观察（非阻断）**：非活跃分支 `findScannedSession` 目标不存在时静默返回（`session-lifecycle.ts:365-368` 无 else throw）——与活跃分支 throw 语义不对称，ledger W11 minor 已登记为旧行为（见问题清单 #5）。

### G1b 断连重连对账 —— PASS

| 检查点 | 证据 | 判定 |
|--------|------|------|
| renderer 重连后拉快照的源 | `packages/core/src/transport/use-connection.ts:219-229`：connected 迁移 watch → `resubscribeAll()`；`packages/core/src/coordination/subscription-state.ts:132-216`：订阅 RPC 返回 `{ snapshot（stream 类 ring）, stateSnapshot（state 类 last-value）, lastSeq, gap }`，stateSnapshot 经 replay dispatcher 进入与 live 相同路由管线（:208） | 快照拉取语义，非事件重放 |
| stateSnapshot 数据源=owner 快照（非影子缓存） | `packages/runtime/src/services/session/session-service.ts:1419-1420`（commands「旧 fetchAndBroadcastCommands 已删，播种 fetch 经 fetchCommandsSnapshot 的快照应用后挂钩发布」）、:1031-1046（applyContextUpdate 只做 usage 实例 markDirty，参数 `_inputTokens` 弃用）、:505-512（state_changed「payload 全字段来自实例快照，见 publishStateChangedFromSnapshot」） | W12 切换属实 |
| broadcast 依赖残留 | `session-service.ts:283-286` 注释「broadcast 腿已删，publish 是唯一通道」；grep broadcast 兜底无反证。AGENTS.md 历史「切换 session 后必须主动拉 session.getCommands」人工规则已结构性失效（登记表 #12 例外栏声明），实测切换 session 走 `useChat.ts:193` `subscribeSession(sid)` → stateSnapshot 回放覆盖 | 时序坑消解 |
| 行为级证据 | P2 gate（同 p1p2-gate-report.md）：CDP offline + WS close 真实断连重连，模型/thinkingLevel/用量/队列深度 5s 内与 get_state + get_session_stats 逐字段一致零 toast（账本引用） | 采信 |

**已知计划外既有问题（非本计划引入，ledger 事件节登记）**：断连涉及 turn 的已工作指示不复位 [高]、重连初始化批次 pre-auth 丢弃 [中]——属 transport 层既有链路，建议单开修复计划（同 ledger 结论），不计入本计划 G1 判定。

### G1c 重开一致性（applyEntry reducer 双路喂入）—— PARTIAL

| 检查点 | 证据 | 判定 |
|--------|------|------|
| reducer 本体存在 | `packages/core/src/domain/chat/apply-entry.ts`（27.7KB，9 entry 类型 + custom 双 case :449/:564） | 达成 |
| 重放侧喂入 | `packages/runtime/src/infra/pi/message-converter.ts:29,102`：getHistory 链 `getEntries → liftHistoryToEntries → replayEntries`（core applyEntry）——runtime wire 层调 **core 的** reducer；`packages/core/src/domain/chat/useChat.ts:614-627`：hydrate 直接消费 reducer 产物不二次转换 | 同一份派生代码 |
| 实时侧喂入 | `packages/core/src/domain/chat/store.ts:425-437`：`applyEntryFrame` 喂同一 core `applyEntry`；`packages/core/src/domain/chat/effects/registry.ts:414-420`：`message.message_end` effect 从 payload 取重构 entry 喂 `applyEntryFrame`；实时 entry 重构在生产 event-adapter（`live-reload.test.ts:44-55` 用生产 `translate()` 复现） | 同一份派生代码 |
| 等价性断言 | `packages/runtime/src/__tests__/equivalence/live-reload.test.ts:82-138`：真实 pi turn 后 `replayEntries(liveEntries)` vs `replayEntries(get_entries 剥 id)` 逐字段 deep equal（messages/clientUuidMap/orphanToolResults/lastAssistantWithToolCalls）+ 非空守卫 + 工具链路覆盖（toolCalls output 含探针串）；混沌三态断言真实（乱序产孤儿 :238、丢失变短 :246、重复多一条 :252） | 非恒真，实测绿 |
| **反证：渲染 ref 不是 reducer 投影** | `store.ts:428-431` 自述：「本 wave 语义：纯累积（权威镜像），**不直接投影 messages ref**——实时渲染走 overlay 路径…ref 与 reducer state 的收敛（对账投影）归 W22」；实时 messages ref 由 effect 管线构建：`registry.ts` 内 16 处 `commitMessages` 调用（`message.customStart` :448-481 独立构造 system 消息、`message.complete` :170-206 终态收口等） | **设计承诺「renderer 消息列表是 entry 日志的纯函数」在渲染层未达成** |
| **反证：custom 通知双管线** | 实时侧 `registry.ts:448-481`（cm-uuid id、Date.now() timestamp、display 覆写）与重放侧 `apply-entry.ts:446-460,546-556`（custom case、display 覆写）是**两份对称代码**（`registry.ts:462` 注释自认「与重开路径 mapper 覆写对称」）——对称性靠注释纪律维持，非同一份代码 | 抽查 grep 证实独立解析分支残留 |
| ref 收敛对账 | `broadcast-getstate.test.ts:388-403`：渲染 ref vs reducer state 只 `console.log` 探针指标，**「只记录指标不做判等断言」**（文件头 :13-15 明示 W21 裁决遗留态） | UI 渲染层回归防线缺位（问题清单 #2） |

**定性**：D5 承诺的「单一 reducer 双路喂入」在 **entry 级派生**成立（两路确实共用 core applyEntry，等价性测试断言 reducer 产物）；但「live ≡ reload 从构造上成立」只对 reducer state 成立——用户实际看到的 messages ref 在实时是 overlay effect 管线（第二派生），其与重开的一致靠 W22 探针（无断言）而非构造。属「已裁决的设计偏差」（W21 verifier 定案 + W22 验收记录在案），非未察觉的实现偷懒，但对照 G1 字面目标判 PARTIAL。

**restore 路径数据丢失**（P3 gate FAIL 根因）：用户领域，未审未碰。fork 路径同形态受累（账本事件节 ③）同属用户领域。

---

## G2 开发者查表 —— PASS

### 5 条主表条目「唯一写入口」列 vs 实码

| 条目 | 登记表声明 | 实码核验 | 判定 |
|------|-----------|---------|------|
| #1 label | 活跃 = pi set_session_name RPC（W1）；非活跃 = withEphemeralPi（W11）；目标 = ReplicatedState 实例（W7）+ applySnapshot（W13）；sessionMetaCache 删（W9） | `rpc-client.ts:519` ✓；`session-lifecycle.ts:353/367` ✓；`replicated-states.config.ts:129 createLabelStateConfig` ✓；`event-interpreter.ts:91-97` labelState markDirty 注入 ✓；`services/session/session-meta-cache.ts` 不存在（`ls` 核实）✓ | 一致 |
| #2 列表 + W15 占位守卫 | 扫描占位 `modelId:''`/`tokenCount:0` 不覆盖真值（W15 落 applySnapshot 合并策略） | `packages/core/src/domain/session/store.ts:103-118 mergeViewSnapshot`：`isScan` 分流 + `:111/:115` 占位守卫，owner 空值不拦（TC-4b 语义） | 一致 |
| #3 usage 五写点收编（W10） | inputTokens 唯一数据源 = usage 实例快照；setInputTokens/applyContextUpdate 直写已删 | `session-service.ts:1027`（`replicatedStates.get(sessionId)?.usage.get()?.inputTokens`）、:1234（tokenCount 读实例）、:1046（`applyContextUpdate(sessionId, _inputTokens, _totalTokens?)` 参数弃用只做失效）、:1406-1409（新建 session 恒 0 基线）；`grep setInputTokens` = 0 命中 | 一致 |
| #6 queue 计数 FIFO（W14） | drainN 按条数取；queue_update=对账信号；深度=pendingMessageCount | `store.ts` drainN（`:400` 附近 reconcile/slice 保头）✓；`registry.ts:564-580`：countDrained 差集 length → drainN + 帧内 pendingMessageCount 深度对账 ✓；`abortPending` 保留文本匹配带 [W14 D6 差异标注]（`store.ts:404-410`） | 一致 |
| #8 subagent 单源（W18） | 唯一源 = entry 扫描（scanSubagentEntries，实时 get_entries 增量与冷启动磁盘全量同一份代码）；RecordEntriesCache owner | `subagent-extractor.ts:4,118,187,199,206`（「唯一派生」「与实时增量拉取同一份派生代码」）；`session-service.ts:148,152`（「数据写路径唯一 = refreshRecordEntries 的 entry 扫描」+ RecordEntriesCache 接口）；`event-adapter.ts:835-877`（entry_appended 移出 NULL_EVENTS + DISPATCHER 注册） | 一致 |
| #12 commands 三源收敛（W8/W12） | 旧 fetchAndBroadcastCommands 删，播种 fetch 挂钩发布；stateSnapshot last-value = owner 快照 | `session-service.ts:1419-1420` 注释 + `replicated-states.config.ts:194-202`（commands 实例配置） | 一致 |

### 58 处 R3 豁免抽验

实测 `grep -rn "taste:allow-no-data-owner" packages/renderer/src packages/core/src` = **58 处**，按类别计数：**EX-A 14 / EX-B 30 / EX-C 10 / EX-D 4**——与登记表 §4⑧ 声明（14+30+10+4=58）**精确一致**。抽 6 处实码核类别真实性：

| 位置 | 声明类别 | 实况 | 判定 |
|------|---------|------|------|
| `packages/core/src/transport/ws-client.ts:55` | EX-B WS 连接状态单例 | 确为连接态单例 ref（4 态状态机） | 真实 |
| `packages/renderer/src/composables/useExtensionUI.ts:47` | EX-A handler 注册表 | 确为事件 bus 注册表（非 GUI 数据） | 真实 |
| `packages/renderer/src/composables/features/terminal/useTerminal.ts:124,128,135` | EX-A sid 分区表 | 确为 ADR-0049 全局 sid 协调器形态 | 真实 |
| i18n loadedLocales（EX-C 特注） | 「字面量初始化后仍被 add() 变异，归 S1 兜底」 | 标记注释内嵌同一特注原文，与登记表 §4⑧ verifier W24 minor 3 一致 | 真实 |
| `api/mock/index.ts` 4 处 | EX-D VITE_MOCK 测试基建 | 确为 mock 桩 | 真实 |
| 3 处 `@data-owner` 正向注解 | useSessionDerivations #11+#7、useChat #7 | `grep @data-owner`（排除 allow）恰 3 处且指向主表编号 | 一致 |

**观察（非阻断）**：主表 owner 列采用「现状 → 目标（W 编号）」演进式表述，其中「现状」段（如 #1 的「renderer store 三路写」）描述的是改造前状态——按行阅读当前实况时需理解 `→` 语义（问题清单 #7）。

---

## G3 等价性 CI —— PARTIAL

| 检查点 | 证据 | 判定 |
|--------|------|------|
| 测试族存在 | `packages/runtime/src/__tests__/equivalence/` 10 文件：live-reload / broadcast-getstate / chaos / pi-protocol-contract / pi-fixture / scalar-state-invalidation / usage-queue-commands-invalidation / w10-usage-switchmodel-race / w12-owner-snapshot-publish / w18-record-entry-chaos | 齐备 |
| CI 接线链条 | `packages/runtime/vitest.config.ts` include `src/**/*.test.ts` 覆盖 equivalence；`packages/runtime/package.json:11` `"test": "vitest run"`（+:12 `test:equivalence` 别名）；`.github/workflows/ci.yml:136` test-runtime job `pnpm --filter @xyz-agent/runtime run test` | 链条闭合 |
| live≡reload 断言非恒真 | `live-reload.test.ts:92-138` 审读：真实 pi spawn + 真实 LLM turn；`expect(liveState.messages).toEqual(reloadState.messages)` 逐字段 + 非空守卫（:110 `liveEntries.length ≥ 2` 防 0==0）+ 工具链路探针串断言（:129 toolCalls output 含 probe-w21） | 非恒真 |
| broadcast≡get_state 断言非恒真 | `broadcast-getstate.test.ts:97-310` 审读：六实例（W7/W8 生产配置函数）+ 生产 MessageBus；事件风暴（2 轮 prompt + followUp + set_model）后实例快照与 stateSnapshot 广播 **vs 独立第二次权威三 RPC 拉取**逐字段（:257-303）；风暴后队列清零守卫（:276） | 非恒真 |
| 本地实测 | `cd packages/runtime && pnpm exec vitest run src/__tests__/equivalence/chaos.test.ts` → **3 passed（6.6s，真实 pi 子进程 + 真实 LLM 语料）**，stderr 可见乱序注入的孤儿收集脏化信号（断言真在咬合） | 绿 |
| **CI 环境可运行性（反证）** | ci.yml test-runtime job 全步骤 = checkout + pnpm/node setup + `pnpm install` + test，**无任何 pi 凭证/provider 配置注入**（无 secrets、无 ~/.pi 布置）；fixture 默认模型 `xiaomi-token-plan-cn/mimo-v2.5-pro`（`pi-fixture.ts:33`）依赖本机 `~/.pi/agent/`（models.json provider 配置 + auth.json 凭证，本地核实存在，CI 不存在）→ CI 上 prompt 将因 provider/key 缺失失败或 120s 超时 → **push 后 test-runtime job 预期红**。当前未爆只因分支未 push（gh run list 最近 CI = 2026-08-18 main，早于本计划 commit）。pi binary 本身 CI 可达（root package.json:32 依赖 + node_modules/.bin/pi 符号链接 + pnpm run PATH 注入，本地同机制实测佐证）——缺的是凭证不是 binary | **major GAP（#1）** |
| ref 收敛断言 | `broadcast-getstate.test.ts:388-403`：console.log 探针 + 仅「ref ≥ 2 条」弱守卫，无 ref vs reducer 判等（文件头 :13-15 声明 W21 裁决遗留态） | minor GAP（#2） |

---

## G4 双层护栏 —— PASS

| 检查点 | 证据 | 判定 |
|--------|------|------|
| R1 pre-commit 真实生效路径 | `.githooks/install-hooks.sh:625-650`：heredoc 段 `[R1 pi session 直写检查]`（exit 2 即拦 + 报错指向 data-source-registry.md）；**生成体实测**：`grep -n check_pi_direct_write "$(git rev-parse --git-common-dir)/hooks/pre-commit"` → :579 命中（hooks 已安装）；`python3 .githooks/check_pi_direct_write.py` → exit 0（239 文件，allowlist 空「W11 已清空」） | 接线真实 |
| R1 拦截反证 | 注入探针（runtime src 内 `appendFileSync(getSessionsDir()+"/x.jsonl")`）→ **exit 2**，报错含文件:行号 + 恢复动作（「改经 pi RPC 或扩展 appendEntry；若为登记例外，先在 data-source-registry.md 补条目 + ALLOWLIST 登记」）；删除探针后 exit 0 | 拦截有效 |
| R2/R3 taste-lint | `taste-lint/rules/no-non-owner-store-mutation.mjs` + `require-data-owner-annotation.mjs`（各带 .test.mjs）；`taste-lint/base.mjs:49-50` 注册 + :98-99 error 级；`eslint.config.mjs:1-4` spread `taste-lint/vue.mjs`（其内 spread baseConfig）→ `pnpm run lint`（package.json:13 `eslint .`）全仓生效；pre-commit ESLint 段（install-hooks.sh:106）覆盖 staged 文件 | 链条闭合 |
| R2/R3 规则自测 | `node --test` 两个规则测试文件 → **36 pass / 0 fail** | 绿 |
| 语义层准绳 | `.agents/skills/pr-cr-fix/agents/review-data-governance.md:8`：准绳 = 登记表 SSOT + ADR-0062 + 父文档三层；checklist 8 步（直写追形参 / 第二写者对照登记表 / 事件只做失效 / renderer 零派生 / @data-owner 校验 / 扩展通道 / 登记表同步），每步含 MUST_FIX 触发条件 | 指向登记表且可操作 |
| 行为级证据 | P4 gate（p4-prevention-gate-report.md）：三形态全拦（W24 调用图形态 error + R1 exit 2 + 语义级 MUST_FIX x2 引用登记表 #1 + ADR-0062）（账本引用） | 采信 |

**观察**：各 checker 段带 `SKIP_ALL_CHECKS=1` 逃生通道（install-hooks.sh:626 等）——规范明文允许（仅线上热修复 + commit message 说明），提示存在非违规。

---

## 附加：架构承诺抽查

| 承诺 | 证据 | 判定 |
|------|------|------|
| renderer 零派生（stores 唯一写入口 applySnapshot） | 列表展示字段（label/status/modelId/thinkingLevel/tokenCount）唯一入口达成：`store.ts:74-87` applySnapshot + mergeViewSnapshot 按字段白名单；三旧入口（updateLabel/updateSessionState/setGroups）grep = 0。**反证**：`store.ts:143-152` `markDead`/`revive` 直写 `target.status`（status 是 applySnapshot 托管字段的旁路写；调用方 `useMessageEffects.ts:37` / `useSidebarNew.ts:256`）；`appendSession`/`updateProjectId`/`removeFromList` 为条目生命周期/独立字段操作（projectId 不在托管白名单内，可辩护）。renderer 内 normalize* 残留均为 UI 工具（normalizeContent 取文本长度、normalizeOptions dialog 形状归一），非数据源派生 | PARTIAL（问题清单 #3） |
| runtime 唯一投影宿主 | 派生的合法落点 = runtime 或 core 唯一实现（D7 原文）：applyEntry reducer 在 core 唯一实现 ✓，runtime wire 层（message-converter）引用同一实现 ✓，六实例在 runtime ✓。**反证**：messages ref 的 overlay effect 管线（core store/effects，16 处 commitMessages）是与 reducer 并立的第二派生——同 G1c 发现，一处计损 | PARTIAL（并入 G1c/#2） |

---

## 问题清单

| # | 级别 | 描述 | 证据 | 建议修复方向 |
|---|------|------|------|-------------|
| 1 | **major** | 等价性测试族 CI 半边未闭环：真实 pi + LLM turn 用例需要 provider 配置与凭证（`~/.pi/agent/models.json` + `auth.json`），ci.yml test-runtime job 无任何注入；分支一旦 push，`vitest run` 将执行（pi binary 经 pnpm PATH 可达）但 turn 失败/超时 → job 预期红。「长期回归基线」实际只在本机成立 | `ci.yml:115-143`（job 全步骤无 secrets）；`pi-fixture.ts:33` DEFAULT_MODEL 自定义 provider；本地 `~/.pi/agent/{models.json,auth.json}` 存在而 CI 无；分支未 push 故 gh run 无本计划记录 | 三选一：a) CI 注入测试专用 provider 凭证（secrets → 布置 HOME）；b) fixture 增加凭证探测（detectAuth 失败 → skipIf 扩展），CI 上 skip + 显式声明「等价性基线跑在开发机/pre-merge 本地」，把该声明落 ADR-0062 或 TEST-STRATEGY；c) 独立 scheduled/manual workflow（带凭证 runner）专跑 `test:equivalence` |
| 2 | minor | 「实时渲染 ref ≡ 重开视图」无 CI 断言：W22 it2 的 ref 收敛只 console.log 探针（`ref=N 条 vs reducer=N 条`），无判等；渲染 ref 走 overlay effect 管线（16 处 commitMessages 直写）而非 reducer 投影——G3 字面「实时视图 ≡ 重开视图成为 CI 可执行测试」在 UI 渲染层缺位（reducer 层有） | `broadcast-getstate.test.ts:388-403`（探针 + 弱守卫 `refMsgs.length ≥ 2`）；`store.ts:428-431`（「不直接投影 messages ref…归 W22」）；W21 verifier 定案 + W22 验收记录 | 近期：探针升级为条数 + role 序判等断言（id 形态异源已裁决可避开）；长期：落「收敛投影」（ref 由 reducer state 派生），消掉 overlay 第二管线 |
| 3 | minor | core session store `markDead`/`revive` 直写 status，绕过 applySnapshot 单入口——D7「renderer stores 唯一写入口 applySnapshot」在 status 字段有旁路（存量，W13 收敛口径只含三入口，R2 WATCHED_MUTATIONS 单键不覆盖它们） | `packages/core/src/domain/session/store.ts:143-152`；调用方 `useMessageEffects.ts:37`、`useSidebarNew.ts:256` | markDead/revive 改薄壳 `applySnapshot(id, { status: 'dead'/'idle' })`；或登记表 #2 补「进程死活本地标记旁路」例外条目（先登记再保留） |
| 4 | observation | custom 通知消息（pi CustomMessage）实时与重开是两份对称代码：实时 `registry.ts:448-481` 独立构造（cm-uuid/Date.now/display 覆写），重开 `apply-entry.ts:446-460,546-556` custom case——对称性靠注释维持；reducer 双路喂入达成于 message/toolResult 主链，custom 链是双管线残留 | 两处代码对照；`registry.ts:462` 注释自认「与重开路径 mapper 覆写对称」 | 后续 wave 把 customStart effect 改为喂 applyEntryFrame（custom entry）或由 reducer 投影，消掉两份代码 |
| 5 | observation | renameSession 非活跃分支 findScannedSession 目标不存在时静默返回（无 else throw）——与活跃分支「client undefined 即 throw」不对称；用户感知为改名词无反馈（ledger W11 minor 4 已登记，旧行为） | `session-lifecycle.ts:365-368` | 补 else throw 或 toast「session 不存在」 |
| 6 | observation | pre-commit 各 checker 段（含 R1）带 `SKIP_ALL_CHECKS=1` 逃生通道——规范允许（线上热修复 + commit message 说明），护栏强度依赖流程纪律而非机器强制 | `install-hooks.sh:626` 等 | 无需动作；若要收紧可对 R1 段单独去掉 skip 通道（登记表 §5 规约 2 已声明 R1 无条件化） |
| 7 | observation | 登记表主表 owner 列「现状 → 目标」演进式表述中，「现状」段（如 #1「renderer store 三路写」）与当前实况不符（三入口已删）——按行读当前实况需理解 `→` 语义，新读者可能误判现状 | `data-source-registry.md` §1 #1 owner 列 | P1 后表头声明已写「W6-W8 同步维护」；可加一行「"现状"段为 W 前基线快照，实况以"目标"列 + 代码为准」消除歧义 |

## 审计方法与边界声明

- 账本「已达成」条目的反证搜索路径：G1a 直写 grep / G1b broadcast 兜底 grep / G1c 独立解析分支 grep（找到 2 处：overlay 管线 + custom 双管线）/ G2 豁免计数全量分类 / G3 CI 凭证链（找到 1 处 major）/ G4 生成体 + 反证注入。
- 实测命令均在本仓工作区执行；探针文件（tmp-r1-probe.ts）用后已删（复跑 R1 exit 0 核实）。
- 未重跑项：UI 行为级场景（场景 1/2/3 的 pnpm dev 实测）采信 gate 报告 + 账本交叉引用；P3 gate restore 数据丢失为用户领域，全程未审未碰。
- git 状态：零写操作（本报告为唯一新增文件，位于 .xyz-harness/ 审计产物目录）。
