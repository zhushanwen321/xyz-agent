# 设计文档对抗式审查报告：worktree reaper 误清活 worktree 修复

审查对象：`.xyz-harness/2026-08-12-worktree-reaper-pid/design.md`
审查方式：独立 read 源码逐条核实 §2.2 表格全部事实断言 + 方案 A 攻击面推演 + 验收场景可行性验证（全部源码已核实，行号以当前 worktree 为准）
审查清单：tech-design skill `review/rubric-design-doc.md`（P0-1 ~ P0-18 / P1-1 ~ P1-7）

## Summary

**1 must-fix, 7 suggestions.**

根因诊断链（§2）与方案 A 主干（§3）经源码核实**成立**：`registerPid` 唯一生产调用点确实在 header 分支（`session-runner.ts:832`，`if (parsed.kind === "header")` 内），`buildSpawnArgs` 确实固定 `--mode rpc`（`session-runner.ts:481`），`spawn-event-adapter.ts` 头部注释确实自证 RPC mode 无 header，`isOrphan` 判据（`worktree-manager.ts:227-232`）与 `SPAWN_GRACE_MS=60_000`（`worktree-registry.ts:26`）属实，接线 `onWorktreePid → registerPid`（`subagent-service.ts:1052`）正确。方案 A 的因果链（spawn 返回后同步补 pid → pid 恒 0 状态消除 → 误删根因消除）成立，崩溃兜底（pid=0 + 60s 宽限）语义保留自洽，方案 B/C/D 的否定理由均成立。

