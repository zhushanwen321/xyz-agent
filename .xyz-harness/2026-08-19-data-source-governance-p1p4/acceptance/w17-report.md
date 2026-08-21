# W17 验收报告：workflow 自描述记录收敛 + W16 P-1 修复（verifier 独立验收）

> 验收人：verifier（对抗式独立验收，builder 自报全部实测复核）
> 日期：2026-08-19
> 验收基线：commit `962e51c5e` 的 `w17-acceptance.md`；规格 SSOT = `docs/architecture/data-source-governance-plan.md` §5 W17 节（L543-565）
> **总结论：PASS**

## 1. 防篡改

| 检查项 | 结果 |
|---|---|
| `git diff 962e51c5e -- .xyz-harness/.../w17-acceptance.md` | 空（0 行） |
| `git diff 962e51c5e -- docs/architecture/data-source-governance-plan.md` | 空（0 行） |
| w17-acceptance.md sha256（工作区 vs 基线 commit） | `0bb9b1512150a22a088995798a0b2862a94d6f6ec421f073d3e2536c692e8400` 双向一致 |
| data-source-governance-plan.md sha256（同上） | `f76097ed3055fd88b6d29e6bdbcc0c5216d78e0dc14e105519ca6795cc1f06c4` 双向一致 |

越界扫描：
- 基线 commit 后的 5 个提交（`3e44c514c`/`e47b6736a`/`5c80df4e5`/`ebc6f6991`/`b8db5afe7`）均为 W6/W16/W20/W7 已验收 wave（ledger 记录 verifier PASS），非 W17 builder 改动。
- 工作区未提交改动 = W17 四文件（subagent-workflow 4 个 M）+ W8 领地（runtime 4 M + 1 untracked）+ w8-report.md（W8 verifier 产物，主 agent 豁免范围）。`git status -uall` 无其他 untracked。
- 登记表 `docs/architecture/data-source-registry.md` 无改动（builder 遵守禁改，文案草稿应进汇报）。

**结论：无篡改、无越界。**

## 2. 通过命令实跑

| 命令 | 结果 |
|---|---|
| `grep -n "workflow-record" extensions/subagent-workflow/src/orchestration/jsonl-run-store.ts` | **8 命中**（L16/30/128/131/296/488/555/557；builder 自报 7，验收标准 ≥2，满足） |
| `pnpm extensions:typecheck` | exit=0 |
| `pnpm extensions:lint` | exit=0（0 errors / 194 warnings；W17 四文件中仅 subagent-service.ts 有 10 条 warning，行号 L456-464/L973 全在存量行，W17 改动行 L538-560/L1084-1119 零新增） |
| `pnpm extensions:test` | exit=0；**subagent-workflow 165 files / 2230 tests 全绿**（builder 自报 2230 属实） |

## 3. 条款对照（验收基线 → 实态）

| 基线条款 | 核实 |
|---|---|
| 交付物 1：指针 entry 改自描述 `workflow-record` | ✓ L128 常量 `WORKFLOW_RECORD_CUSTOM_TYPE`、L138-145 `WorkflowRecordEntryData`（v:1 + snapshot + updatedAt）、doFlush L488-494 每次 writeFile 成功后 append（同一份 snapshot——entry 与 state 文件内容一致） |
| 交付物 1：loadAll 重建改造 | ✓ L566-618：单遍扫 entries → workflow-record 进 `recordRuns`（同 runId 后写覆盖=最后一条胜出）→ link 进 `pointers`；`runs = recordRuns.values()` 后遍历 pointers，`recordRuns.has(runId) continue`（entry 优先、link 优先级低）。三分支顺序 = entry > 旧 link > 空，与基线一致 |
| 交付物 1：版本 guard | ✓ entry 层 `data?.v !== 1 \|\| !data.snapshot` 跳过（L579）+ snapshot 层 D-5 `deserializeRun` 返回 null 跳过（L580）两级独立 |
| 交付物 1：旧 link 兼容（存量不静默丢失） | ✓ L583-589/L596-612 兼容读，测试 L951 专测 |
| 交付物 1：state 文件降级（读序 entry > state 文件 > 空，写路径保留） | ✓ 写路径 doFlush 保留 writeFile；测试 L927 删 state 文件后仍从 entry 完整重建（纯缓存证明） |
| 交付物 2：测试改造 | ✓ 33 用例全绿：旧 link 兼容 1（L951）+ 新 entry 重建 ≥3（L906 entry 序列形态 / L927 entry 优先重建 / L976 读序优先级 / L1010 v guard）+ 常量钉住（L900）+ entry 计数语义（L611） |
| P-1 修复（W16 移交 major） | ✓ 详见 §4.3 |
| 行为级：pi 实测 entry 序列含终态 | ✓ 详见 §5 独立实测 |
| 禁改清单 | ✓ 全部遵守（见 §1） |

