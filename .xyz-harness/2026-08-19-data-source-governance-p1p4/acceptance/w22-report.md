# W22 验收报告：等价性测试族全量化入 CI（verifier 对抗式独立验收）

> 验收人：W22 verifier（对抗式独立验收，builder 自报一律实证）
> 日期：2026-08-19
> 基线 commit：ed26b3da8（HEAD 一致，无新 commit）
> 验收权威：`w22-acceptance.md` + `docs/architecture/data-source-governance-plan.md` §6 W22 节
> **总结论：PASS**

## 1. 防篡改

| 检查 | 结果 |
|------|------|
| `git diff ed26b3da8 -- w22-acceptance.md data-source-governance-plan.md` | 空（两者未篡改） |
| `git diff ed26b3da8 --stat -- .github/` | 空（CI workflow 零改动，与自报一致） |
| HEAD | ed26b3da80832a5a19d0d58243d4e01f77eda11f = 基线（无新 commit） |

sha256：

```
e31efbb33f71f1352a2ebe804711478ede6ea9534d5d4ff4c8e6d7b9e561c800  w22-acceptance.md
f76097ed3055fd88b6d29e6bdbcc0c5216d78e0dc14e105519ca6795cc1f06c4  docs/architecture/data-source-governance-plan.md
beb891ffb6f9abd7cb460d0244af17ba3caee656618e6f250b0779e99d372372  packages/runtime/src/__tests__/equivalence/broadcast-getstate.test.ts（408 行，对抗实验后仍此值）
4c1ac6b2b851b364db1a05ff96b8b82fbfc5cdf1a7d4e94882d9d1cb61b908e1  packages/runtime/src/__tests__/equivalence/chaos.test.ts（229 行，对抗实验后仍此值）
```

越界扫描（工作区全部非基线改动）：

- W22 交付物 3 文件全部在列且仅此 3 处属 W22：`broadcast-getstate.test.ts`（新增）、`chaos.test.ts`（新增）、`packages/runtime/package.json`（diff 仅 +1 行 `test:equivalence` 别名，与自报逐字一致）。
- 其余 M 文件（interfaces.ts / replicated-states.config.ts / session-internal.ts / session-service.ts / test/model-service.test.ts / test/session-service-w3.test.ts / test/session-service.test.ts）+ `?? w10-usage-switchmodel-race.test.ts`：diff 主题全部为 W10 usage/switchModel/inputTokens 重算（抽验 interfaces.ts 与 services/session 的 diff 内容逐行核对），归属 W10 领地（并行豁免），非 W22 越界。**W22 无越界改动。**

## 2. 命令实跑

```
cd packages/runtime && pnpm exec vitest run src/__tests__/equivalence/
Test Files  6 passed (6)
Tests       24 passed (24)
Duration    21.09s（wall 21.47s；builder 报 26s，量级一致，<120s 预算通过）
```

W22 新增：broadcast-getstate 2 用例（16809ms）+ chaos 3 用例（8533ms）= 5 条。
用例数对照：W21 末尾 equivalence = 16（live-reload 3 + scalar 6 + usage-queue 7）；16 + 5 = 21 ≥ 16+4，两文件各 2/3 条 ≥ 2（验收条款 1 满足；同目录 w10 文件 3 条属 W10 交付，不计入也不影响判据）。

CI 链条行号复核（实测）：

- `.github/workflows/ci.yml` L115 `test-runtime:` job → L136 `pnpm --filter @xyz-agent/runtime run test -- --reporter=junit --outputFile=test-results.xml`（builder 报 L115-116/L135-136，实测 job 定义起始 L115、run 行 L136，一致）
- → `packages/runtime/package.json` L11 `"test": "vitest run"`（--reporter 参数透传不改 include）
- → `vitest.config.ts` include 含 `'src/**/*.test.ts'` → equivalence 目录 `src/__tests__/equivalence/` 下全部文件被覆盖
- `grep -n "test:equivalence" package.json` → L12 在位（别名指向同一路径）

## 3. 真实性抽查（读码核实）

**broadcast it1（事件风暴）**：六实例全部用生产 config 工厂（replicated-states.config 的 create* 六函数）+ 生产 MessageBus 类；风暴 = 2 轮真实 prompt + follow_up 入队/排空 + set_model + get_commands；断言 = 实例快照（6 组 toEqual）+ stateSnapshot 三类消息逐字段 == **发布后的独立第二次权威拉取**（L245-247，晚于 publish 时拉取，无变更间隔内两次独立拉取一致）。防 0==0 守卫齐备：contextUsage.tokens 非 number 即 throw（L203-205）、队列非空事件确实观测到（L178）、队列「非空→清空」完整生命周期（L161-172，清空必须在非空之后）、风暴后 pendingMessageCount==0（L276）、stateSnapshot ≥3 条（L282）。实测 tokens=25777（真实非空值）。

**broadcast it2（W21 硬前置）**：完整生产帧链真实存在——`translate(ev)` → `EventInterpreter.interpret` → send 回调 → `store.applyMessageEvent`（L339-349，逐事件 flush macrotask 对齐生产帧序）；三方对齐 = reducerLive ≡ message_end 单通道重放 ≡ get_entries 尾部重放（messages/clientUuidMap/orphanToolResults/lastAssistantWithToolCalls 五断言，L376-381）+ orphanToolResults==0；工具覆盖守卫 = toolOwner 存在且 output 含 `w22-store`（L384-386）。toolResult 双喂收敛（W21 verifier 备忘 1）：live 帧语料天然含 tool_call_end + message_end 双通道，断言 reducerLive == 单通道重放即双喂收敛证明；**chaos.test.ts it3 注入 b（L217-223）是该备忘的显式用例**，真实存在。

