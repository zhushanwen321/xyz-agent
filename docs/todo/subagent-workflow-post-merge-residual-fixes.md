# subagent/workflow 状态同步：合流后剩余缺口修复设计

> **一句话结论**：`fix-chat-flow-order` 分支的 W16-W18（自描述 record entry + 派生缓存）已等效实现前版设计 v11 的核心架构（磁盘单一真相源 + 失效信号 + 秒级收敛），F1/F2/F3/F5 与 F6 的 hasWorking 半边随之解决；本设计只覆盖合流后仍真实存在的三个缺口——workflow kill-9 恢复不落盘（补一行 save）、subagent 孤儿终态兜底（extension 重建矩阵增强：重开时读子 session 收尾判终态并落 entry）、等续聊/真在跑的 UI 细分（entry 执行态字段 + 渲染层投影）。三件合计改动面小（extension 为主，runtime/renderer 各一处消费），全部在 W16-W18 已建立的数据通路上扩展，不新增协议、不新增真相源。

<!-- 层声明：本次设计当前层 = 技术方案（接口/数据模型/选型），下一层 = 可实施的 wave 拆分 + 测试用例。基线 = fix-chat-flow-order HEAD（commit 3af2baa71），非本分支 main 基线——实施前置条件是该分支合入。 -->

## 开篇（SCQA）

- **S（情境）**：`fix-chat-flow-order` 分支完成了 data-source-governance W16-W18：extension 在 record 状态迁移点经 `pi.appendEntry` 写自描述完整快照 entry（`subagent-record` / `workflow-record`，v1 schema），runtime 持有可丢弃重建的派生缓存（`entry_appended` 失效 → 300ms 防抖 → `get_entries` 增量拉取 → 与冷启动共用同一份扫描代码），侧边栏状态与 60s LLM 通知窗口解耦。
- **C（冲突）**：三个缺口仍在。① workflow kill-9 恢复循环只改内存不 `store.save`——state 文件与 workflow-record entry 双双停留 running，侧栏永久卡 running；② subagent 孤儿（父 pi 被 kill -9，子进程跑完但无人写终态 entry）重开后 entry 停留在 running，且 extension 重建矩阵分支 4 刻意落 running（v4 B-1 可续聊语义），UI 无从区分「真在跑」与「进程早已死」；③ 「等续聊」「真在跑」在侧栏同样显示 running——hasWorking 语义已由 result 字段修正，但侧栏状态点的粒度细分未做。
- **Q（问题）**：如何在 W16-W18 已确立的「extension 写 entry、runtime 派生缓存、renderer 零派生」架构内，以最小改动补齐这三个缺口，而不引入新的跨边界耦合或平行真相源？
- **A（答案）**：三个修复全部顺着 W16-W18 的既有方向：恢复循环补 `store.save`（save 内部自动 append 终态 entry，一行解「落盘 + 通知」两题）；孤儿兜底挂在 extension 重建矩阵（它是重开时唯一持有 .alive/pid/sidecar/子文件全部观察手段的角色），分支 4 兜底时读子 session JSONL 收尾判终态、判不了的落执行态字段；UI 细分用 entry 新增可选执行态字段 + 渲染层判据（不改 shared 枚举契约）。

---

## 1. 背景：被设计的系统是什么

**本章结论：本设计是 v11 设计在合流现实下的收缩重写——前版九轮审查打磨的架构决策大半已被 W16-W18 等效实现，本设计只承接仍然成立的缺口。**

xyz-agent 侧边栏 Agents/Flows tab 的 subagent/workflow 状态链路，在 `fix-chat-flow-order` 合入后将是：

```
extension 状态迁移（register / archive / reportRecordTransition / workflow flush）
  → pi.appendEntry('subagent-record'|'workflow-record', v1 完整快照)   同步落盘，不进 LLM 上下文
  → pi 发 entry_appended 事件（rpc-mode 全量转发）
  → runtime EventInterpreter → sessionService.invalidateRecordEntries（300ms 防抖）
  → get_entries(since=cursor) 增量拉取 → scanSubagentEntries / scanWorkflowEntries
  → merge 派生缓存（变化才发布）→ session.subagents 全量帧 / session.workflowUpdate
  冷启动（session 未激活）：getSubagents/getWorkflows RPC → 磁盘 JSONL 全量解析 → 同一份扫描函数
```

与 v11 设计的关键机制对照（详细裁决见附录 A）：

| v11 决策 | 合流后现实 | 本设计动作 |
|---------|-----------|-----------|
| 决策 1/2：runtime 无状态 + transient 信号 + RPC 重拉 | 已等效实现（派生缓存 + entry_appended 失效 + 增量拉取；协议零改动） | 无 |
| 决策 3：三对账点（message.complete / session.exited / 重连） | 部分被替代：失效自愈（Entry-not-found 全量重建）+ 冷启动磁盘扫描承接大部分兜底；重连项经对审确认缺口后补显式重拉（附录 A-3） | 重连重拉已实现（renderer onConnected 对聚焦 session），详见附录 A-3 |
| 决策 4：秒级信号与 60s 窗口解耦 | 已实现（300ms 防抖 + 增量拉取，不经 notifier 窗口） | 无 |
| 决策 5：六级投影 + 新 6 态枚举 | 前提消失：自描述 entry 正向携带 status/sessionFile/result，逆向推断（sidecar 链 / identity-id 消歧 / timestamp 锚）整体作废；**唯一保留需求的子集** = 崩溃/孤儿终态兜底与执行态细分 | 本设计缺口 ②③ |
| 决策 6.1/6.2：workflow kill-9 恢复落盘 + 无 turn 恢复通知 | 未实现（恢复循环仍只改内存）；6.2 的无 turn 通道被 appendEntry 结构性消解（不触发 LLM turn） | 本设计缺口 ① |

本文所有行号基于 `fix-chat-flow-order` HEAD（commit 3af2baa71）。实施前置：该分支合入当前 worktree。

## 2. 设计目标

**本章结论：三个目标，全部回溯「侧边栏状态在有界时间内收敛到真实状态」这条主线，且不破坏 data-source-governance 五原则（绝对写规则 / 单次投影 / owner 唯一写）。**

1. **workflow kill-9 后重开收敛终态**：重开 session 后 Flows tab 显示 failed（非 running），workflow-record entry 末条含终态，且重开不引发 LLM turn。
2. **subagent 孤儿重开收敛**：父 pi kill -9 后子进程自然跑完的场景，重开 session 时该 subagent 显示真实终态（done 或 error）而非 running；无法判定终态时显示「等续聊」而非「正在跑」。
3. **执行态细分**：侧栏区分「真在跑」（streaming 视觉）与「等续聊/可续聊」（waiting 视觉），判据与 hasRunning（`running && result === undefined`）语义一致，不改 `SubagentStatus` shared 枚举契约。

**In-scope**：extension 三处改动（恢复循环 save、重建矩阵终态判定、entry 执行态字段）；renderer 一处消费（SubagentList 渲染判据）。
**Out-of-scope**：`SubagentStatus` 枚举重定义（v11 的 6 态方案——合流后 result/执行态字段已覆盖核心痛点，枚举迁移收益边际，列后续项）；`workflow-result` 恢复通知（appendEntry 通路已消解，见 §3.1）；v11 六级投影的其余级别（前提已消失）；runtime 对账点补建（先验证，见附录 A-3）。

---

