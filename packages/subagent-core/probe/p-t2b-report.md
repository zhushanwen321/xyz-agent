# P-T2b 探针报告：pi 子进程收 SIGTERM 后是否自行级联 kill 其活跃后代

- 探针脚本：`probe/p-t2b-sigterm-cascade.mjs`
- 数据文件：`probe/p-t2b-results.json`（最终一次全量运行的完整 timeline）
- 运行日期：2026-09-01 · 环境：真实 pi CLI 0.84.2（dist 实装）+ `xiaomi-token-plan-cn/mimo-v2.5-pro` + `--mode rpc --approve`，非 mock
- 支撑决策：T2-② 后代级联 kill 的形态裁决——证实级联 → u-t2a 后代补杀退化为 no-op 一致性校验；证否 → 后代补杀即主路径（设计 §7.2 T2-② / §7.3 P-T2b 行）

## 方法

两层嵌套真实进程：探针 spawn 父 pi 进程（rpc 模式），父 pi 经 bash 工具（`--approve` 自动批准，要求原样执行给定命令）spawn 后代。对两形态分别向父进程发 SIGTERM，观察父退出与后代存活（`ps -p` 核对，+2s/+8s 双检）：

- **形态 A（前台 bash 执行中）**：prompt 要求执行 `sleep 240`，SIGTERM 发出时 bash 工具仍在执行（后代 shell 树还在父的直接管理窗口内）
- **形态 B（后台化后代——设计语境的主裁决形态）**：prompt 要求执行 `bash -c 'tail -f /dev/null | nohup pi --mode rpc --no-extensions --session-dir <唯一目录> >/dev/null 2>&1' &`——后代是一个**常驻的、父进程已不再 track 的 pi 进程**（`tail | ` 管道保持 stdin 永不 EOF，见偏差 D3：裸 nohup 形态下 pi rpc 遇 stdin EOF 立即自退，会产生级联假阳性）

## 实测数据（最终全量运行；两形态结论在 3 次运行中均稳定复现）

### 形态 A：CASCADE 存在

| 时间线 | 事件 |
|--------|------|
| 0.0s | 父 pi pid=67450 起，prompt 发出 |
| 8.7s | 后代快照：[67566]（bash shell 树，前台执行中）→ 发 SIGTERM |
| 8.7s→9.4s | **父退出，exit code 143，耗时 701 ms** |
| +2s / +8s | 后代 67566 **均已死亡** |

**结论：CASCADE** —— bash 前台执行期间（其 pid 在 pi 的 tracked detached children 集合内），SIGTERM 级联杀掉后代。

### 形态 B：NO-CASCADE

| 时间线 | 事件 |
|--------|------|
| 17.4s | 父 pi pid=68012 起，prompt 发出 |
| 22.4s | 从 bash 输出捕获后代 pi pid=68206；父进程树后代快照 = []（后台化后代是 detached 孤儿，不在父树中） |
| 33.5s | **SIGTERM 前验活：68206 存活** → 发 SIGTERM |
| 34.2s | **父退出，exit code 143，耗时 702 ms** |
| +2s / +8s | 后代 68206 **仍然存活** |

**结论：NO-CASCADE** —— 对已后台化、untrack 后的活跃 pi 后代，父 pi 收 SIGTERM 不级联杀；后代成为孤儿继续运行。

### 机制对照（实装版 0.84.2 dist 源码，与实测互相印证）

- `dist/modes/rpc/rpc-mode.js:276-286`：SIGTERM handler = `killTrackedDetachedChildren(); shutdown(143, signal)`——级联范围**仅限 tracked detached children**
- `dist/core/tools/bash.js:71,110`：仅在 bash 工具前台执行期间 `trackDetachedChildPid`，工具返回时 finally `untrack`
- `dist/utils/shell.js:163-171`：`killTrackedDetachedChildren` 对 tracked pid 做进程组 SIGKILL
- 即：`agent_end` 之后 bash 早已返回的形态（subagent-core keep-alive 层主 + 其已 spawn 的后台后代），**pi 自身不存在任何级联路径**——与形态 B 实测一致

## 结论（u-t2a T2-② 裁决）

**后代补杀为主路径**（设计已按此形态，无方案变更）：

1. no-op 化不成立：SIGTERM 对 keep-alive 语境的后代（后台化 pi 进程）无级联，实测 +8s 存活、机制层无 kill 路径。
2. 形态 A 的 CASCADE 仅覆盖「bash 工具前台执行中」的窄窗口，且该窗口本就由 bash 工具自身的 abort/timeout 语义管理；不能外推到「层主死后活跃后代」的设计语境。
3. 对 u-t2a ② 的两点实现输入：
   - 层主 SIGTERM 后自身退出很快（实测 ~0.7s，exit 143），「层主确认死亡（close）后采集后代清单」的两步时序在实测时间尺度上是安全的；
   - 补杀前的「存活校验 + cmdline 含 pi/--mode rpc 校验」必要（本探针后代即以 `pi --mode rpc` 形态存活，cmdline 校验可命中）。
4. 附带实证（对 T5/孤儿恢复有价值）：父死后后台后代成为孤儿继续运行——若无补杀，该进程只能靠 marker/孤儿恢复机制收敛，存在设计已标注的「marker 失真残余窗口」。

## 偏差与试验史（如实登记）

- 第一次形态 B 试验产生过一次 **CASCADE 假阳性**：裸 `nohup pi &` 后代的 stdin 继承 `/dev/null`，pi rpc 遇 stdin EOF 自行退出（独立实验验证：`pi --mode rpc < /dev/null` 约 4s 内 exit 0）——「+2s 已死」实为自退非被杀。修正为 `tail -f /dev/null |` 管道保持 stdin 常开 + SIGTERM 前验活后，3 次复现稳定 NO-CASCADE。此发现已回写进探针脚本注释（对任何复跑者重要）。
