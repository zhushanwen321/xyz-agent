# W20 验收报告：applyEntry reducer 本体 + 文件重放喂入

> verifier 对抗式独立验收。验收权威：w20-acceptance.md + plan §5 W20 节（L618-642）。
> 验收时点：2026-08-19（与 W7 builder 并行，见 §1.3 归因记录）。
> **总结论：PASS**（2 条 minor 观察，无 must-fix）。

## 1. 防篡改与越界扫描

### 1.1 验收权威文档 sha256（工作区 vs 基线 commit 763d76e40，逐一比对）

| 文档 | 工作区 sha256 | 基线 763d76e40 sha256 | git diff |
|------|--------------|----------------------|----------|
| .xyz-harness/2026-08-19-data-source-governance-p1p4/acceptance/w20-acceptance.md | 490428f8449b12a140ade64607e5e428d4fcbe510e14c6cbf235a10a67f454c0 | 同左 | 空 |
| docs/architecture/data-source-governance-plan.md | f76097ed3055fd88b6d29e6bdbcc0c5216d78e0dc14e105519ca6795cc1f06c4 | 同左 | 空 |

`git diff 763d76e40 -- <两文件>` 输出均为空，sha256 逐字节一致。**防篡改通过**。

### 1.2 越界扫描（git status -uall）

W20 六文件（builder 自报与实际一致）：

- packages/core/src/domain/chat/apply-entry.ts [新增，675 行]
- packages/core/src/domain/chat/__tests__/apply-entry.test.ts [新增，21 用例]
- packages/core/src/domain/chat/__tests__/apply-entry-equivalence.test.ts [新增，13 用例]
- packages/runtime/src/infra/pi/message-converter.ts [M]
- packages/core/src/domain/chat/useChat.ts [M，纯注释 2 处]
- packages/core/src/domain/chat/index.ts [M，导出]

工作区其余改动全部落在豁免领地：

- W16：extensions/subagent-workflow/src/execution/（5 M + 1 ??record-entry.ts）
- W7（验收期间动态出现）：packages/runtime/src/services/session/session-service.ts（+93 行，全为 ReplicatedState label/thinkingLevel/modelId）、event-interpreter.ts、replicated-states.config.ts [??]、packages/runtime/src/index.ts
- ledger：docs/architecture/data-source-registry.md（diff 仅 #8 行追加 W16 探针实测数据）

**越界扫描通过**：无 W20 六文件之外的非豁免改动；event-adapter.ts / equivalence/live-reload.test.ts 未被触碰（禁改清单合规）。

### 1.3 W7 并行瞬时态归因（verifier 如实记录）

验收期间 W7 builder 持续写入其领地，观察到两次瞬时态：

1. runtime `pnpm typecheck` 首跑红：`session-service.ts(1235,10): TS2551 'registerReplicatedStates' does not exist`——tsc 全量仅此一处错误（W20 文件零错误）。数分钟后复跑 exit 0（W7 补全方法体）。
2. runtime `pnpm test` 一次中间态 1 failed（269 files，W7 新增测试文件写入中），紧邻复跑 **269 files / 3124 passed 全绿**。

两次均归属 W7 半成品，非 W20 交付缺陷。W20 相关测试单独运行全绿（见 §2）。

## 2. 命令实跑

| 命令 | 结果 |
|------|------|
| `test -f packages/core/src/domain/chat/apply-entry.ts` | FILE EXISTS |
| `grep -c "case '" packages/core/src/domain/chat/apply-entry.ts` | **13** |
| `cd packages/core && pnpm typecheck` | exit 0 |
| `cd packages/core && pnpm test` | `Test Files 76 passed (76)` / `Tests 980 passed \| 6 todo (986)` |
| `cd packages/runtime && pnpm typecheck` | exit 0（首跑 W7 瞬时红，见 §1.3） |
| `cd packages/runtime && pnpm test` | `Test Files 269 passed (269)` / `Tests 3124 passed (3124)`（最终态；builder 自报时点 3118，差额 6 = W7 验收期间新增用例） |
| `cd packages/runtime && pnpm build` | `Build success in 104ms` + `Runtime bundle validated ✓`（index.cjs 2429KB） |