## 3. 现状：三个缺口的确切形态

**本章结论：三个缺口都已定位到代码行，且都有明确的失败推演链。**

### 3.1 缺口 ①：workflow kill-9 恢复不落盘（v11 F4，合流后仍在）

`extensions/subagent-workflow/src/index.ts:467-475` 恢复循环（session_start 时执行）：

```ts
for (const run of loaded) {
  if (run.state.status === "running") {
    run.state.error = "Process killed (kill-9 or crash recovery)";
    run.transition("done", "failed");          // ← 纯内存状态变更
    pi.events.emit("pending:unregister", {...}); // ← 只注销 pending 注册，不落盘
  }
  runs.set(run.runId, run);                     // ← 无 store.save(run)
}
```

失败推演：kill -9 发生在 workflow running 中 → 磁盘上最后一条 workflow-record entry 与 state 文件均为 running（最后一次 flush 的快照）→ 重开 session，恢复循环把内存 run 转 failed 但不 save → W17 读序（entry > state 文件 > 空）两个来源都还是 running → runtime `getWorkflows` / 派生缓存读到 running → 侧栏 Flows tab 永久 running。对比：正常终止路径（`lifecycle.ts` 的 abortRun/onRunDone）都有 `await deps.store.save(run)`，恢复路径是唯一漏掉落盘的 done 转换点。

连带事实：补 save 后**不需要**再补恢复通知——`store.save` 内部 doFlush 会 `pi.appendEntry` 终态快照（jsonl-run-store.ts W17 [D4]），entry_appended 事件自动触发 runtime 派生缓存失效重拉，且 appendEntry 不带 triggerTurn、不唤醒 LLM。v11 决策 6.2 专门设计的「无 turn 恢复通知」被该通路结构性消解。

### 3.2 缺口 ②：subagent 孤儿重开显示 running

kill -9 父 pi 后的磁盘事实：主 session JSONL 里该 record 的最后一条 `subagent-record` entry 是 running 态（register 快照或轮终快照）——终态 entry 只有活着的父 extension 才会写（archive/reportRecordTransition 都在父进程内）。子进程（独立 CLI）继续跑完任务、正常收尾自己的 session JSONL，但**不会**往父的主 JSONL 写任何东西。

重开 session 时的两个观察者现状：

- **runtime extractor**（`scanSubagentEntries`）：纯函数扫 entry，读到 running → 侧栏显示 running。它不读 .alive/sidecar/子文件（也不应读——见 §4.2 方案 B 的否决理由）。
- **extension 重建矩阵**（`record-store.ts` `buildRecord` :816-846 的四分支实现；:440-447 JSDoc 描述同一矩阵）：session_start 时重建内存 record。分支 1（:818 `.cancelled`）→ closed(cancelled)；分支 2（:825 `.finalized`）→ closed(gc)；分支 3（:834 `.alive` + pid 活 + <1h 软超时，`ALIVE_SOFT_TIMEOUT_MS`——monorepo 集成起即 1h，自旧仓 24h 收紧以压缩 PID 复用窗口）→ running；**分支 4 兜底（:842-846，无 marker / pid 死 / 超时）→ 刻意落 running**（v4 B-1「跨重启可续聊」产品语义：用户重开后可继续与 subagent 对话）。且重建路径**不写 entry**——entry 写入口共 5 处：`register`（record-store.ts:245）与 `archive`（:259）内部直接 `pi.appendEntry`（不经 reportRecordTransition）、`reportRecordTransition` 自身（:272）及其仅有的 2 个外部调用点（冷路径续轮 subagent-service.ts:813、轮终 finalize-record.ts:244）——重建结果只影响扩展内存，不改变 runtime 读到的 entry。

推演结论：无论等多久，entry 停留 running，侧栏永久 running。子进程明明已跑完（子 JSONL 有正常收尾），用户看到的却是「正在跑」。

已知事实矛盾注明：`subagent-service.ts:952/963` 注释声称「reconstructAll 已将跨重启 record 标记为 idle」，与分支 4 代码 `markReconstructedStatus(rec, "running")` 直接矛盾——以代码为准，实施时顺手修正该注释（避免后人据注释误判）。

### 3.3 缺口 ③：「等续聊」与「真在跑」同为 running 显示

W16 已给 `SubagentRecord` 加 `result?: string` 轮终信号（running + result 非空 = 轮终 resumable，不算 working），renderer `hasRunning` 已消费（`stores/subagent.ts:117`：`running && result === undefined`）。但侧栏 `SubagentList.vue:43/57` 的 spinner 与取消按钮仍只判 `status === 'running'`：轮终等续聊的 subagent 显示转圈——「没有人驱动它的 LLM，却显示正在跑」（owner 在前版设计质询中明确否定的语义）。

数据面缺口：轮终形态 entry 已携带 result（可判「等续聊」），但**孤儿形态**（缺口 ② 的分支 4 兜底）连 result 都没有——「进程死了的 running」与「进程活着的 running」在 entry 层不可区分。缺口 ③ 的完整解法依赖缺口 ② 一并补执行态字段。

**第三形态（one-shot 成功完成，W18 机制下的既有显示问题）**：one-shot subagent 成功完成后走 `doFinalizeRoundToIdle`（finalize-record.ts R2-1 注释：本写点被 runAndFinalize 成功分支共用）——record 回 running-resumable + result，**不 archive、不落终态 entry**；W18 的 runtime 派生只认 `subagent-record` entry（bg-notify 降级为失效信号、其 closed status 不再被解析），因此侧栏对该 subagent 的显示停留在「running（hasWorking 已不亮）」直到有人显式 close。缺口 ③ 的判据若只区分 streaming/waiting，会把这一形态显示为「等续聊」——但用户期望「done」（任务已完成、结果已注入主 agent）。区分判据是 `chatMode`（chat 轮终 = 等续聊，one-shot 轮终 = 已完成）——该字段在 extension `ExecutionRecord`（types.ts:373 `chatMode?: boolean`）但**不在 entry schema / shared / extractor 链路**（`ExecutionMode` 值域恒 "background" 无区分度，types.ts:80），需随本设计补入链路（§6.2）。

---

## 4. 终态：使用者眼里将是什么样

**本章结论：三个场景全部收敛到真实状态，且不引入新协议、新真相源、新跨边界读取。**

### 4.1 成功路径时间线

```
场景 A（workflow kill -9 恢复）：
  kill -9 父 pi（workflow running 中）
  → 重开 session → extension session_start 恢复循环：
    transition("done","failed") + await store.save(run)          ← 缺口①修复
    → save 内部：state 文件写终态 + pi.appendEntry 终态 workflow-record entry
  → entry_appended → runtime 派生缓存失效（300ms 防抖）→ 增量拉取 → 发布
  → 侧栏 Flows tab 显示 failed（秒级，无 LLM turn 副作用）

场景 B（subagent 孤儿，子进程已跑完）：
  kill -9 父 pi（subagent running 中）→ 子进程继续跑完 → 正常收尾自己的 JSONL
  → 重开 session → extension session_start 恢复段主动触发一次 store.collectRecords()：     ← 缺口②修复
    重建矩阵分支 4 兜底（无 .alive / pid 死 / 超时）→ 读子 session JSONL 末行：
      正常收尾（末行完整 JSON）→ completeRecord + writeFinalized sidecar + archive
        → 终态 subagent-record entry（closed，result 有值 = done 语义）
      截断行 → 同路径终态 entry（error 语义）
      文件不可读（IO 错误）→ 不判终态，落 running entry + resumable=true（防御性路径，见 §5.2 可达性注）
  → entry 落盘 → runtime 派生缓存失效（entry_appended）→ 侧栏显示 done / error / waiting
  → 防重：终态形态因 sidecar 存在，下次重建走分支 2 不再重判（§6.1.2）

场景 C（chatMode 轮终等续聊）：
  一轮完成 → 轮终迁移 entry（running + result 非空 + resumable，W16 已有 result、本设计补另两个）
  → 侧栏 SubagentList 渲染判据：isStreaming = running && result === undefined && resumable !== true
    → 不命中 → isDone 需要 chatMode 显式 false / isWaiting 兜底 → waiting 视觉（不转圈）        ← 缺口③修复
  → 续聊新一轮 → running + result 被新一轮清空/覆盖 + resumable 清除 → 恢复 streaming 视觉
```