## 4. 真实性抽查

### 4.1 loadAll 三分支语义（读代码核实）

- **entry 优先 + last-wins**：`recordRuns.set(run.runId, run)` 按文件顺序覆盖，最后一条 entry = 最后一次成功 flush ✓
- **旧 link 跳过逻辑**：`if (recordRuns.has(runId)) continue`——entry 已覆盖的 runId 不读 state 文件（link 仅是发现通道）✓
- **空**：无 entry 无 link → 空（ctx 缺失也返回空）✓
- 边界：单条坏 state 文件 catch 跳过不炸 loadAll（L607-611）；getEntries 失败返回已收集部分（L613-616）。
- 一个良性细节（非缺陷）：同 runId 最后一条 entry 是未来版本（v≠1）时整条跳过，Map 保留更早的 v1 entry——「最后可解析条胜出」是合理降级（优于静默丢 run）。

### 4.2 33/33 测试新旧两形态

- 旧 link 兼容 ≥1：`L951`（存量 link + state 文件、无 entry → loadAll 经 link 重建，断言 calls 字段完整）✓
- 新 entry 重建 ≥3：`L906`（running→done 序列、v1、快照字段）、`L927`（state 文件删除后 entry 完整重建）、`L976`（entry 终态 vs link 指向旧 running state 文件 → entry 胜出）、`L1010`（v:2 未来 entry 跳过）✓
- 断言语义核验：L976 显式构造「link 指针 + 被回退为旧 running 快照的 state 文件 + 更新的 done entry」三方竞争，断言 done 胜出——精准钉住读序优先级，非形式断言。

### 4.3 P-1 修复（选项三变体）核实

diff 三处改动（subagent-service.ts 16+/6-）：
1. `closeChatIdle` L1093：`text: ""` → `text: record.result ?? ""`（与 `closeAfterRoundSettled` L1145 原有模式对齐）
2. `notifyClosed` 新增 `emptyBody = false` 参数，true 时 `notify.result = ""`
3. closeChatIdle 调用点改 `notifyClosed(record, true)`

- closeAfterRoundSettled 路径：L1155 `notifyClosed(record)` 零变化 ✓
- cancel 路径：L1588/L1686 `cancelledResult text: ""` 零变化（cancel 语义本就无轮终 result，与 P-1 无关）✓
- D2 路径②正文空契约：由 `emptyBody` 显式承担——回归测试 L557 `closeMsg.content` `not.toContain("LAST-ROUND-INCREMENT")` 既有断言仍绿 ✓

## 5. 行为对抗抽查（3+1 项）

### 5.1 P-1 红性验证

