# W6 验收标准：ReplicatedState<T> 原语

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §3 W6 节（L229-255）是 W6 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W3、W4（护栏先行，均已 committed）。

## 目标（一句话）

runtime 有了通用快照复制原语——配置三元组 `(快照 RPC, 失效触发源, 合并策略含字段空值语义)` 驱动「快照拉取 + 事件只做失效 + 退避重拉」，六类标量状态不再各写各的缓存（D7 原则 4）。**本 wave 只交付原语本体，不接线任何实例**（W7/W8 做）。

## 交付物

1. `packages/runtime/src/services/session/replicated-state.ts` [新增]：TypeScript class，零外部依赖（不新增 npm 依赖，避免 tsup noExternal 变更）
2. `packages/runtime/src/__tests__/replicated-state.test.ts` [新增]

## 接口契约（锁定，plan W6 步骤 1）

- 构造配置：`{ fetchSnapshot(): Promise<T>, debounceMs, backoffSchedule: [1000, 5000, 15000], pollIntervalMs?: number, merge(snapshot: T, current: T): T, fieldsNullSemantics }`
  - `pollIntervalMs` 周期兜底重拉（可选，默认关闭 = 不启动周期定时器——W7 thinkingLevel 依赖：pi 同档位切换不发射事件）
- `markDirty()`：置 dirty + 防抖触发重拉（**事件只做失效，永不直接写数据**）
- `get()`：读当前快照值；dirty 时返回上次快照（快照失败保留 dirty 不清除，UI 显示上次值）
- `refetch()`：重连兜底全量重拉（退避 1s/5s/15s）
- 合并规则内建 D1b 两条：① owner 快照合并 = 权威源整字段覆盖**含显式空值**；② wire 层空值归一（JSON 序列化丢 undefined key → 按 fieldsNullSemantics 判定「key 缺失」语义，禁止当「字段不动」）

## 单测验收（≥7 条，fake timers 项目规范）

1. 失效不直接写值：markDirty 后防抖窗口内 get() 返回旧值
2. 快照失败退避重试且 dirty 不清除
3. 空值覆盖语义：sessionName undefined 覆盖旧名（D1b 反例回归）
4. wire 归一：key 缺失按登记语义处理
5. pollIntervalMs 周期兜底：配置后到点触发重拉、未配置不启动定时器
6. （补充）退避序列 1s/5s/15s 逐级
7. （补充）refetch 全量重拉语义

## 通过命令（builder 自验 + verifier 实跑）

1. `grep -n "markDirty\|refetch\|fieldsNullSemantics\|pollIntervalMs" packages/runtime/src/services/session/replicated-state.ts` 全部命中
2. `cd packages/runtime && pnpm typecheck && pnpm test` 通过（含新测试文件 ≥7 用例）
3. 设计约束断言（plan W6 验收 2）：测试中存在「事件到达后立即读值为旧快照」用例 + 「快照含显式空值覆盖非空旧值」用例
4. 回归（plan W6 验收 3）：`grep -rn "replicated-state" packages/runtime/src --include="*.ts" | grep -v __tests__` 仅定义无调用（本 wave 零行为变化）；全量 RUNTIME_TEST 无既有用例变红

## 禁改清单（越界 = 验收失败）

- 两个验收权威文档；登记表
- 任何既有源码文件（本 wave 只新增两文件；若发现需要改既有文件 = 规格冲突停下上报）
- **并行领地**：W16（extensions/subagent-workflow）、W20（core domain/chat + runtime message-converter）的领地文件一律不碰
- packages/runtime/tsup.config.ts（零新增依赖即无需动；需要动 = 偏离上报）
- 禁 git 写操作；禁 mock 框架滥用（fake timers 是规范要求，非 mock 违规）；禁 any

## 备注

- 完成后解锁 W7（主链下一波）。登记表「原语就位」标注（plan W6 步骤 3）——本 wave 不改登记表，标注随 W7 流转时一并落（避免与并行 wave 冲突登记表）。