### 4.2 失败路径（带恢复指引）

| 失败 | 表现 | 恢复 |
|------|------|------|
| 重建时子 JSONL 读到一半被并发写截断 | 末行解析失败 | 按「异常收尾」处理（error 方向保守——子进程若真在写，它是活进程，分支 3 会先命中，进不了分支 4） |
| 重建判终态后用户还想续聊 | record 已 closed | Resume 入口依 sessionFile 存在性（W16 entry 已携带），与 status 解耦——「可续聊是动作入口，不占 status」（v11 决策 5 结论保留） |
| resumable 字段被旧 runtime 消费 | 未知字段 | runtime 消费是防御式逐字段读取（scanSubagentEntries 逐字段守卫），未知可选字段自然忽略，向后兼容 |
| 恢复循环 save 失败（磁盘满等） | entry/state 均停留 running | 下次 session_start 重开重试（恢复循环天然幂等：running → transition → save）；store.save 失败沿 JsonlRunStore settlers reject 链上抛，session_start catch 记 error 日志（与 storeHealthy 语义一致） |

---

## 5. 关键决策与权衡

**本章结论：4 个决策。核心原则是「谁拥有观察手段，谁负责写 entry」——孤儿判定的全部手段（.alive/pid/子文件）都在 extension 侧，所以修复挂 extension 重建矩阵，而不是让 runtime 跨边界读 sidecar。**

### 5.1 决策 1：workflow kill-9 恢复补 `store.save`（方案无争议，列依赖确认）

恢复循环 `transition` 后补 `await store.save(run)`。save 走冷路径（status 非 running）立即同步 flush：state 文件 + workflow-record 终态 entry 一次写齐。依据：① 正常终止路径（lifecycle.ts:282/329）同款调用先例；② W17 doFlush 的 appendEntry 触发 runtime 自动失效重拉（恢复通知免费获得）；③ appendEntry 不带 triggerTurn（无 LLM 副作用）。错误处理：save reject 时 catch + error 日志，不阻断恢复循环其余 run（逐 run try/catch，一个 run 落盘失败不拖垮整个 session_start）。

### 5.2 决策 2：孤儿终态兜底挂 extension 重建矩阵（方案对比）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|--------------|-------------|------|------|
| **A. extension 重建矩阵增强（分支 4 兜底时读子 JSONL 收尾判终态，能判则落终态 entry，不能判落 resumable 字段）** | 高：观察手段（.alive/pid/sidecar/子文件路径）全在 extension 重建矩阵已有能力内；落 entry 走 W16 官方通道；「extension 是 subagent/workflow 数据 owner」治理原则不破 | 低中：分支 4 加一段子文件末行读取 + reportRecordTransition 调用；reportRecordTransition 在 session_start 语境 pi 已注入（session_start 晚于扩展构造） | 子文件末行判定语义（「正常收尾」的判据）需要严谨定义；重建矩阵是 perf 敏感路径（现有 dir mtime 快路径），新增读取要限量（仅分支 4 且仅 light 路径需要的文件） | ✅ 选 |
| B. runtime extractor 投影（scan 层对 running record 读 .alive/pid/子文件） | 低：runtime 读 extension 私有 sidecar = 新跨边界耦合，违背 data-source-governance「subagent/workflow 权威 = extension 自描述 entry」的登记治理；且 scanSubagentEntries 是纯函数（entries[] 输入），挂 IO 需改签名 + 两条通路（实时/冷启动）分别接线 | 中：pid 探活 + 子文件读取 + 路径推导在 runtime 重写一遍（extension 已有的 alive-store/重建逻辑重复） | 纯函数性破坏后测试面膨胀；两个进程各自判定「进程死没死」可能不一致（新建时序竞态） | ❌ |
| C. 接受现状（孤儿永远 running） | 低：不满足目标 2；v11 验收场景 7 永挂 | 零 | 无 | ❌（仅作对照） |

**方案 A 的判定语义**（子 session JSONL 末行 → 终态；判据是**机械可解析的**，不依赖 entry 语义类型。前提事实（R4-MF1）：分支 4 的 record 由 `readdirSync` 扫描发现——被扫描的文件**必然存在**，「文件不存在」在分支 4 内不可达，不作判据）：

- 末行可完整 `JSON.parse`（任意 entry 类型——assistant 消息 / tool_result / custom 均可）→ **closed(done)**——子进程以完整 JSON 行收尾 = 正常退出，任务有产出；
- 末行 JSON.parse 失败（截断行）→ **closed(error)**——保守终态，错误方向安全；
- 文件不可读（IO 错误：磁盘故障等）→ 不判终态，落 **running + resumable=true**——IO 错误可能是暂时状态，判终态不可逆；「等续聊」方向保守，下次重开重判（resumable 形态无 sidecar 锚，重复判定无害）。**可达性注（R5-MF）**：该分支是防御性路径——上游 identity 发现阶段（readIdentityHeader 的 openSync）在同款 IO 错误下已把 record 排除（负缓存），常规操作中难有「identity 可读而末行读取失败」的可行触发手段；验收以单测注入（mock 读末行抛错）覆盖，不设 E2E 场景。

「正常收尾」判据的边界说明：子 session JSONL 的每行在子进程正常写入时是完整 JSON（pi appendFileSync 同步写整行），因此判据只看「末行是否完整可解析」，不检查 entry 类型（子进程被 SIGTERM 时末行可能是 tool_result 而非 assistant——只要行完整即视为正常收尾；SIGTERM 死法下任务产出是否完整属业务语义，超出机械判据范围，V1 探针实测该死法的末行形态）。唯一截断窗口是子进程写入中途被 kill——该窗口内父已死、子也死，判 error 方向正确。

**已知边界（子文件被外部删除）**：子 JSONL 被删除后不在 `readdirSync` 扫描集 → 扩展重建不可见该 record（/subagents 列表不显示）；主 JSONL entry 仍在 → 侧栏（读 entry）维持该 record 最后 entry 状态（如 running）直到显式 close。外部删除文件超出系统可控范围，接受不收敛；GC 删除场景（30 天 TTL）的未来收敛（GC 删除时补写终态 entry）列为后续增强，不在本设计范围。

**重复落盘幂等**：reportRecordTransition 同一 record 多次 append entry 是 W16 既有语义（同 id 后到覆盖，消费方取最后一条）——重开 N 次落 N 条终态 entry 无害。

### 5.3 决策 3：执行态字段 `resumable` 进 W16 entry schema（可选字段，不升 v2）