唯一 must-fix 在**验收场景 2 / Task 2 的集成测试描述存在内部逻辑矛盾**：文档描述的「mock 脚本输出几行后退出」与「推进 60s+ → scan() → 断言 checkout 目录仍存在」不能同时成立——子进程已退出则 pid>0 且进程死，`isOrphan` 判孤儿，目录必删（**修复后该断言也红**），实施者按文档写测试会永远红、误判修复无效。必须重写该场景的脚本形态与测试编排。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §4 场景 2 + §5 Task 2 | P0-13 验收可测性 | 正向断言「推进 60s+ → scan() → checkout 目录仍存在」要求子进程在 scan 时**存活**，但文档同时规定 mock 脚本「输出 `{"type":"event",...}` 几行后退出」——脚本毫秒级退出，scan 时进程已死，`isOrphan`（pid>0 且 `!isProcessAlive`）判孤儿，目录必删，**修复后断言也红**。§5 待验证点把「长驻脚本 + SIGTERM」表述为「退化方案」，实为**唯一可行形态**。另两个缺口：①runSpawn 内部 command 由 `getPiInvocation` 决定（`session-runner.ts:711`，vitest 环境下命中分支 1 → 会 spawn 当前 vitest 入口进程，灾难），测试必须 `vi.mock("./pi-invocation.ts")` 注入 `node -e 内联脚本`，文档「mock pi 脚本」表述有误导；②正向用例不能 `await runSpawn()`（子进程存活时 close 不触发），需 runSpawn 挂后台 + 轮询注册表 + 测试自持 pid kill 编排，文档未描述 | 重写 Task 2/场景 2：正向用例 = 长驻脚本（sleep 90s 或等 stdin close）+ 显式 mock `getPiInvocation` 注入点 + runSpawn 不 await、测试从注册表读 pid 并 SIGTERM 清理；反向用例 = 短命脚本「几行后退出」；两种脚本形态分开写明。先红后绿的逻辑本身成立（修复前 pid=0 → 删目录 → 红），可保留 |
| SUGGESTION | §2.2 表格第 3 行 | P0-11 事实 | 注释原文标注 `session-runner.ts:834-836`，实际 `[#25]` 注释在 **836-837**（834-835 是 FR-4 加速路径注释，已用 sed -n '833,838p' 逐行核对）。引用文本与原文一致，行号偏 2 行。表格自称「全部经源码核实」，行号偏差削弱可信度 | 改为 836-837 |
| SUGGESTION | §3.3 决策 3 + §4 场景 4 | P0-11 事实 | 「现有 **4** 个测试文件全部 mock registerPid」与文档自己的 §2.6（列举 3 个文件）矛盾。全量 grep 确认 mock `registerPid = vi.fn()` 只有 3 个文件（session-start-reaper.test.ts:52 / crash-recovery.test.ts:72 / index-session-start.test.ts:119），worktree-manager.test.ts:230 是直接调用 registerPid 的行为单测，非 mock | 统一为 3 个，或把 worktree-manager.test.ts 计入时改述为「3 个 mock + 1 个行为单测」 |
| SUGGESTION | §4 场景 1 反向 | P0-13 验收表述 | 「手动 kill 子进程后…60s+ 后该 worktree 被 reaper 回收」不准确：pid>0 且进程死时 `isOrphan` **立即**判孤儿（`worktree-manager.ts:227-232`，60s 宽限只对 pid=0 生效），kill 后下一次 session_start 触发的 scan 即回收，无需等 60s | 改为「kill 后触发任意 session_start 即回收（无需等宽限）」，顺带验证「宽限仅覆盖 pid=0」这一语义 |
| SUGGESTION | §4 场景 2/场景 4 的目标标注 | P0-13 目标回溯 | 场景 2 标「目标 1」实为验证测试有效性（先红后绿）= **目标 4**（盲区闭合）；场景 4 标「目标 4」实为回归基线（不验证盲区闭合）。目标映射两处错位 | 场景 2 改标目标 4（间接含目标 1 断言），场景 4 改标「回归基线」或去掉目标标注 |
| SUGGESTION | §5 Task 3 | P0-12 遗漏 | 「同类问题同修」不完整：cw-spawn.ts 自己的 `child.on("error")`（cw-spawn.ts:97-100，`[spawn error] ${err.message}`）同样不拼 cwd。spawn 前 `existsSync` 检查存在 TOCTOU 窗口（检查通过 → 目录被删 → spawn ENOENT），此时错误仍无 cwd；且「同类同修」若只修 session-runner 不修 cw-spawn 自身，事故路径（cw 工具在子进程内 spawn）实际没被完整覆盖 | cw-spawn.ts 的 error handler 同样把 cwd 拼进 stderr |
| SUGGESTION | §5 Task 1 | P0-12 遗漏 | `registerPid → updatePid` 的写盘是 best-effort 静默吞错（`worktree-registry.ts` save 的 catch → bestEffort，无日志）。若写盘失败（磁盘满/权限），条目 pid 恒 0 → 60s 后误删路径**仍在**，且无诊断线索。Task 1 已给 scan 的 pid=0 分支加 warn 日志，但补全侧失败无日志，闭环缺一半 | updatePid 写盘失败时补 warn（含 branch/pid），与 scan 的 pid=0 warn 呼应，形成「补全失败可观测」闭环 |
| SUGGESTION | §3.1 失败路径文案 | P1-3 受众 | 恢复指引硬编码 `~/.pi/agent/subagents/worktrees.json`，但注册表实际路径是 `<agentDir>/subagents/worktrees.json`（`worktree-registry.ts:68`，agentDir 可被环境配置改变），用户按文案找错文件会二次误诊 | 文案写「检查 pi agent 目录下 subagents/worktrees.json」或由实现注入实际路径 |
| SUGGESTION | §5 Task 3 | P1 实现契约 | `defaultCwSpawner` 的契约是 `Promise<CwSpawnResult>`（不 reject，error 事件走 finish 返回 exitCode=-1，cw-spawn.ts:97-100）。`existsSync` 检查失败时的返回形态（resolve exitCode=-1 + stderr 文案，还是 reject）文档未明确，影响 cw-runner 调用方处理 | 明确检查失败返回形态，与现有 error 路径（finish + exitCode=-1）保持一致 |

## 五段骨架完整性判定