相对路径 import 内联验证：产物 `apps/electron/dist/runtime/index.cjs` L51298 出现 bundle 注释 `// ../core/src/domain/chat/apply-entry.ts`，`applyEntry|replayEntries` 命中 4 处、`xyz.client-msg-id` 常量命中 7 处——reducer 已编译内联，无外部 require core 路径，vue 未渗入 runtime bundle。

## 3. 真实性抽查

### 3.1 pi entry 类型覆盖核对（对照 pi 源码）

pi 源码 `~/Code/git-fork/pi-mono-workspace/main/packages/coding-agent/src/core/session-manager.ts` L140-149 `SessionEntry` union **共 9 类型**：

| pi entry type | reducer 处置 | 用例 |
|---------------|-------------|------|
| message | case 'message'（内层 7 role 细分） | 10 条 |
| compaction | case 'compaction' → system+compactionSummary | 1 条 |
| branch_summary | case 'branch_summary' | 1 条 |
| custom | case 'custom'（xyz.client-msg-id → clientUuidMap） | 3 条 |
| custom_message | case 'custom_message'（display 覆写） | 2 条 |
| label | case 'label' 显式 no-op（断言同引用） | 1 条 |
| thinking_level_change | default no-op（注释声明未建模） | 1 条（合并） |
| model_change | default no-op | 同上 |
| session_info | default no-op | 同上（另加 future_unknown_type 探针） |

message entry 的 role 细分对照 pi `agent/src/types.ts` L314（AgentMessage = pi-ai Message ∪ CustomAgentMessages）+ `coding-agent/src/core/messages.ts` L67-73 declaration merging：user/assistant/toolResult（pi-ai types.ts L378/384/399）+ bashExecution/custom/branchSummary/compactionSummary（coding-agent 扩展）= **7 role，reducer 内层 switch 恰好 7 case + default warn**。无遗漏、无编造。

`grep -c "case '"` = 13 的构成：外层 6 类型 case + message 内层 7 role case，计数吻合。

### 3.2 等价性防线用例语义（13 用例，抽 4 条读断言细节）

文件头 L14-17 如实声明「位置归一」：迁移前实现用 crypto.randomUUID 生成 msg.id/thinking id（不可复现），deep equal 前把两侧 msg.id、thinking[].id 及对应 contentBlocks.refId 按位置重写占位符（`#msg`/`#th<N>`），**其余字段含 toolCalls[].id（part.id 透传）与全部业务字段逐字比较**——归一范围最小化，声明属实。核心断言（L55-62）：`expect(normalizeVolatile(next)).toEqual(normalizeVolatile(legacy))` + `expect(orphansNew).toEqual(orphansLegacy)`，均为生产文件导出的新旧双实现真实对比。

抽查断言：

1. **write/edit 静态解析等价**（用例 10）：fixture 含 tool_use 别名 + write_file + str_replace + read（非文件工具），断言新旧路径 fileChanges（path/file_path 取参、modified 归一、去重）+ usage 逐字等价。
2. **bashExecution**（用例 8）：exitCode undefined → null、excludeFromContext 缺失归一、与 user 消息混合的完整映射等价。
3. **toolResult 合并 + isError**（用例 2）：跨窗口 toolCallId 配对回填、isError 置 status='error' 等价。
4. **孤儿 toolResult**（用例 11）：messages 空 + orphan 数组两侧内容 deep equal（增量合并阶段消费）。

另有 lift 保真用例（第 13 条）：lift+reducer vs 手写真实形态 entry 直接喂 reducer，`viaShim` 与 `viaDirect` 整 state toEqual——独立于 lift 实现的第二防线。

### 3.3 确定性用例