`SubagentRecordEntryData` 加可选字段 `resumable?: boolean`（record-entry.ts schema；同时 SubagentRecord 加同名字段供 runtime 投影透传）。语义：`true` = 该 record 无活进程驱动、处于「可续聊/等续聊」态。写点：

- 重建矩阵分支 4 兜底且不判终态时 → `resumable: true`；
- 轮终迁移（doFinalizeRoundToIdle）→ `resumable: true`（与 result 字段同写点，语义统一：「running + resumable = 无进程驱动的 running」）；
- 新生 register / 冷路径续轮（进程启动）→ 不写（缺省 falsy = 有进程）。

方案对比（摘要）：升 schema v2（版本号+1）会被旧 runtime「不认识跳过」导致整条 entry 丢弃——不可取；可选字段 + 防御式逐字段消费是 W16 已验证的向后兼容模式（runtime scanSubagentEntries 对未知字段自然忽略）。`resumable` 与既有 `result` 的分工：result 是「上一轮产出」（详情面板/working 判定用），resumable 是「当前是否有进程驱动」（streaming/waiting 视觉用）；两者常同时为真（轮终）但孤儿无 result 时 resumable 单独可用。

### 5.4 决策 4：UI 细分用渲染层判据，不改 shared 枚举（方案对比）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|--------------|-------------|------|------|
| **a. 渲染层判据（SubagentList.vue 四形态判据，见下方细化表：streaming / waiting（chat 轮终 + 孤儿兜底）/ done（one-shot 轮终））** | 中高：判据数据已/将随 entry 到位；hasRunning 先例（result 判据）同款模式；不改 shared 枚举契约 = 零版本协调 | 低：一个组件的模板与 statusDotClass 分支 + store 一处窄口径函数对齐 | 判据散落组件层（若未来第二个消费点需要同样细分，需抽 composable——登记为已知边界） | ✅ 选 |
| b. SubagentStatus 枚举扩 6 态（v11 原方案：streaming/waiting 拆分） | 中：语义更显式；但触 shared 契约 + extractor 投影 + 全部消费点（SubagentList/SubagentTab/hasRunning/isRunning/isStreamingSubagent）+ 与 W16 schema 的 status 字段（扩展 ExecutionStatus：running/closed）映射层 | 中高：跨 3 包 6 文件 + 测试面 | 枚举迁移期新旧值并存的心智负担；v11 该方案的前提（bg-notify 状态不可靠）已消失 | ❌（列后续项：若 UI 细分需求扩展再启动） |

方案 a 的判据细化（**四形态**，判据数据 = result（已有）+ resumable（本设计新增）+ chatMode（本设计新增，见 §6.2）。**下方等价公式是权威判据**，表是简化展示）：

| 行 | entry 事实 | UI 投影 | 依据 |
|----|-----------|---------|------|
| 1 | running + result 无 + resumable 非 true（chatMode 任意） | streaming（spinner + 取消按钮） | 真在跑（进程驱动中）——chat 首轮进行中、one-shot 进行中都在此行 |
| 2 | running + chatMode = true + (resumable 或 result 有) | waiting（静态圆点，无取消按钮） | chat 轮终等续聊——用户可能续聊，续轮后恢复 streaming |
| 3 | running + result 有 + **chatMode 显式为 false** | done（静态对勾样式） | one-shot 已完成、结果已注入；resume 仍可用（sessionFile 在，与 status 解耦） |
| 4 | running + 其余（未被行 1/3 命中的组合——孤儿 IO 错误兜底 + chatMode 缺省的 legacy 轮终） | waiting | 兜底行：无法确认「真在跑」或「确认完成」的一切 running 形态，等续聊方向保守 |

等价公式（renderer 实现口径，无分支重叠）：

```ts
isStreaming = record.status === 'running' && record.result === undefined && record.resumable !== true
isDone      = record.status === 'running' && record.result !== undefined && record.chatMode === false  // 显式非 chat 才宣告完成
isWaiting   = record.status === 'running' && !isStreaming && !isDone   // 兜底行：chat 轮终 + 孤儿 IO 兜底 + legacy 轮终
```

**chatMode 缺省（undefined）的过渡期语义（R4-MF2，显式声明）**：本设计实施前的存量 entry 无 chatMode 字段（append-only 不回填）——缺省时 isDone 恒 false，落 isWaiting 兜底。效果：存量 chat 轮终（预期 waiting）正确；存量 one-shot 完成（预期 done）误显示 waiting，直到该 record 下次迁移写入带显式 chatMode 的新 entry。这是有意的保守方向：**无法确认不是 chat → 不宣告完成**（「显示 done 实际在等续聊」的误导重于「显示 waiting 实际已完成」——后者用户 Resume 或查看 result 即可探明）。实施后所有新 entry 均带显式 chatMode（register 起写入）。

closed/终态 record 不满足 `status === 'running'` 前提，三函数均返回 false，维持现有 closed 映射不变。

方案 a 的视觉映射（太极纯灰设计语言内）：waiting → 静态圆点（复用现有非 running 态样式），不转圈、不显示取消按钮（取消一个没有进程的 record 无意义）；streaming → 维持现有 spinner + 取消按钮；done（one-shot 轮终投影）→ 复用现有 done 样式。

---

## 6. 实现机制（把终态落到代码层）

**本章结论：extension 四处 + 四类型字段矩阵与两投影函数 + renderer 一处 + runtime 两行透传 + 注释修正一处；字段链路（类型加字段 → 投影函数 → extractor 透传 → renderer 消费），无逻辑性架构改动。**

### 6.1 Extension（`extensions/subagent-workflow/src/`，四处改动）

1. **恢复循环落盘**（index.ts:467-475）：`transition` 后补 `await store.save(run)`，逐 run try/catch，失败记 error 日志不阻断循环。
2. **重建矩阵分支 4 增强**（record-store.ts）：
   - **接线点**：`RecordStore.collectRecords`（:342-398，公开方法）内部——`reconstructAll`（:350）返回后、merge 内存源之前，对本次重建落入分支 4 的 record 执行判定与落盘。前提已核实：`initSession`（subagent-service.ts:315-320）设 `store.setPi(pi)`，任何 collectRecords 调用时 pi 必已注入。分支 4 的判定逻辑放 `buildRecord`（:816-846）判定处收集（分支 4 命中集），落盘动作在 collectRecords 收尾集中执行（避免逐文件 IO 散落）。
   - **触发时机（新增）**：现状 collectRecords 首次调用发生在 renderer 请求列表时（非 session_start 期间）——孤儿收敛若依赖「有人调 /subagents 工具」则时机不可控。本设计在 index.ts session_start 恢复段（与 workflow 恢复循环同位置）**主动调用一次** `store.collectRecords()` 触发判定——收敛时机 = 重开 session（与验收场景 2 对齐）；此后常规列表请求的 collectRecords 幂等（见下）。
   - **判定与落盘（防重设计）**：分支 4 兜底时读子 session JSONL 末行，按 §5.2 三条机械判据处理：
     - 判得终态（done / error）→ **复用既有收尾机制**：`completeRecord(record, result, "closed", reason)` + `writeFinalized` sidecar + `archive(record)`——与 `doFinalizeRecord`（finalize-record.ts:99-116）完全同构（孤儿收敛 = 父死后补跑一次正常收尾）。archive 落终态 entry；**sidecar 是防重关键**：下次 collectRecords 重建时该 record 走分支 2（`.finalized` → closed）不再进分支 4，不重复判定、不重复 append。closedReason 语义注：分支 2 重建映射为 gc——extension 内存态的 reason 细分丢失，但 entry 内 status=closed + result/error 字段保留 done/error 细分（renderer 读 entry，不受影响），可接受。
     - 不判终态（文件不可读——IO 错误，可能暂时）→ record 保持 running + `resumable=true` + 落 entry。**签名适配（R5-SG1）**：`reportRecordTransition` 收 `ExecutionRecord`（record-store.ts:271），分支 4 数据源是重建的 `SubagentRecord`——需在 RecordStore 新增接受 SubagentRecord 的入口（内部直接 `pi.appendEntry(SUBAGENT_RECORD_CUSTOM_TYPE, toSubagentRecordEntry(record))`，绕过 recordToSubagent），或构造最小 ExecutionRecord 桥接；取前者（类型干净）。防重：resumable 形态会重落 entry，fast-path 缓存（dir mtime 未变不重入分支 4）结构性限频（appendEntry 写主 JSONL 不改子目录 mtime），实际频率 ≈ 重开次数 + dir mtime 变化触发的全量重扫（同 id 覆盖无害，R5-SG2）；IO 恢复后重开可重判终态。
   - perf 边界：新增 IO 仅限分支 4 命中的文件（每文件一次末行读取）；分支 4 命中集 = 无 sidecar 或 pid 死的存量——不触碰 dir mtime 快路径的缓存语义（读取发生在快路径判定之后）。