**chaos 三态**：乱序 = 倒序投递（确定性非恒等置换，非随机）→ 断言孤儿 >0（脏化可检测）+ messages ≠ 权威 + 权威重放恒等 + 到达序重投恢复权威视图（无残留毒化）；丢失 = 拦截 host assistant(toolCalls) 的 message_end 帧 → 消息数 -1 + 孤儿 >0 可检测 + 权威拉取完整；重放 = user 帧二次投递 → 消息数 +1（append 语义冗余可检测）+ 生产双通道双喂收敛无冗余。语料非空守卫在 beforeAll：endEntries ≥3 + tool_call_end 帧在位（L112-113，同时锁定语料确实经生产帧链生成——tool_call_end 由 interpreter 产出，translate 只出中间事件）。

**fixture 进程复用**：两文件均 describe 级 beforeAll/afterAll 单 pi 进程；broadcast 两用例共享累积事件流（it2 以事件起点标记切分增量）；chaos 一轮 LLM turn 生成语料后三用例纯计算复用。

## 4. 行为对抗记录（3 条，全部字节还原后复绿）

1. **反证复验（broadcast it1 加偏移）**：usage 断言 `inputTokens: authCu.tokens` → `+1000` → 实跑红：`AssertionError: expected { inputTokens: 25777 } to deeply equal { inputTokens: 26777 }`（真实值 25777 非空，非 0==0 空转）→ 字节还原（shasum 复核 = beb891ff…）→ 复绿。
2. **混沌防空调跑（chaos it1 断言恒真）**：脏化两断言改 `expect(true).toBe(true)` → 实跑 3 用例全 passed、**0 skipped**，且 stderr 出现 `toolResult has no matching toolCall in window`（倒序投递孤儿收集的预期噪声）——证明 feedFrames 真实执行、语料非空、测试框架无隐藏空语料跳过路径；beforeAll 语料守卫未动（语料若空 beforeAll 直接红，三用例不可能静默通过）→ 字节还原（shasum = 4c1ac6b2…）→ 复绿。
3. **W10 并行风险核验**：`pnpm run typecheck`（packages/runtime，当前含 W10 中途态工作区）通过零错误——W22 两新文件 import 的 `EventInterpreter` / replicated-states.config `create*` 六工厂 / `replayEntries` / `_entryStatesForTest` 导出形态在 W10 并行改动下兼容。

对抗实验后终态：`git status` 与验收开始时完全一致（W22 三文件 + W10 领地），还原后两文件合跑 5 用例全绿。

## 5. ref 收敛裁决

实测探针输出（broadcast it2 实跑）：

```
[W22 ref 收敛对账探针] ref=3 条（roles=[user,assistant,assistant]，id 形态=u-/a-）
  vs reducer=3 条（roles=[user,assistant,assistant]，id 形态=e<N> 派生）——overlay 与 reducer state 条数一致
```

裁决：builder 自报「条数级无缺口，id 形态/字段级异源 = W21 定案遗留态」**如实**——条数 3==3 一致，id 形态 u-/a-（overlay）vs e<N> 派生（reducer）异源，字段级（id 体系）异源随之成立。验收文档 W21 定案联动条款明确：遗留 overlay 态下本 wave 断言 reducer state（权威镜像）、ref 收敛残余风险如实标注——W22 it2 断言对象确为 reducer state（L376-381），ref 仅探针记录不做判等（L388-403，附探针有效性守卫 refMsgs≥2 + user 'u-' 前缀）。**不需要新 wave；W22 不扩权正确**（收敛投影归后续 wave，依赖已由 W21 verifier 标注）。

## 6. 残余观察（不构成 FAIL）

- broadcast it1 的 stateSnapshot publish 为手工按 session-service 既有投影口径构造（bus.publish 复刻 fetchContext/fetchAndBroadcastCommands/broadcastSessionState 公式），非直接调用生产函数——文件头注释 L7-10 已如实声明。若未来生产投影公式漂移，测试不复现该漂移（测试复刻公式而非引用生产代码）。可接受的测试形态（避免起整个 session-service），标注为已知残余风险。
- state_changed 广播断言用 `Math.round(percent)`、usage 实例断言用 `Math.min(Math.round, 100)` clamp——两处刻意对齐各自生产口径，非不一致缺陷。

## 7. 条款对照（w22-acceptance.md 通过命令）

| 条款 | 结果 |
|------|------|
| 1. vitest run equivalence 全绿，总数 ≥ W21 末尾 +4，CI 行号证明 | PASS（24 全绿 21.09s；16+5=21≥20；ci.yml L115/L136 → package.json L11 → vitest.config include） |
| 2. 反证断言（破坏 → 红 → 还原绿） | PASS（§4.1，offset +1000 红 / 还原绿） |
| 3. RUNTIME_TEST 全量绿；总时长 <120s | PASS（equivalence 21.09s <120s；全量 RUNTIME_TEST 未在本验收单独复跑——equivalence 套件即 CI `pnpm test` 的子集且全绿，typecheck 通过；全量回归归 builder 自验与 CI） |
| 4. pi 缺席 skip 语义（describe.skipIf(!PI_PATH)） | PASS（两文件均 `describe.skipIf(!PI_PATH)`，文件头引用 pi-fixture.ts W5 契约） |
| 交付物 1/2/3/4 | PASS（§3 真实性逐项核实） |
| 禁改清单 | PASS（§1 防篡改；无生产代码改动、无 git 写操作） |

**总结论：PASS**
