# W6 验收报告：ReplicatedState<T> 原语（verifier 对抗式独立验收）

- **验收对象**：`packages/runtime/src/services/session/replicated-state.ts` [新增] + `packages/runtime/src/__tests__/replicated-state.test.ts` [新增 13 用例]
- **验收基线 commit**：`763d76e40`（验收时 HEAD = `962e51c5e`，仅新增 W7/W17/W21 三份 acceptance 基线文件，主 agent pre-stage，豁免）
- **规格 SSOT**：`docs/architecture/data-source-governance-plan.md` §3 W6 节
- **验收时间**：2026-08-19
- **总结论：PASS**

## 1. 防篡改检查

| 检查项 | 结果 |
|--------|------|
| `git diff 763d76e40 -- .xyz-harness/.../w6-acceptance.md` | 空（exit 0，无输出） |
| `git diff 763d76e40 -- docs/architecture/data-source-governance-plan.md` | 空（exit 0，无输出） |
| `git status -uall` 越界扫描 | 仅 W6 两新增文件 + W16 领地（`extensions/subagent-workflow/src/execution/{finalize-record,record-store,subagent-service,record-entry}.ts` 及其 `__tests__` 两文件，并行豁免）。W20 领地无工作区改动。无 ledger 越界、无 tsup.config.ts 改动 |

### sha256 记录（验收时点）

| 文件 | sha256 |
|------|--------|
| `.xyz-harness/.../w6-acceptance.md` | `6cdf1fe056e177aa44aac9fd251085f8b0fb6672f11b0e9c06dcb34ffd25b9d5` |
| `docs/architecture/data-source-governance-plan.md` | `f76097ed3055fd88b6d29e6bdbcc0c5216d78e0dc14e105519ca6795cc1f06c4` |
| `packages/runtime/src/services/session/replicated-state.ts` | `1e5003edc80fe8814abc775894005f2c82d73aad7d536d4c6c994412aa4493b5`（红性验证全部还原后复核一致） |
| `packages/runtime/src/__tests__/replicated-state.test.ts` | `e610492a6f1e227190b55b407b8cd315af847d9de7f3596823f18c8c72d12fd3`（全程未改动） |

## 2. 命令实跑

| 命令 | 结果 |
|------|------|
| `cd packages/runtime && pnpm typecheck` | exit 0，无错误输出 |
| `pnpm exec vitest run src/__tests__/replicated-state.test.ts` | `Test Files 1 passed (1)` / `Tests 13 passed (13)` |
| `pnpm test`（runtime 全量） | `Test Files 268 passed (268)` / `Tests 3118 passed (3118)`，无既有用例变红（W16/W20 领地在 runtime 包内无挂测试，无需归因） |
| `grep -n "markDirty\|refetch\|fieldsNullSemantics\|pollIntervalMs" replicated-state.ts` | 全命中（markDirty L177 / refetch L205 / pollIntervalMs L76/L164 / fieldsNullSemantics L80/L232 等） |
| `grep -rn "replicated-state" packages/runtime/src --include="*.ts" \| grep -v __tests__` | 仅 `replicated-state.ts:32: * @module replicated-state`（文件头注释）——**零调用，零行为变化确认** |

输出尾部（全量测试）：

```
 Test Files  268 passed (268)
      Tests  3118 passed (3118)
   Start at  06:37:51
   Duration  35.92s
```

## 3. 真实性抽查（防空洞断言）

1. **「markDirty 后防抖窗口内 get() 返回旧值」**（test L87-106）：markDirty 后立即断言 `get()` toEqual 旧快照 + `fetch` 调用数仍为 1 + `DEBOUNCE_MS-1` 时仍旧值 + `+1ms` 后新值才应用。真实语义断言（值 + 调用数 + dirty 三维），非「不抛错」空洞形态。
2. **「undefined 覆盖旧名」wire 形态**（test L46-49 + L187-201）：`toWire()` = `JSON.parse(JSON.stringify(value))` 真实构造 JSON 序列化丢 undefined key 的 wire 形态，断言 `get()?.sessionName` undefined 且整体 toEqual 不含 sessionName key。
3. **退避边界差 1ms**（test L155-183）：`advance(999)`→不重试、`advance(1)`→第 1 级；`advance(4999)`/`+1`、`advance(14_999)`/`+1` 同形态，1s/5s/15s 三级逐级 + 耗尽后 120s 停止。
4. **「未配置不启动定时器」证明方式**（test L255-261）：双重证明——构造后 `vi.getTimerCount() === 0`（定时器计数直接证据）+ `advance(120_000)` 后 `fetch` 零调用（行为级佐证）。

## 4. 红性验证（行为对抗，4 条篡改，全部字节级还原）