3. **轮终迁移补 resumable + chatMode 进链路**（finalize-record.ts doFinalizeRoundToIdle）：与 result 同写点写 `resumable: true`；冷路径续轮（subagent-service.ts:815-817 现有 `record.status = "running"` + `reportRecordTransition` 处）**新增** `record.resumable = undefined`（清除——进程启动 = 有驱动 = 非 resumable）后再 reportRecordTransition。chatMode 字段进 entry schema 见 §6.2。
4. **注释修正**（subagent-service.ts:952/963）：「标记为 idle」改为与代码一致的「标记为 running（可续聊）」。

### 6.2 类型定义（extension 两类型 + shared 一类型 + entry schema，四类型字段矩阵）

新字段 `resumable?: boolean`（`true` = 无活进程驱动、处于「可续聊/等续聊」态）与 `chatMode?: boolean`（chat 与否——§5.4 四形态判据的区分字段。**链路现状**：extension `ExecutionRecord.chatMode`（types.ts:373）存在但不在 entry schema；`ExecutionMode`（entry schema 已有的 `mode` 字段类型）值域恒 `"background"`（types.ts:80，sync 模式删除后无区分度）——**不能**用 mode 判 chat/one-shot（R2-MF1））。

字段 × 类型矩阵（R6-MF1——四处类型**全部**要加，缺一则对应写点编译失败或投影遗漏）：

| 类型 | 位置 | 加 resumable | 加 chatMode | 缺则 |
|------|------|-------------|------------|------|
| `ExecutionRecord`（extension 内存 record） | types.ts:345-474 | ✅ | 已有（:373） | 轮终 `record.resumable = true`（§6.1.3）编译失败 |
| `SubagentRecord`（**extension 侧同名类型**，非 shared） | types.ts:668-716 | ✅ | ✅ | `recordToSubagent` 投影（§6.2 投影函数）写多余属性报错 |

（R7-SG1 行号修正：曾误引 590-607——那是 `SubagentListItem`（TUI 列表类型，:602 已有 `resumable?` 同名字段先例，语义一致、同名共存不冲突）；真正的 extension SubagentRecord 在 668-716。）
| `SubagentRecordEntryData`（entry schema） | record-entry.ts:38-77 | ✅ | ✅ | `toSubagentRecordEntry` 投影编译失败，entry 层永远无两字段 |
| `SubagentRecord`（shared） | packages/shared/src/subagent.ts | ✅ | ✅ | extractor 逐字段守卫赋值（§6.4）编译失败，renderer 拿不到判据 |

两个新字段的**投影函数改动（R3-SG2，字段链路闭环的必要环节，缺则字段永远为空）**：

- `toSubagentRecordEntry`（record-entry.ts:80-108，entry 写入唯一出口——register/archive/reportRecordTransition 全经此）：补 `resumable: record.resumable` + `chatMode: record.chatMode`；
- `RecordStore.recordToSubagent`（record-store.ts:902-930，内存源投影，collectRecords merge 用）：补同款两字段。

不改 SubagentStatus 枚举。链路：四类型加字段 + 两投影函数（本节）→ extractor 透传（§6.4）→ renderer 消费（§6.3）。

### 6.3 Renderer（两处改动：`SubagentList.vue` + `stores/subagent.ts`）

改动清单（两文件并列，均为必做）：

- **SubagentList.vue**：四形态判据（§5.4 等价公式）三具名函数（isStreaming/isDone/isWaiting 兜底）；模板 43/57 行的 spinner/cancel 分支改用 isStreaming；statusDotClass 补 waiting / done（轮终投影）档。
- **stores/subagent.ts**：窄口径 `isStreamingSubagent`（:158-161，虚拟 session forceWorking 用——现判据 `running && result === undefined` 不检查 resumable）同步补 `resumable !== true`——否则孤儿（resumable + 无 result）在 SubagentList 显示 waiting、在虚拟 session 却 forceWorking streaming，两处口径分叉。`isRunning`（宽松口径，SubagentTab 订阅流用）不动——resumable 续轮仍有真实流活动，收紧会断数据通路（基线注释已论证）。

判据实现为组件/store 内具名函数（非内联三元），供测试与未来抽 composable。chatMode 字段链路见 §6.2（entry schema + shared 加字段 + 两个投影函数）与 §6.4（extractor 透传）。

### 6.4 Runtime（`subagent-extractor.ts` 仅两行字段透传，无逻辑改动）

`scanSubagentEntries` 的 `collectSelfDescribedSubagentRecords` 逐字段守卫补两行（与 `result` 同款防御式守卫模式）：

```ts
resumable: typeof d.resumable === 'boolean' ? d.resumable : undefined,
chatMode: typeof d.chatMode === 'boolean' ? d.chatMode : undefined,
```

派生/投影/发布逻辑零改动——本设计在 runtime 侧的全部工作就是让 §6.2 新增的 shared 字段从 entry 流到 renderer（§6.2 → §6.4 → §6.3 链路的中间环）。

---

## 7. 验收（真实场景，非单测非 mock）

**本章结论：改动规模小（extension 为主），4 个真实场景 + 1 项回归，全部 E2E real 形态（Playwright 连 dev app 或 pi CLI 直连，按项目测试指南）。**

前置：fix-chat-flow-order 已合入；`pnpm dev` 起真实应用；准备真实 session（含 subagent/workflow 历史）。extension 改动先行经本地 pi CLI 实测（`pi --mode rpc --session-dir <dir> --approve --extension <源码路径>`，stdin JSONL 驱动），再进桌面 E2E。