- 临时还原缺陷：仅 closeChatIdle L1093 `text: record.result ?? ""` → `text: ""`（closeAfterRoundSettled L1145 未动，python 断言防误伤）
- 结果：`subagent-service-message-close.test.ts` **1 failed | 20 passed**——唯一红的是 `[W16 P-1 回归] close 终态 subagent-record entry 的 result == 轮终真实值`，精确命中
- 字节还原：sha256 `98f0c6fb...` 与交付态一致，重跑 **21 passed (21)** ✓
- 附带证据：缺陷态下既有 [C-1] 用例仍绿（notifyClosed emptyBody 未动）——正文空契约确由 emptyBody 承担

### 5.2 反事实对抗（选项三变体必要性）

- 临时构造「选项一」：保留 `text: record.result ?? ""` 但移除 emptyBody 机制（删 `if (emptyBody) notify.result = "";` + 调用点去 `, true`）
- 结果：**[C-1] idle close 用例红**（正文携带上轮增量，违反 D2 路径②「终态通知正文空」契约）；路径①不受影响
- 结论：仅修 text 不完备——P-1 修复选「text 保真 + emptyBody 显式化」是必要的最小闭环。字节还原后 21/21 绿

### 5.3 独立 pi 实测（命令形态同 builder：`pi -ne --mode rpc --session-dir <tmp>/sessions --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <repo>/extensions/subagent-workflow/index.ts`，fifo 保活 stdin）

**实测 A（chain.js 内置三步 workflow，真实 LLM 生命周期）**：
- session JSONL 出现 **4 条 workflow-record entry**：`running(0 calls, 5030B) → running(2 calls, 13108B) → running(3 calls, 17373B) → done(3 calls, 20461B)`
- entry 序列含终态 done（reason=completed）✓
- calls 递增 0→2→3→3 证实「热路径中间态 flush 每次 append」的写点行为 ✓
- done entry 自描述完整性：v=1 / runId / reason / 3 calls（status=done + sessionId 在位）/ scriptResult（chain outcome 完整 JSON）/ trace 3 节点 / budget（usedTokens 58462、totalCallCount 3）/ meta 双时间戳 ✓
- 体积 5.0-20.5KB、4 条/run：未触发分流阈值（单 entry >100KB 或 >50 次）✓（与 builder 自报 4 条/7.9-52.5KB 形态一致，量级相符）

**实测 B（自造单步脚本）**：2 条 entry `running(585B) → done(644B)`，v=1、终态在位。

- entry 均为 `type:"custom"` + `customType:"workflow-record"`，data 含 v/snapshot/updatedAt；主对话 message entry 数不因 entry 增加而污染（22 行 session 仅 6 message + 12 custom，无 entry 内容进 LLM context 的迹象）
- tmp 已清理、pi 进程已 kill（残留 0）

### 5.4 崩溃语义（「热路径 flush 后指针永失窗口结构性消解」）

- 旧形态窗口（diff 删除侧注释自证）：`writePointer = 首写 || done`——首写失败回滚后，热批 flush 成功但永不写指针 → 再无 save 则 run 对重启不可见
- 新形态：doFlush 每次 writeFile 成功即 append entry（热路径含）——任何一次成功 flush 都使 run 对 loadAll 可见，窗口**结构性消解**（非测试补丁）✓
- 测试级证据：`W2TC6(W17)`（L611）断言中间 3 轮各 append 1 条 entry（`2 save → 1 flush → 1 entry` 不放大）；`W2TC13`（L849）钉住丢失边界 = 最后一次成功 flush（去抖窗口内崩溃中间态丢失 ≤saveDebounceMs，已接受语义）
- 新残余窗口（首写失败回滚后无任何后续 save → entry/state 双缺）在注释中显式声明 = 等价崩溃丢失，kill-9 恢复兜底——语义诚实

## 6. 三项裁决

### 裁决 ①：每次 flush 都 append（vs plan 字面「状态迁移点」）——**合理，认可**