apply-entry.test.ts 确定性 describe 3 条：同 mixed 序列两次喂入 `expect(a).toEqual(b)` + id 数组逐字相等；structuredClone 快照断言不 mutate 输入（copy-on-write 回填路径）；无 entry.id 时派生 `e0` 且 piEntryId 不回填、两次喂入全等。**如实**。

### 3.4 既有 converter 测试零缩水（逐一实跑）

| 测试文件 | 用例数 | 结果 |
|---------|--------|------|
| packages/runtime/test/message-converter.test.ts | 29 | 29 passed |
| packages/runtime/test/message-converter-gui.test.ts | 5 | 5 passed |
| packages/runtime/src/__tests__/message-converter-bash.test.ts | 6 | 6 passed |
| packages/runtime/src/__tests__/message-converter-order.test.ts | 4 | 4 passed |
| packages/runtime/src/__tests__/infra/pi/entry-tree-builder.test.ts | 19 | 19 passed |

与 builder 自报 29/5/6/4/19 一致；五文件均不在 git status 修改列表（未被改动），且现在跑的是新路径（convertPiHistory 已改 wire lift + reducer）全绿——覆盖零缩水 + 新路径通过既有回归。

## 4. 行为对抗抽查（红性验证）

| # | 篡改 | 预期红 | 实际 | 还原 |
|---|------|--------|------|------|
| 1 | apply-entry.ts custom entry later-wins 改 first-wins（`if (!has) set`） | later-wins 用例红 | `1 failed \| 20 passed`，正是「custom entry：同 userEntryId 冲突 later-wins」 | shasum 复原 |
| 2 | apply-entry.ts usage 提取丢弃（`return { usage: ... }` → `return {}`） | assistant 用例红 | `1 failed \| 20 passed`，正是「thinking+toolCall+text / usage / fileChanges」用例 | shasum 复原 |
| 3 | message-converter.ts legacy 家族删除（convertPiHistoryLegacy 实现整段删，4037 字符） | 等价测试全红 | 13 用例中 10+ 条 deep equal 断言全红（防线非空转实证） | shasum 复原 |

字节级还原凭证：

- apply-entry.ts：8b76491525e5a356af9f5cebf986efec3a95e40ab2262a88e789d6f2639d18ed（篡改前后一致）
- message-converter.ts：8bc125ca52f9f6ff85acabdaae4f67d800c86d5d929ad589f280a680ed91b896（篡改前后一致）

还原后复跑 apply-entry.test + apply-entry-equivalence = `2 files / 34 tests passed`。

纯函数核验（D5 构造性要求）：`grep "Date.now|randomUUID|Math.random|new Date()"` 仅命中文件头契约注释；唯一 `new Date(timestamp).getTime()`（L185）为输入派生。console.warn 仅 3 处可观测性（文件头已声明不影响确定性）。**通过**。

双形态存储用例：compaction（message/compactionSummary role 用例 + compaction entry 用例）、custom（message/custom role 用例 + custom entry 用例 + custom_message entry 用例 ×2 含 display 覆写）、branch_summary（双形态各 1）——两路径 case 均有用例且语义差异（display 覆写归专用 case）被显式断言（apply-entry.test L214 注释 + 等价测试用例 5）。

## 5. 五项 builder 决策裁决