**通过（P0-1 不适用违规）**：五段齐全——§1 背景目标（SCQA 开篇 + 4 设计目标 + In/Out of Scope）、§2 现状与问题分析（使用者视角 + 根因表格 + 确定性死亡论证 + 数据流图）、§3 解决方案（终态 + 4 方案对比 + 5 项关键决策）、§4 验收（4 场景）、§5 下一层拆分（4 Task + 依赖序 + 待验证检查点）。P0-3 结论先行：各章首句均为结论，达标。P0-2 无 delta 链引用，达标。P0-4 根因触达（不是「体验差」表象，是接线错误 + 行号级证据），达标。

## 验收场景真实性判定

- **场景 1（真实复现）**：本地 pi CLI + 真实模型 + 真实 worktree + 真实 90s 等待，**非单测非 mock**，探针具体（worktrees.json pid ≠ 0 / 目录存在 / 标记文件存在）。达标（除上述「60s+ 后回收」表述小错）。
- **场景 2（集成测试）**：真实 spawn + 真实 worktree 创建，仅 mock pi 二进制本体与时间推进（fake timers 加速 90s 等待，不掩盖 pid 接线）——作为集成测试层合理，且有场景 1 真实兜底。**但正向用例描述自相矛盾（MUST_FIX）**。
- **场景 3（真实错误路径）**：真实删除目录 + 真实 spawn 调用，断言具体（错误含完整 cwd 路径 + 恢复指引），可执行（直接调 defaultCwSpawner 的集成场景）。达标。
- **场景 4（回归基线）**：全量扩展测试 exit 0。达标（作为回归基线，非目标验证）。
- 验收投入与改动大小匹配（P0-15 通过）：核心改动 ~5 行，但配了 4 场景含真实复现，不敷衍也不过度。
- 每场景回溯 §1 目标：**基本达标**，但场景 2/场景 4 的目标标注错位（见 SUGGESTION 第 4 条）。

## 对抗式核心三问结论

1. **方案 A 是否真正消除误删（P0-10）**：是。补全点从「永不触发的 header 分支」移到「spawn 返回后同步执行」，pid=0 窗口从分钟级缩到毫秒级，`isProcessAlive(pid)` 判活后活 worktree 不再满足孤儿判据。攻击面逐一验证：spawn 失败（child.pid undefined → 守卫跳过 → finalize cleanup 回收，`subagent-service.ts:516-520` 的 finalizeFailed + `finalize-record.ts:121` cleanup 双兜底）✅；create 后 spawn 前崩溃（pid=0 + 60s 宽限保留）✅；双调用点幂等（`updatePid` 同 branch 覆盖写、branch 不存在忽略，`worktree-registry.ts:90-97`）✅；补全代码异常安全（updatePid 的 load/save 全 best-effort 不抛）✅；嵌套 subagent 场景（改 runSpawn 公共路径自然覆盖）✅。残余风险：注册表写盘失败静默（SUGGESTION 第 6 条）。
2. **因果链回溯**：目标 1 ← 方案 A 补全 ✅；目标 2 ← pid=0 宽限保留 + pid>0 dead 判据 ✅；目标 3 ← Task 3 ✅；目标 4 ← Task 2（修正 MUST_FIX 后）✅。无目标遗漏、无「解决表象」问题。
3. **关键事实（P0-11）**：§2.2 表格 10 项断言**9 项精确属实**（含 481/719/811/829-832/1052/295/121/52/72/119 全部行号），1 项行号偏 2 行（834-836 → 实际 836-837）。方案 B 否定理由（create 不写注册表 → 崩溃泄漏且 reaper 找不到）经 `worktree-manager.ts:83-89` + `scan()` 遍历注册表逻辑验证成立。

## 最终裁决

**pass-with-must-fix（1 must-fix / 7 suggestions）**

修复 MUST_FIX（重写 §4 场景 2 / §5 Task 2 的脚本形态与测试编排，明确长驻/短命双脚本 + `getPiInvocation` 模块 mock + runSpawn 挂后台编排）后即可实施。方案主干正确、事实基本经得起源码核对，无需推倒重来。
