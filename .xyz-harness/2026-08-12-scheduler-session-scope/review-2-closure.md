# 修订闭环验证报告：pi-scheduler 修复设计（第二轮对抗式审查）

审查对象：`.xyz-harness/2026-08-12-scheduler-session-scope/design.md`（修订版）
对照基线：同目录 `review.md`（第一轮 3 must-fix）
验证方式：逐条推演 + 对照 `extensions/scheduler/src/` 源码（runtime.ts / store.ts / backend.ts / index.ts / service.ts / tool.ts / widget.ts / types.ts / parsing.ts / commands.ts）+ pi SDK 类型（session-manager.d.ts:140/205/208、extensions/types.d.ts:218）

## Verdict

**修订未完全闭环。** 第一轮 3 个 must-fix 中：M1 主路径、M2、M3 已闭环；但修订引入的新机制存在 **2 个新的 P0 级缺陷 + 1 个 P0 级规格缺口**：

1. **D3 复核"从内存移除" + D2 全量写回 = 复核失败方把他人任务从磁盘删除**（M1 缺陷类在迁移窗口原样复现，含 G3 数据丢失路径）；
2. **addTask 未声明为新任务写入 ownerSessionFile**（照设计实现则新建任务全部无归属，修复整体失效）；
3. **D7 未指定 tmp 文件名唯一性**（固定名 tmp 下并发交错写损坏原样复现，且 rename 使其永久化——D7 声称修复的缺陷没修掉）。

推演结论：按当前设计实施，S9 场景（并发接管）下磁盘任务会在"存在/不存在"间每 30s 振荡，owner 关闭后任务永久丢失；S1-S10 验收全部通过而缺陷存在。**必须修复上述 3 项后方可实施。**

## Summary

**3 must-fix, 3 suggestions.**

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 D3 | P0-12 副作用 / P0-10 | **复核失败"从内存移除该任务" + D2 全量写回 = 把他人任务从磁盘删除**。推演（迁移窗口，A、B 均接管无主任务 T，磁盘 owner=B）：A 复核失败→从内存移除 T→A 每 30s 的全量 persist（runtime.ts tickScheduler 末尾无条件 persist）写 `{A 的任务}`，T 从磁盘消失；B 的 persist 又写回——磁盘在 {T}/{} 间每 30s 振荡。**B（磁盘 owner）关闭后，A 的下一次 tick 把 T 永久删除**，B 的 session 文件仍在、resume B 后任务已不在磁盘——G3 破坏，与 M1 同根（全量写回 + 内存不全量）。且复核对"磁盘无此任务/读盘失败"（store.ts load catch 降级空 store）同样判"不符→移除"，瞬态读失败即可永久删任务。D2 声称的安全不变量"内存持全部任务→全量写回天然不丢任务"被 D3 打破，设计未察觉。 | 复核失败**不删内存**：将内存副本 owner 改为磁盘 owner（list/tick 过滤天然排除），仅跳过本次 dispatch，全量写回保持磁盘任务；读盘失败/任务缺失时保守跳过 dispatch、不动内存。删除只允许来自 owner 自身的 deleteTask |
| MUST_FIX | §3.3 D2 + §5 文件改动地图 | P0-12 遗漏 | **addTask 未声明写入 ownerSessionFile**。D2 只提"addTask() 配额只算自己的任务"；§5 runtime.ts 改动清单（listTasks/tickScheduler/dispatchTask/toggleTask/deleteTask/runTaskNow/getTask + addTask 配额）无一处声明创建时打 owner。照设计实现：新任务 ownerSessionFile 恒为空 → 同 cwd 后续启动的任何 session 在 loadTasks 时按迁移逻辑**接管**该任务 → F2/F3/F4 全部复现，修复整体失效（S3/S4 会抓到，但设计必须显式声明）。 | addTask 创建 task 对象时显式 `ownerSessionFile: this.ownerSessionFile`（含 D5 降级路径语义：无 owner 时保持 undefined） |
| MUST_FIX | §3.3 D7 | P0-12 副作用 | **tmp 文件名唯一性未指定**。若实现为固定名（如 `scheduler.json.tmp`）：两进程 writeFileSync 同一 tmp 仍交错 open/truncate/write（各自 fd 偏移独立，文件内容互相混合）→ tmp 损坏 → 后 rename 者把损坏内容**原子落盘**——D7 声称消除的"交错写损坏→全部任务丢失"在 tmp 上原样复现且被 rename 固化；另有 rename 竞态（A rename 走 B 刚写入的内容，B rename ENOENT 报错，A 的快照静默丢失）。 | 明确 tmp 名**每次写唯一**（`${storePath}.${pid}.${随机/计数器}.tmp`），并发写互不交错、各自 rename 原子、last-writer-wins 无损坏。同目录写已保证无 EXDEV（✓ 设计已写"同目录"） |
| SUGGESTION | §3.3 D3 + §4 S9 | P1-3 | **"收敛时间 ≤ 2 个 tick（60s）"表述错误**。复核移除只发生在任务**下次到期**的 dispatch 时：1h 间隔的 recurring 任务双持有持续整周期（期间无触发，无危害），不是 2 tick 内收敛。实际保证是"首次到期 ≤2 次触发、第二次到期起单触发"。S9 通过标准"第二/三轮 tick 后仅一个 session 持有"对正确实现也会误判失败（长间隔任务 2-3 tick 后双方仍持有）。 | 改为按到期次数表述："首次到期触发 ≤2 次且下次到期起仅 owner 触发"；S9 通过标准同步改写 |
| SUGGESTION | §4 S9 | P1-6 | **S9 缺磁盘持久化断言**（MUST_FIX 1 的回归场景）。S9 只查触发次数与持有方，不查 store 文件；复核失败方 persist 删任务、磁盘振荡时 S9 仍判通过。 | S9 增补：接管收敛后 cat store，任务必须仍在磁盘（含 owner 字段）；关闭失败方后任务仍存在且 winner 可触发 |
| SUGGESTION | §3.3 D7 | P1-6 | **无 fsync 说明**。rename 原子只保证命名空间一致，不保证断电持久性（原实现也无，非回归，可文档化）；rename 后文件权限 = tmp 创建时默认权限（umask→644），若 store 曾被 chmod 会丢失原权限（边缘）。 | README/注释注明"防并发损坏，非断电持久化保证"；权限敏感场景用 `fs.chmodSync` 继承旧文件 mode |