| 决策 | 裁决 | 证据 |
|------|------|------|
| a. 相对路径 import（runtime→core） | **认可** | apply-entry.ts L23-24 自包含约束（只 import @xyz-agent/shared）；tsup 产物内联实证（§2）；message-converter.ts L10-13 说明包依赖方向原因（core 依赖 vue/pinia）+ W21/W22 重评估路径。长期合理性已标注 |
| b. useChat hydrate 落地形态 | **认可（按 acceptance）** | useChat.ts diff 仅 2 处 provenance 注释（hydrate 消费 reducer 产物、getHistory RPC 链不变、实时侧留 W21），无逻辑改动。plan 步骤 3「hydrate 逐条 applyEntry」与 acceptance「接 reducer 产物」冲突按 acceptance 落地，wire 上收留 W21——与任务给定裁决一致 |
| c. 两处已知分叉 | **认可** | normalizePiToolResult 副本：apply-entry.ts L19-21 注释在位（core 不依赖 runtime、shared 收敛留后续 wave）；legacy 保留：message-converter.ts L15-17 + L315-321 注释在位（唯一消费方 = 等价测试、W21 随 live-reload 删除）。W21 收敛路径明确 |
| d. Message.id 确定性派生 | **认可** | deriveBaseId = `entry.id ?? e${messages.length}`（L194-196，真实 entry.id 为 uuidv7 无碰撞）；增量去重身份 = piEntryId 非 Message.id（history-rebuild-cache.ts mergeIncrementalMessages L98-121，按 piEntryId 建 seen 集合）——id 派生方式变更不影响增量去重，builder 说法属实 |
| e. pi 双形态存储 | **属实** | pi session-manager.ts：appendMessage（L976，AgentMessage → message entry）与 appendCompaction（L1024）/ appendCustomMessageEntry（L1095）/ branchWithSummary（L1304）专用 entry 写入路径并存；sessionEntryToContextMessages（L377-391）专用 entry ↔ role 消息双向转换；messages.ts L29-73 定义 compactionSummary/custom/branchSummary role。reducer 双形态双 case 的建模正确 |

## 6. 条款对照（w20-acceptance.md）

| 条款 | 结论 |
|------|------|
| 规格锁定 1（纯函数 reducer，state 切片） | 满足（ChatViewState + 纯度契约 + §4 核验） |
| 规格锁定 2（规则迁移源 = message-converter 重放路径） | 满足（等价测试 13 用例锁定迁移不改变行为） |
| 规格锁定 3（hydrate 接 reducer 产物） | 满足（决策 b 形态） |
| 规格锁定 4（确定性 + 全 entry 类型覆盖） | 满足（§3.1/§3.3） |
| 规格锁定 5（getHistory 走 getEntries 树重建） | 未触碰 RPC 链（session-service 增量路径仅消费 reducer 产物） |
| 通过命令 1（test -f / grep 13 / 双包 typecheck+test） | 满足（§2） |
| 通过命令 2（新旧路径 deep equal 回归防线） | 满足且红性实证（§3.2/§4） |
| 通过命令 3（既有测试零缩水） | 满足（§3.4） |
| 禁改清单（权威文档/登记表/并行领地/event-adapter/live-reload/禁 git 写/禁 mock/禁 any） | 全部合规（§1；测试用真实形态 fixture；无 any——apply-entry.ts 全 unknown + 运行时守卫收窄） |

## 7. 遗留观察（非阻断，移交 W21）

1. [minor] packages/runtime/src/services/session/history-rebuild-cache.ts L88-89 注释「重建消息的 id 是每次随机生成的 UUID (message-converter)」在 W20 后已过时（id 改为 entry 派生确定性）。该文件不在 W20 六文件内（builder 正确未越界修改），建议 W21 顺带更新注释。
2. [minor] message-converter.ts fillToolCallOutput 标注「[迁移期参照] W21 删除」，但它同时被生产路径 applyOrphanToolResults（session-service 增量合并消费）使用（L162-164 注释已声明共生）。W21 执行「删 legacy 家族」时须保留或迁移该函数，防止误删打断增量孤儿回填。

## 8. 总结论

**PASS**。6 文件交付与自报一致；13 case 精确对应 pi 协议（9 entry 类型 + 7 message role，pi 源码逐项核实）；21+13 新用例真实断言且红性验证 3/3 触发；既有 63 用例（29/5/6/4/19）零缩水全绿；双包 typecheck/test/build 实跑通过（runtime 两次瞬时红均归因 W7 并行半成品，最终态全绿）；五项 builder 决策全部核实认可；验收权威文档防篡改通过。