| 场景 | 回溯目标 | 真实流程 | 通过标准 |
|------|---------|---------|---------|
| 1. workflow kill -9 恢复收敛 | 目标 1 | 起 workflow run（running 中）→ `kill -9` pi 进程 → 重开该 session | Flows tab 秒级显示 failed；主 session JSONL 末条 workflow-record entry 含 done/failed；重开后无自发 LLM turn（日志无未经输入的 agent_start） |
| 2. subagent 孤儿终态（已跑完形态） | 目标 2 | 起 background subagent（短任务）→ `kill -9` 父 pi → 等子进程自然结束（轮询 pid 消失，60s 超时兜底）→ 重开 session | Agents tab 显示 done（非 running）；主 JSONL 该 record 末条 subagent-record entry 为终态；子 session JSONL 末行正常收尾与之对应 |
| 3. subagent 孤儿（截断形态） | 目标 2 | 同场景 2 前置，重开前对子 session JSONL 末行 append 半行 JSON（制造截断）→ 重开 | Agents tab 显示 error（非 running）；entry 为终态（closed，error 语义）；IO 不可读分支（§5.2 第三条）以单测注入覆盖，不设 E2E 场景（可达性注见 §5.2） |
| 4. 等续聊/完成细分回归 | 目标 3 | conversation:true 起 subagent → 一轮完成 → 观察侧栏；续聊一轮再观察。另跑 one-shot subagent 至完成。最后打开一个改造前的存量 session（entry 无 chatMode）观察其已完成 record | chatMode：等续聊期间静态圆点（不转圈、无取消按钮），续聊后恢复 spinner；one-shot：完成后显示 done 样式（非转圈）；legacy 存量完成 record 显示 waiting（§5.4 过渡期语义，显式断言防误判为 bug）；session working 态与 hasRunning 语义不回退 |
| 5. 既有链路回归 | 全部 | 跑 v11 验收场景 1/2 的合流等价物（并发 subagent 终态收敛 / 历史列表不回退） | 行为与合流前基线一致（W16-W18 已解决的 F1/F2/F5 不因本改动回退） |

单测（vitest，extension 目录跑）：分支 4 三条判据的 fixture 化用例（正常收尾/截断/IO 错误注入 mock）、resumable 字段写入点、恢复循环 save 调用与失败不阻断——作为回归辅助，不计入验收。

### 7.1 验收记录（2026-08-20 E2E real 实测，全部通过）

实测环境：本 worktree `pnpm dev`（dev 数据目录 `~/.xyz-agent-dev`）+ Playwright 连 9222；模型 MiMo-V2.5-Pro（xiaomi token plan 的 mimo-v2-pro 已被 API 下架，HTTP 400 "Unsupported model"，实测换 v2.5-pro）。

| 项 | 结果 | 实测证据（节选） |
|----|------|----------------|
| 场景 1 workflow kill-9 | **通过** | chain 工作流运行中 kill -9 父 pi → 重开 session：恢复段落 workflow-record entry（state.status=done + reason=failed，U1 store.save 生效）；无自发 LLM turn（pi 日志 agent_start 均对应用户 prompt） |
| 场景 2 孤儿 done 形态 | **通过** | sleep-90 后台 subagent 运行中 kill -9 → 重开：Agents 卡片 bg-success；entry = closed+gc；子文件末行完整（实测修正：子进程经 stdio 管道 EOF **级联死亡**，并非「等子进程自然结束」——但 pi 整行写保证末行完整，判 done 语义不变） |
| 场景 3 孤儿截断形态 | **通过** | 同上前置 + 对子文件 append 半行 JSON → 重开：卡片 bg-danger；entry = closed+gc+error "orphan recovery: … (truncated last line)"；13s 内收敛 |
| 场景 4 四形态细分 | **通过** | one-shot 完成 → bg-success；chat 轮终 → bg-accent 静态点+无取消按钮（waiting）；续聊 → spinner+取消按钮恢复（entry 序列：轮终 result=Y round=1 → 轮始 result 清除 → 轮终 round=2）；legacy 存量（entry 无 chatMode）→ waiting 兜底 |
| 场景 5 既有链路回归 | **通过** | 3 并发 subagent 全部收敛；4 个 session 跨多次应用重启历史列表/记录稳定不回退 |
| V1 | **通过（抓出并修复真 bug）** | 4822 个真实子文件：0 个真截断（pi 整行写可靠，SIGTERM/EOF 死法末行均完整）；**28 个（0.58%，Stock cwd）末行为 65KB-776KB 完整 entry（subagent-identity 内嵌大 task）——固定 64KB 尾窗从行中间切开全部误判截断**。修复：找不到末行边界时按 ×4 指数扩窗（c0e045e7b）。设计 fallback（判据降级）不需要 |
| V2 | **通过** | 恢复在 session_start 同步段完成：打开 session 即触发 pi spawn + switch_session → 恢复 entry 立即落盘（无需用户发 prompt） |
| V3 | **通过** | record-store.test.ts 全文件 37ms（50 用例含 4 孤儿用例），无 perf 回归 |
| V4 | **通过** | 收敛路径实测：冷投影（runtime entry 扫描）即时 + 恢复 entry 落盘后秒级刷新；最快路径 = 打开 session 即收敛 |

**E2E 抓出并修复的 5 个实现层 bug**（单测盲区，均已加回归用例或注释锚定）：

1. **64KB 尾窗误判**（V1，c0e045e7b）：见上表 V1。
2. **recordToSubagent 丢 chatMode/resumable 投影**（f67246386）：三处 W16 appendEntry 入口共用的内存投影函数漏投影两字段 → 真实 JSONL entry 恒缺 chatMode → renderer isDone（需显式 false）恒不成立，完成态 one-shot 永远显示 waiting。单测 schema 断言作用在内存捕获对象上（undefined 值键名仍在）而漏检——已改为 **JSON 序列化后断言**（对齐生产行为）。
3. **chat 热路径轮终不落 entry + 轮始不清信号**（08624246f）：onRoundSettled（chat 轮终唯一真实路径）不经 doFinalizeRoundToIdle（runAndFinalize 恒 early return，MF-2 原写点不可达）→ 轮终只改内存不 appendEntry → waiting 形态永远显示不出、spinner 卡死；且续轮开始不清上一轮 result → spinner 无法恢复。修复：轮终显式 reportRecordTransition + 热/冷两路径轮始清 result/resumable 并上报。
4. **entry-born 孤儿（spawn 窗口期死亡）不可收敛**（6487e6021）：register entry 已落主 session、子文件未创建即父死（实测 kill -9 落在 spawn 后 2s 命中）——目录扫描看不见、恢复判不到、侧栏（runtime entry 源）永久 spinner。R4 的「文件不存在不可达」证明只覆盖目录扫描源。新增 `recoverEntryOnlyOrphans`：读主 session entry，对「末条 running 且无子文件锚且非内存活 record」收敛（chatMode → resumable；否则 closed+gc+error）。外部删除子文件的已知边界同路径收敛。
5. **主 session 文件定位两层错误**（a25a6241d/807da87c9/800883d05）：① attach 场景 `ctx.sessionManager.getSessionFile()` 返回**前一 session** 的文件 → 改按 sessionId 从 sessions 目录解析（文件名约定 `<ts>_<sessionId>.jsonl`）；② jiti 多实例分裂下闭包缓存（cachedMainSessionFile）不跨实例——resolver 写实例 A 闭包、恢复读实例 B（滞后一个事件，ENOENT）→ 改为 **initSession 按值直传**。代码库对 jiti 分裂已有 globalThis 单例先例（channelRegistry 注释），闭包缓存是同类陷阱。