## 第一轮 3 个 must-fix 闭环验证

| 原 must-fix | 修订机制 | 闭环判定 | 证据 |
|---|---|---|---|
| M1：persist 全量覆盖互删任务 | D2 改"内存全量 + 方法层 owner 过滤 + 全量写回" | **已闭环（主路径）**，但被 D3 移除路径重新打开（见 MUST_FIX 1） | 全量加载（loadTasks 不过滤）+ 全量写回（persist 写 `Array.from(this.tasks.values())`）→ 双方任务均在内存，写回互不删除。S8 验收直击此点 ✓。**例外**：复核失败移除后内存不再全量，写回即删除——缺陷类复现 |
| M2：recurring 迁移窗口持续双触发 | D3 dispatch 前磁盘 owner 复核（readAllTasks）+ 不符移除 | **已闭环（机制正确）**，收敛表述有误（SUGGESTION） | 复核置于 dispatchTask 开头 = 唯一 dispatch chokepoint，**runTaskNow 也经 dispatchTask**（runtime.ts:85），两条 dispatch 路径全覆盖 ✓。复核使失败方在下次到期不再触发——持续双触发被切断 ✓ |
| M3：验收无法暴露缺陷 | S8（磁盘双方任务 + resume 回归 G3/G4）+ S9（并发接管触发次数）+ S10（subagent） | **已闭环（覆盖 M1/M2 主路径）**；S9 判定标准有两处瑕疵（SUGGESTION 1/2） | S8 直击 persist 互删（步骤含 cat store + 关 A resume A）✓；S9 直击并发接管 ✓；S10 覆盖 subagent persist 破坏方向 ✓ |

## 修订版其他声明核实

| design.md 声明 | 核实结果 |
|---|---|
| D1：SDK `ReadonlySessionManager` 含 getSessionFile/getSessionDir/getSessionId（dist/core/session-manager.d.ts:140） | ✅ 属实（d.ts:140/205/207/208）；`ExtensionContext.sessionManager: ReadonlySessionManager`（extensions/types.d.ts:218），`ctx.sessionManager.getSessionFile()` 可达 |
| D1：getSessionFile 返回 `string \| undefined`（d.ts:208） | ✅ 属实（D5 降级路径的触发条件成立） |
| D5：sessionFile 不可得时 warn 降级 | ✅ 与前轮 SUGGESTION 一致，已采纳 |
| D6：computeNextRuns 可按 count 裁剪（parsing.ts:215 `computeNextRuns(spec, from, count=5)`） | ✅ 属实；interval 模式纯累加、cron 走 croner，count=1 语义正确 |
| D6：tool.ts scheduleGuidelines "next 5 run times" 文案需同步改 | ✅ 属实（tool.ts:24） |
| D2：runtime 是全部任务读写路径的 chokepoint | ✅ 核实：service.ts/commands.ts/tool.ts 全部经 runtime 方法；widget 渲染 service.list()（已过滤）；runtime 内任务读写路径枚举 = addTask/listTasks/getTask/toggleTask/deleteTask/runTaskNow/tickScheduler(过期+pending+dispatch)/dispatchTask/persist/persistSync/loadTasks。**遗漏仅两处**：addTask owner 打标（MUST_FIX 2）、复核移除路径（MUST_FIX 1） |
| D2：tickScheduler 每 30s 无条件 persist | ✅ 属实（tickScheduler 末尾 `await this.persist()`，全量写回） |
| D8：subagent 镜像 extension 加载、sessionFile 在 ~/.pi/agent/subagents/ | ✅ 与 AGENTS.md 一致；S10 覆盖"subagent persist 未破坏主任务"方向 ✓。**未覆盖**反向：subagent 接管的无主任务被主 session 复核移除+persist 删除（并入 MUST_FIX 1） |
| S8 步骤"关 A；resume A"依赖 shutdown persistSync 全量写回保留双方任务 | ✅ 一致（index.ts session_shutdown → runtime.persistSync 全量写回） |
| getTaskCount() 无泄漏 | ✅ 非测试代码无调用（runtime.ts:280 定义，仅测试用） |

## 结论

修订方向正确、M1/M2/M3 主路径闭环，且新机制的骨架（复核收敛、原子写）本身成立。但三处缺口若不修，实施结果分别是：迁移窗口磁盘振荡+任务永久丢失（MUST_FIX 1）、修复整体失效（MUST_FIX 2）、并发写损坏原样复现（MUST_FIX 3）——全部落在设计自己声明的目标（G2/G3/G4/G5）与 D7 的动机上。修复方向均为局部小改，不改变方案骨架。