plan 步骤 1 字面是「run 状态迁移点 append」，但 plan L551 同时规定硬前提「state 文件……**可从 entry 完整重建才允许存在**」。若 entry 只在迁移点（创建/终态）写，热路径中间态 flush 写入 state 文件的内容不在 entry 流中——entry 无法完整重建 state 文件，纯缓存前提破坏（缓存里藏着权威数据）。builder 的写点选择是该前提的必要条件，且 plan 的「迁移点定位法」本意是写点定位方法论而非频率上限（频率上限走 W16 阈值探针纪律）。频率/体积实测（builder 4 条/峰值 52.5KB = 阈值 53%；verifier 独立实测 4 条/峰值 20.5KB）均未触发分流。**裁决：认可 builder 论证。**

### 裁决 ②：P-1 修复选项三变体（text 保真 + notifyClosed emptyBody 显式化）——**合理，认可**

- 持久化保真（entry result = 轮终真实值）与通知契约（D2 路径②正文空）两个关注点解耦，各自显式
- 反事实验证（§5.2）：无 emptyBody 的「选项一」使既有 [C-1] 契约红——证明变体必要
- 红性验证（§5.1）：回归用例对缺陷态精确红，修复态绿
- cancel/closeAfterRoundSettled 路径零变化（grep + diff 核实）**裁决：认可。**

### 裁决 ③：登记表 #9 草稿文案与代码实态一致性——**核对锚点通过（局限：草稿原文未随派发词提供）**

builder 汇报中的草稿原文 verifier 不可见（在 builder→主 agent 汇报链路中），按代码实态给出落表对照锚点（主 agent 落表时逐项核对）：
1. customType 字面量 = `workflow-record`（常量 `WORKFLOW_RECORD_CUSTOM_TYPE`，测试 L900 钉住拼写）
2. entry data = `{ v: 1, snapshot: RunSnapshot 完整快照, updatedAt }`
3. 读序 = workflow-record entry > state 文件 > 空；state 文件 = 纯性能缓存（写路径保留）
4. 旧 `workflow-state-link` 兼容读（优先级低，存量不静默丢失）
5. 两级版本 guard：entry 层 v1 + snapshot 层 D-5 snapshotVersion
6. 频率/体积探针数字：builder 4 条 / 7.9-52.5KB；verifier 复测 4 条 / 5.0-20.5KB（同一 run 形态）

## 7. 观察项（不阻塞验收，W17 领域外）

1. **实测 B 发现**：自造 workflow 脚本 `@pi-meta` 解析失败（parseResourceMeta → available=false）时，`actionRun` 仅判 `!script` 不判 `script.available`——run 以空 `scriptSource` 启动并在毫秒级 done(completed)（`config-loader.ts` m2 exec-review MINOR-4 的已知静默路径，`tool-workflow.ts` 层未拦）。既有行为、非 W17 引入，建议后续 wave 评估 run action 前置 `available` 检查。
2. 实测 A 中 mimo 模型对 agent schema 的 `text` 字段返回空（result.text=""）导致 chain 末段输入「(分析无结果)」——LLM 输出质量问题，与快照机制无关（entry 完整记录了字段结构）。

## 8. verifier 环境还原声明

- `subagent-service.ts` 两次篡改-还原均字节级验证（sha256 `98f0c6fbaf2972792283a8607846c25ac3430067b1d38d4673a7c30b6e0b9e1c`，与 builder 交付态一致）
- 其余 W17 文件零触碰；pi 实测 tmp（`/tmp/w17-verify.uTQXT5`）已删除，pi 进程残留 0；实测 session JSONL 证据备份于 `/tmp/w17-verify-sessions-evidence.jsonl`（98650 bytes，2 sessions）
- 唯一写入文件 = 本报告

## 9. 总结论

**PASS**——防篡改通过、三连全绿（2230）、33/33 用例新旧两形态在位、P-1 修复红性 + 反事实双对抗通过、独立 pi 实测 entry 序列（含终态 + 中间态递增 + 自描述完整字段）证实、三项裁决全部合理。附 2 条 W17 领域外观察项供主 agent 分流。