**登记的存量缺口（非本次范围）**：runtime session pool 对被 kill -9 的 pi 不 respawn——应用存活期间该 session 新 prompt 报 "pi process is not running"（僵尸 session），重开等价于应用重启后冷启动（本验收的场景路径）。属 runtime 层健壮性，另行立项。

## 8. 下一层拆分（wave）

| 单元 | 内容 | 独立验收 |
|------|------|---------|
| U1 | 恢复循环 save（决策 1，~5 行 + 逐 run catch，index.ts） | 场景 1 |
| U2 | 孤儿终态兜底全链路（决策 2/3）：§6.1.2 分支 4 三判据 + session_start 触发 + 签名适配（extension record-store/index.ts）**+ §6.2 四类型字段矩阵与两投影函数（extension types.ts + record-entry.ts + record-store.ts + shared subagent.ts）+ §6.4 extractor 两行透传（runtime subagent-extractor.ts）**——跨 extension/shared/runtime 三包，字段链路四类型必须同一单元落地（拆开则中间态编译失败） | 场景 2/3 |
| U3 | 渲染细分（决策 3/4 的消费端，四处改动跨两文件）：§6.1.3 轮终写 resumable + 冷路径续轮清 resumable（extension finalize-record.ts + subagent-service.ts）；§6.3 SubagentList.vue 四形态判据 + stores/subagent.ts isStreamingSubagent 对齐（renderer）——依赖 U2 的类型字段先行 | 场景 4 |
| U4 | 注释修正 + 回归（场景 5） | 场景 5 |

U1 与 U2/U3 无依赖可并行；U2 先行（类型字段），U3 依赖 U2 的类型定义；U2/U3 合并覆盖决策 3 的全部写点（轮终/续轮/重建三处）。

## 9. 待验证检查点

| # | 检查点 | 验证方式 | 不成立时退路 |
|---|--------|---------|-------------|
| V1 | 子 session JSONL 正常收尾时末行为完整 JSON（pi appendFileSync 整行写） | 实测若干真实子文件（含正常退出与 SIGTERM 两种死法） | 若 SIGTERM 死法普遍截断且误判 error 不可接受 → 判据降级为「文件存在即 done，仅解析失败才 error」 |
| V2 | session_start 恢复段主动 collectRecords 时 `setPi` 已注入（store.pi 可 appendEntry）；恢复段与 `initSession`（subagent-service.ts:315-320）的先后顺序 | pi CLI 直连实测：重开含孤儿 record 的 session，断言 session_start 期间终态 entry 已落 | 时序不成立则判定延迟至首次列表请求（collectRecords 常规调用）——收敛仍在「重开后」边界内，记录实际时序 |
| V3 | 重建矩阵分支 4 的新增读取不破坏 dir mtime 快路径性能 | 现有 perf 测试基线对照（record-store.test.ts） | 超基线则分支 4 读取改惰性（仅 listResponse/overlay 打开时判） |
| V4 | runtime 派生缓存对重开 session 的首次失效时机（entry_appended 在 session_start 恢复落 entry 时是否已订阅） | 场景 1/2 实测侧栏收敛时间 | 迟到则依赖冷启动 RPC 首拉（用户切 tab 时拉取）——收敛仍在「重开后」边界内，记录实际时序 |

---

## 附录 A：v11 设计决策裁决对照（历史追溯，实施不依赖）

| v11 决策 | 裁决 | 依据 |
|---------|------|------|
| 决策 1（无状态信号+重拉，方案 B） | **已被等效实现** | W18 派生缓存：唯一写路径 = entry 扫描、事件只做失效、可丢弃重建。机制差异（协议零改动 vs 新 transient 类型）是实现选择，目标一致 |
| 决策 2（session.subagentsChanged 协议） | **作废** | entry_appended 官方事件替代自建信号；session.subagents 全量帧协议保留但数据源已换 |
| 决策 3（三对账点） | **大部分被替代；重连项缺口经对审确认后已补显式重拉** | 失效自愈（Entry-not-found 全量重建）+ 冷启动磁盘扫描承接兜底；message.complete/session.exited 对账点由派生缓存事件驱动等效覆盖。**重连项**（2026-08-20 设计-实现对审闭环）：合流后确认真实缺口——重连后若无新 entry 写入（如断连前 subagent 已全部终态），派生缓存不刷新，侧栏停留断连前 stale 数据直到用户切 tab。修复：renderer `useSidebar.onConnected` 重连分支对聚焦 session 显式 `loadSubagents`/`loadWorkflows`（RPC 直读磁盘，不依赖缓存事件），fire-and-forget 与 workspace/extension 重连刷新同模式；测试 useSidebar.test.ts TC-5/TC-5b |
| 决策 4（秒级信号与 60s 窗口解耦） | **已被实现** | 300ms 防抖 + get_entries 增量，不经 notifier |
| 决策 5（六级投影 + 6 态枚举） | **前提消失，子集保留** | 自描述 entry 正向携带 status/sessionFile → sidecar 链/identity-id 消歧/timestamp 锚全部作废；保留子集 = 本设计缺口 ②（孤儿终态，挂点从 runtime extractor 改 extension 重建矩阵）与 ③（细分，用字段而非枚举） |
| 决策 6.1（workflow kill-9 落盘） | **保留，本设计缺口 ①** | 合流分支未实现 |
| 决策 6.2（无 turn 恢复通知） | **被结构性消解** | appendEntry 不带 triggerTurn，save 即通知 |
| 决策 6.3（A10 轻量事件探针） | **作废** | entry_appended 即轻量事件，A10 探针的全部候选裁决不再需要 |
| 决策 7（性能边界） | **改写** | 对账读负载已被增量游标（cursor）结构性优化；本设计新增负载仅限 V3 的分支 4 读取 |

## 附录 B：变更历史