| # | 篡改内容（模拟退化形态） | 预期红用例 | 实测 |
|---|--------------------------|-----------|------|
| 1 | `markDirty` 改为立即 `doFetch()`（去防抖，事件直写退化） | 用例 1「失效不直接写值」 | **红**（4 failed：用例 1 + 防抖聚合 + 退避序列 + epoch 守卫） |
| 2 | `normalizeWireSnapshot` 的 'explicit-null' key 缺失改「跳过不物化」（空值当字段不动） | 用例 3「空值覆盖 D1b 反例」 | **红**（精确 1 failed） |
| 3 | `applySnapshot` 无条件清 dirty（去 epoch 守卫） | 「在途失效不丢」用例 | **红**（精确 1 failed） |
| 4 | pollTimer 无条件启动（`?? 30_000`） | 「pollIntervalMs 未配置零定时器」用例 | **红**（4 failed，含目标用例） |

还原核验：`cp` 备份还原后 `shasum` = `1e5003ed...`（与篡改前一致），测试复跑 13/13 绿，`git status` 与验收开始时一致。测试文件全程未被篡改（sha 不变）。

## 5. 读源码核验

- **dispose 三类定时器清理完整**（L212-220）：`clearDebounceTimer()` + `clearBackoffTimer()` + `clearInterval(pollTimer)`，全路径守卫：`markDirty`/`refetch`/`scheduleBackoffRetry` 入口 `if (this.disposed) return`，`doFetch` finally 的 chainedRefetch 补拉有 `!this.disposed` 守卫——无定时器泄漏路径。
- **epoch 守卫语义正确**：`doFetch` 记录 `epochAtStart`（L229）；`applySnapshot` 仅当 `epochAtStart === invalidationEpoch` 才清 dirty/归零退避/撤销冗余拉取（L250-256）；markDirty 自增 epoch 并重挂防抖（L180-185）→ 在途失效不被成功快照吞掉且必有补拉。篡改 3 行为级证实。
- **配置六字段完整 + JSDoc**（L67-81）：`fetchSnapshot` / `debounceMs` / `backoffSchedule: readonly number[]` / `pollIntervalMs?: number` / `merge` / `fieldsNullSemantics`，每字段有 JSDoc。
- **零 any**：实现含 `raw as Record<string, unknown>` 断言，前置 `typeof raw === 'object' && raw !== null` 运行时 guard，符合「断言须有运行时 guard」规范。

## 6. 两项契约外增量裁决

| 增量 | 裁决 | 依据 |
|------|------|------|
| `dispose()` | **合理非投机** | `pollIntervalMs` 在构造函数即启动 `setInterval`（L164-168）——W7 接线后为 per-session 实例，session 销毁若无 dispose 入口 = 周期定时器泄漏 + 僵尸拉取。ADR-0049 cleanup 统一编排需要该入口，由契约内 `pollIntervalMs` 能力必然导出 |
| `isDirty()` | **合理非投机** | 验收条款「快照失败退避重试且 dirty 不清除」用例（test L126-153）与「dispose 后 markDirty 全 no-op」断言（test L289）均依赖 dirty 可观测；不暴露则该条款不可验收。生产侧亦可作 stale 指示 |

## 7. 观察项（不阻塞 PASS，供 W7/W8 接线参考）

1. `doFetch` 的 `catch {}` 完全吞错（L234-236）：退避重试期间失败原因不可观测（无日志/错误回调），调用方只能靠 `isDirty()` 推断。plan W6 未要求失败可观测接口；若 W7 接线后需要诊断能力，届时补 onError 钩子。
2. dispose 时在途 fetch 的 Promise 完成后 `applySnapshot` 仍会写 snapshot（纯内存写、无定时器、无后续拉取）——与 JSDoc「dispose 后 get() 仍可读最后快照」声明一致，无害。

## 8. 条款对照（w6-acceptance.md）

| 条款 | 状态 |
|------|------|
| 交付物两文件（新增，零外部 npm 依赖） | 达成（tsup.config.ts 未动） |
| 接口契约六字段 + markDirty/get/refetch + D1b 两条 | 达成 |
| 单测 ≥7 条（fake timers 项目规范） | 达成（13 条，`vi.useFakeTimers` + `advanceTimersByTimeAsync`，无真实 sleep） |
| 通过命令 1（grep 四关键字全命中） | 达成 |
| 通过命令 2（typecheck + test） | 达成（13/13 + 全量 3118/3118） |
| 通过命令 3（两条设计约束断言存在） | 达成（「事件到达后立即读值为旧快照」= test L94；「显式空值覆盖非空旧值」= test L198） |
| 通过命令 4（零调用 grep + 全量回归） | 达成 |
| 禁改清单（权威文档/既有源码/并行领地/tsup/禁 git 写/禁 any） | 无违反 |

## 总结论：**PASS**

W6 原语交付完整、测试真实且具红性（4 条对抗篡改全部按预期变红）、零行为变化（无调用方）、无越界改动。可解锁 W7。