- v1：初稿。基于 2026-08-20 对 fix-chat-flow-order HEAD（3af2baa71）的代码核查（W16/W17/W18 机制、恢复循环、重建矩阵、result 字段链路、renderer 消费面均已 read 核实）与两轮 subagent 实现-状态对抗核查结论。
- v2：按 R1 对抗审查（2 must-fix / 2 suggestion / 2 info，报告 `subagent-workflow-post-merge-residual-fixes-review.md`）修复：① mode 字段链路闭环（§6.2 补 `SubagentRecord.mode` 声明——该字段曾被显式移除、entry schema v1 始终携带，renderer 三形态判据的必要前提；§6.4 补 extractor 透传行并修正「runtime 零改动」的不实标题）；② §3.2 行号精确化（四分支实现点 = buildRecord :816-846，原引 :440-470 是 JSDoc）+ entry 写入口完整描述（5 处：register/archive 内部 appendEntry + reportRecordTransition 自身 + 2 外部调用点，原「仅 2 处」易误导）；③ §5.2 判据措辞精确化（「末行可完整 JSON.parse」不限 assistant 类型，机械判据）；INFO 两条为核实确认（注释矛盾识别正确、V4 待实测标记合理），无文档动作。
- v3：按 R2 对抗审查（3 must-fix / 1 suggestion，报告 `subagent-workflow-post-merge-residual-fixes-review-r2.md`）修复：**① 判据字段反转（R2-MF1，v2 的 mode 方案被证伪）**——`ExecutionMode` 值域恒 `"background"`（types.ts:80）无区分度，三形态判据改用 `chatMode?: boolean`（ExecutionRecord:373 存在但不在 entry schema/shared/extractor，全链路补入：toSubagentRecordEntry 投影 + §6.2 + §6.4 透传 + §5.4 判据表；legacy 缺省按非 chat 处理）；MF-2（ExecutionMode 未在 shared 定义）随字段替换自然消解。**② 接线点具体化（R2-MF3）**——分支 4 落盘接线点明确为 `RecordStore.collectRecords`（:342-398）内 reconstructAll 返回后，**新增触发时机**：index.ts session_start 恢复段主动调用一次 collectRecords（现状首次调用在 renderer 请求时，收敛时机不可控）；**防重设计**：终态判定复用 doFinalizeRecord 同构收尾（completeRecord + writeFinalized sidecar + archive）——sidecar 使下次重建走分支 2 不再重判，消除重复 append（resumable 形态无终态锚，每次重开重落一条，同 id 覆盖无害）。③ 冷路径续轮清 resumable 标注为新增行为（R2-SG）。V2 检查点更新为 setPi 注入时序实测。
- v4：按 R3 对抗审查（2 must-fix / 2 suggestion，报告 `subagent-workflow-post-merge-residual-fixes-review-r3.md`）修复：**① 判据矩阵补第四形态（R3-MF1）**——三形态表遗漏孤儿兜底（running + resumable + 无 result + 非 chat 不命中任何行会落 streaming 转圈，与场景 B/§6.1 矛盾），判据表扩为四行并公式化（isStreaming/isDone 显式 + isWaiting 兜底，先命中先停消除行间重叠歧义，R3-MF2 一并解决）；§5.2 方案 a 概述对齐四形态口径。**② 投影函数闭环（R3-SG2）**——§6.2 补 `toSubagentRecordEntry`（entry 写入唯一出口）与 `recordToSubagent`（内存源投影）两处补 resumable/chatMode 投影行（缺则字段恒空）。**③ 窄口径对齐（R3-SG1）**——§6.3 补 `isStreamingSubagent`（虚拟 session forceWorking）同步加 `resumable !== true`，消除 SubagentList 与虚拟 session 两处口径分叉（isRunning 宽松口径不动，订阅流依赖）。
- v5：按 R4 对抗审查（2 must-fix / 3 suggestion，报告 `subagent-workflow-post-merge-residual-fixes-review-r4.md`）修复：**① 「文件不存在 → resumable」判据被证伪（R4-MF1）**——readdirSync 扫描集决定分支 4 内文件必然存在，「文件不存在」不可达；判据改三条（完整 JSON → done / 截断行 → error / 文件不可读 IO 错误 → resumable 保守，IO 可能暂时）；「子文件被外部删除」登记为已知边界（扩展重建不可见、侧栏 entry 兜底维持最后状态，接受不收敛）；场景 3 重写为可执行形态（chmod 000 / 末行截断双分支断言）。**② chatMode 缺省误判（R4-MF2）**——isDone 改需显式 `chatMode === false`（原 `!== true` 会让存量 chat 轮终误显示 done）；缺省落 isWaiting 兜底，「无法确认不是 chat → 不宣告完成」为显式过渡期语义（存量 one-shot 完成显示 waiting 直到下次迁移写入显式值，保守方向声明）；场景 4 补 legacy 存量断言。③ 表注「公式为权威判据」+ 场景 C 条件补全（SG1）；公式补 closed 边界声明（SG2）；§6.3 改两文件并列清单（SG3）。
- v6：按 R5 对抗审查（1 must-fix / 2 suggestion，报告 `subagent-workflow-post-merge-residual-fixes-review-r5.md`）修复：**① chmod 000 分支被证伪（R5-MF）**——EACCES 发生在上游 identity 发现阶段（readIdentityHeader openSync），record 从列表消失而非进分支 4，场景 3 的 chmod 分支不可执行；删之，场景 3 只留截断分支；IO 错误判据（§5.2 第三条）保留为防御性路径并加可达性注（常规操作无可行触发手段，验收以单测注入覆盖）。② reportRecordTransition 签名适配（R5-SG1）——签名收 ExecutionRecord 而分支 4 数据源是 SubagentRecord，§6.1 补新增 SubagentRecord 入口方法（内部直接 pi.appendEntry 绕过 recordToSubagent）。③ 防重频率补 fast-path 限频说明（R5-SG2）——dir mtime 快路径结构性限频，实际频率 ≈ 重开次数 + 全量重扫，同 id 覆盖无害。R5 另核实 chatMode 链路自洽（one-shot 显式 false，isDone 判据对新 entry 有效）与四形态公式穷举通过。
- v7：按 R6 对抗审查（2 must-fix / 1 suggestion，报告 `subagent-workflow-post-merge-residual-fixes-review-r6.md`）修复：**① 类型字段矩阵补全（R6-MF1）**——§6.2 从两类型扩为四类型字段矩阵：extension `ExecutionRecord`（+resumable，chatMode 已有）与 extension 侧同名 `SubagentRecord`（+resumable+chatMode，recordToSubagent 投影目标）此前遗漏，缺则对应写点编译失败；shared 与 entry schema 原已覆盖。**② wave 拆分补全（R6-MF2+SG）**——U2 从「extension 侧」扩为跨 extension/shared/runtime 三包全链路（四类型必须同一单元落地，拆开中间态编译失败）；U3 补轮终/续轮两写点 + 冷路径清 resumable，措辞从「两点小改」改为四处两文件。R6 另核实：全文口径统一、旧术语残留清零、v1-v6 变更历史无矛盾。
- v8：按 R7 对抗审查（**0 must-fix** / 2 suggestion，报告 `subagent-workflow-post-merge-residual-fixes-review-r7.md`——**审查循环收敛：七轮后首次零 must-fix**，rubric P0-1~P0-18 全清单通过、自包含性与附录 A 一致性确认）收尾：矩阵行 2 行号修正（types.ts:590-607 是 SubagentListItem——TUI 列表类型，其 :602 已有 resumable 同名字段先例；真正的 extension SubagentRecord 在 668-716——R6 的「已核实」引用链曾把 SubagentListItem 误认成 SubagentRecord，R7 复检纠正）；U3 措辞确认 v7 已修（N/A）。R7 另核实：分支 4 可经 rec.sessionFile 定位子 JSONL（buildRecord 两路均透传）、session_start 主动触发可行（collectRecords 在 initSession :384 后任意时点可调）、轮终/续轮两写点的补字段位置（finalize-record :244 前 / subagent-service :813 前）精确成立。
- v9（合流后，2026-08-20）：设计-实现对审（双 subagent 对抗审查 residual-fixes 与 v11 两份设计 vs 代码，0 must-fix）后的收尾修复：**① 附录 A-3 重连项闭环**——对审确认真实缺口（重连后无新 entry 写入则派生缓存不刷新，侧栏停留 stale 直到用户切 tab），renderer `useSidebar.onConnected` 重连分支对聚焦 session 显式 `loadSubagents`/`loadWorkflows`（测试 TC-5/TC-5b）；开篇对照表决策 3 行同步。**② §3.2 事实修正**——分支 3 软超时实际 `ALIVE_SOFT_TIMEOUT_MS`=1h（monorepo 集成起即如此，自旧仓 24h 收缩），原文「<24h」为笔误。对审另报到一条「§5.2 可达性注 IO 推理混淆」经复核实为**误报**（readIdentityHeader 与 readLastJsonlLine 读同一子 session JSONL，「identity 可读而末行读取失败」窄窗推理成立，不改）。
