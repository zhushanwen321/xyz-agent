# P-block 四门实施期实测证据（worktree git 异步化，2026-08-16 采集）

> 对应设计文档 `worktree-git-async-design.md` §3.7 探针表（P-guard / P-mutex）与 §4.2 功能回归场景 4/5/1、P-ffcleanup。此前四门仅有单测落地（cancel-during-create 守卫单测、per-repo mutex 单测），本文补齐真机实测留证。阻塞消除本身的实测见同目录 `pblock-baseline-2026-08-15.md`（Phase 1 对照 + Phase 2 终态对照）。

## 0. 结论汇总

| 门 | 探针/场景 | 判定 | 一句话依据 |
|---|---|---|---|
| 门 1 cancel-during-create | P-guard + §4.2 场景 4 | **通过** | worktree add 人为延迟 5s 窗口内触发 `/new` 级联 dispose（warn 日志与派发时刻差 4ms），create 返回后守卫主动 remove+branch -D（13ms/25ms 内完成），无孤儿、无子进程白跑 |
| 门 2 per-repo mutex | P-mutex + §4.2 场景 5 | **通过** | 两个并发 create 的读命令同毫秒并发（绕锁）、两个 `worktree add` 严格串行（#2 START = #1 END + 9~11ms）；注入首个 add 失败（rc=128）后继 add 9ms 后照常执行且成功（前驱失败不传染） |
| 门 3 kill 重启 reaper | P-ffcleanup | **通过** | kill -9 主 pi（child 3s 内随管道断裂死亡）→ 孤儿现场固化（worktree/branch/registry 三处残留）→ 重启 pi 6s 后 session_start reaper 完成 remove（30ms）+ branch -D（19ms），三处全清 |
| 门 4 patch 回收 | §4.2 功能回归 1 | **不通过（初测）→ 通过（修复后复测）** | 初测：patch 产出且内容正确但缺尾部换行 → 干净副本 `git apply --check` exit 128（corrupt patch at line 7）。根因 = `gitRunAsync` resolve `stdout.trim()` 裁掉 diff 尾换行（存量 bug，同步时代同在）。修复 = `gitRunAsync` 输出保真不 trim + 消费点自行 trim；复测（同方法）：patch 末字节 `0a`、`git apply --check` exit 0、真实 apply 成功、资源全清。详见 §1 修复与复测子节 |

采集环境：pi 0.84.0（RPC mode，`--approve`）、模型 `xiaomi-token-plan-cn/mimo-v2.5-pro`、git 2.50.1（Apple Git-155，真身 `/usr/bin/git`）、macOS 15 arm64。extension 经 dev-link symlink（`~/.pi/agent/extensions/pi-subagent-workflow` → 本 worktree `extensions/subagent-workflow`，源码工作区 clean，worktree-manager 最新 commit 8b4636b16 = phase 2 终态）。实验全部在 `/tmp/pblock-gates/` 下临时 repo（`git init` + 单文件提交），未触碰本项目仓库的 git 状态。

**统一观测手法（git shim）**：`/tmp/pblock-gates/shim/git` 包装脚本 prepend 到 PATH 启动 pi——所有经 `gitRunAsync`→`execFile("git")` 的调用都会命中 shim，shim 记录每条命令的 START/END 时间戳（perl HiRes 毫秒）与退出码后委托 `/usr/bin/git`；对 `worktree add` 可注入延迟（`GATE_ADD_DELAY`）或首错（`GATE_FAIL_FIRST_ADD`，exit 128）。shim 日志是本证据的核心时间线来源（等价于基线采集用的临时插桩，但不改任何源码）。

---

## 1. 门 4：patch 回收（§4.2 功能回归 1）——判定：不通过

### 目的

worktree subagent 正常完成并终态化后，`record.patchFile` 存在且在干净副本上 `git apply --check` 通过（改动回传不丢）。

### 方法

1. repo：`/tmp/pblock-gates/repo-g4`（`git init -b main` + `data.txt` 提交，树干净）。
2. 启动 `pi --mode rpc --session-dir /tmp/pblock-gates/sessions-g4 --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve`，cwd=repo-g4，`PI_EXT_DEBUG=1`。
3. 单条 prompt 驱动三步：`subagent` tool `action:start` + `worktree:true` + task=`echo gate4-appended-line >> data.txt` → 等完成通知 → `action:close`（closeParam.subagentId）触发终态化（close → `closeChatIdle` → `doFinalizeRecord` → Step 0 collectPatch）。
4. 结束后定位 patch：`~/.pi/agent/subagents/--private-tmp-pblock-gates-repo-g4--/sessions/pi-sub-<recordId>.patch`；在 `mktemp -d` 新建的干净副本（同初始提交）上 `git apply --check`。

### 原始观测

- 工具链确认（pi stdout toolResult）：
  - start → `{"action":"start","subagentId":"sa-e27afa4e-4933-481a-aacf-9d3acde21eb5","bgResponse":{"status":"running",...}}`
  - close → `{"action":"close","subagentId":"sa-e27afa4e-...","closeResponse":{"closed":true}}`
- patch 文件存在：`pi-sub-sa-e27afa4e-4933-481a-aacf-9d3acde21eb5.patch`（148 字节），内容：

  ```diff
  diff --git a/data.txt b/data.txt
  index c690e0d..f858a88 100644
  --- a/data.txt
  +++ b/data.txt
  @@ -1 +1,2 @@
   base content for g4
  +gate4-appended-line
  ```

  （hex dump 证实末尾无 `\n`：`...2b67 6174 6534 2d61 7070 656e 6465 642d 6c69 6e65` 后直接 EOF）
- 干净副本 `git apply --check <原patch>` → **`error: corrupt patch at line 7`，exit 128**
- 控制实验：patch 末尾补一个 `\n` 后同副本 `git apply --check` → **exit 0**（尾换行是唯一损坏原因）
- 资源回收（该链路顺带验证了 §4.2 场景 2/3）：`git worktree list` 仅 main、`git branch` 仅 main、`worktrees.json` entries=[]、`$TMPDIR/pi-subagents/<enc>/` 下 checkout 目录已删、`.finalized` marker 已写。

### 判定与归因

**不通过**——`git apply --check` 未通过。根因：`worktree-manager.ts` 的 `gitRunAsync` resolve `stdout.trim()`（worktree-manager.ts:348），把 `diff --cached` 输出的尾部换行裁掉，落盘 patch 非法。**非本次异步化引入**：phase 2 之前的同步 `gitRun` 同样 `.trim()`（`git show 8b4636b16^:...worktree-manager.ts` 第 368 行 `execFileSync(...).trim()`）——异步化对失败路径语义保持等价（设计目标 2 达成），但把存量缺陷一并继承，绝对验收标准（apply --check 通过）不满足。修复方向（供后续 issue）：collectPatch 路径不 trim 或写盘前补尾换行。

### 修复与复测（2026-08-16，门 4 复测通过，初测记录保留于上）

**根因复核定案**：`gitRunAsync` 对所有命令的 stdout 统一 `.trim()`，`git diff` 输出按格式约定以 `\n` 结尾，被裁后 collectPatch 落盘的 patch 末行无结尾换行 → `git apply` 报 corrupt patch。

**修复**（`extensions/subagent-workflow/src/execution/worktree-manager.ts`，方案 = 执行器保真 + 消费点净化）：

- `gitRunAsync` resolve 改为保真返回原始 stdout（`resolve(stdout)`，worktree-manager.ts:357）——执行器不再裁剪输出；错误包装（message 格式 / exitCode / stderr / timedOut 属性）、超时行为、per-repo mutex 语义零改动。
- 需要干净文本的仅两个消费点，自行 trim（`create` 内，worktree-manager.ts:111/:119）：`status --porcelain` 结果 trim 后做脏树判定与错误 message 拼接；`rev-parse HEAD` 结果 trim 后作为 baseCommit（不 trim 会把换行带进后续 git args）。
- 其余 8 处 `gitRunAsync` 调用（worktree add/remove、branch -D、add -A）不消费返回值，零影响。被否决备选：① diff 专用 `raw` 参数——输出形态决策塞进执行器签名，多一个分叉维度；② 写盘前补 `\n`——「补救」而非「保真」，会静默掩盖执行器对输出两端的裁剪，且无法断言写盘字节与 git stdout 逐字节一致。
- 回归断言（`worktree-manager.test.ts` collectPatch 块）：「patch 内容 = git diff stdout 原文（含尾部换行不被裁剪），git apply --check 兼容」——断言 `writeFileSync` 收到的字节与 mock diff stdout 逐字节一致且以 `\n` 结尾；同时 rev-parse mock 改为真实输出形态（hash + `\n`），由既有断言 `handle.baseCommit === BASE_COMMIT` 锁死消费点 trim。vitest 162 文件 / 2175 测试全绿，`pnpm extensions:typecheck` exit 0，改动文件 eslint 0 新增问题。

**复测**（方法同初测：临时 repo + pi RPC + 单条 prompt 驱动 start(worktree) → 完成通知 → close）：

1. repo：`/tmp/pblock-gates-fix/repo-g4`（`git init -b main` + `data.txt` 单提交，树干净）；pi 0.84.0（RPC mode，`--approve`）、模型 `xiaomi-token-plan-cn/mimo-v2.5-pro`、`--extension` 指向本仓 `extensions/subagent-workflow`（加载工作区当前源码，含未提交修复；该包 `main: "index.ts"`，pi 直接加载 TS 源码）。
2. driver（`/tmp/pblock-gates-fix/driver.mjs`，node spawn pi）：+2.5s 发单条 prompt（start worktree subagent，task=`echo gate4-fix-line >> data.txt` → 收完成通知 → close 终态化）→ +16.0s stdout 观察到 `{"closed":true}` → +24.0s 关 stdin，pi exit 0。subagentId `sa-25a504c3-638c-4330-82af-97114c8e1583`。
3. 终态核验：
   - patch 产出：`~/.pi/agent/subagents/--private-tmp-pblock-gates-fix-repo-g4--/sessions/pi-sub-sa-25a504c3-....patch`（144 字节），7 行完整 diff（`+gate4-fix-line`），**末字节 hex `0a`（\n）**——初测同一位置为 `...6c696e65` 后直接 EOF。
   - 干净副本（`mktemp -d` + 同初始提交）`git apply --check <patch>` → **exit 0**（初测 exit 128 "corrupt patch at line 7"）；继续真实 `git apply` 后 `data.txt` = `base content for g4` + `gate4-fix-line` 两行。
   - 资源回收：`git worktree list` 仅 main、`git branch` 仅 main、`worktrees.json` entries=[]、`.finalized` marker 已写、无残留 pi 进程。

**判定：通过**。

### 附带观察

- one-shot 成功完成后 record 走 `finalizeRoundToIdle`（保持 running-resumable，不触发 collectPatch）——与基线证据记录一致的设计行为；本次经 `close` 显式终态化后才收集 patch。
- 本轮 pi 未带 shim PATH（`env PATH=... driver | pi` 管道语法只作用于首命令），无 git 时间线；不影响判定（apply --check 是协议级检查）。后续三门修正为 `export PATH` 后再起管道。

---

## 2. 门 3：kill 主 pi → 重启 reaper 回收（P-ffcleanup）——判定：通过

### 目的

dispose 场景实测：主 pi 崩溃（kill -9）后 worktree 成为孤儿，下次 pi 启动的 session_start reaper 按 pid 死活判孤儿并回收（fire-and-forget cleanup 的兜底闭环）。

### 方法

1. repo：`/tmp/pblock-gates/repo-g3`（同上干净初始化）；pi 带 shim（无延迟，仅打点）。
2. prompt 驱动：start 一个 worktree background subagent，task=`sleep 100`（长任务保证 kill 时 child 活着），start 返回即停。
3. 轮询 `~/.pi/agent/subagents/worktrees.json` 直到 entry `pid>0`（child 已 spawn 且 pid 已同步补全）。
4. **精确定位**主 pi PID（pi 会把进程 title 重写为 "pi"，命令行匹配不可用）：child pid 的 PPID 即主 pi（进程树：g3-run.sh bash → 主 pi → subagent child）→ `kill -9 <主pi>`。
5. 观察 child 死活；确认孤儿现场（worktree list / branch / registry 三处）。
6. 同 session-dir 重启 pi（prompt "reply ok" 驱动新 session）→ session_start → reaper。
7. 复查三处状态 + shim 时间线。

### 时间线（UTC，shim 日志 + 文件 mtime）

| 时刻 | 事件 |
|---|---|
| 04:22:29.399 | create 读命令并发：`rev-parse HEAD` 与 `status --porcelain` 同毫秒 START（Promise.allSettled 并行），各 ~45ms |
| 04:22:29.462 | `worktree add -b pi-sub-sa-ced3a439...` START → 29.502 END rc=0（40ms，小 repo） |
| 04:22:31 | registry entry 落盘（`pid=174`，`createdAt=1786854149503`）；`git worktree list` 出现 pi-sub-* 条目 |
| 04:23:00 | `kill -9 97984`（主 pi，PPID 链定位） |
| 04:23:03 | child 174 已死（kill 后 3s 内，父进程管道断裂）——**无需手动杀 child** |
| 04:23:19.742 | 孤儿现场固化确认：worktree list 含 pi-sub 条目、`git branch` 含 `+ pi-sub-sa-ced3a439...`、worktrees.json 仍持有 entry（kill -9 无 dispose） |
| ~04:23:26 | 重启 pi（同 repo、同 session-dir） |
| **04:23:31.710** | **reaper 动作**：`worktree remove --force <checkout>` START → 31.740 END rc=0（30ms） |
| 04:23:31.748 | `branch -D pi-sub-sa-ced3a439...` START → 31.767 END rc=0（19ms） |
| 04:23:38.8 | 复查：worktrees.json entries=[]、worktree list 仅 main、branch 仅 main、checkout 目录已删 |

reaper 的 remove/branch -D 命令 `cwd=repo-g3` 与注册表 entry.repo 一致，且发生在重启后 6s（pi boot + extension 加载 + session_start handler 前序 await 之后）——动作归属 reaper 无歧义。

### 判定

**通过**。孤儿判定（child pid 死）→ 回收（remove + branch -D + registry.remove）→ 三处现场全清，闭环成立。fire-and-forget cleanup 在进程先退时的兜底语义与设计 §3.3 设计点 5 一致。

---

## 3. 门 1：cancel-during-create 守卫（P-guard + §4.2 场景 4）——判定：通过

### 目的

create 的 await 窗口（git 变慢时人为拉长）内 cancel/dispose 抢先 CAS 把 record 转 closed → 守卫在 create 返回后主动 cleanup（不等 60s reaper）+ early-failed 返回（不 kickOffBackground，子进程不白跑）。

### 方法

1. repo：`/tmp/pblock-gates/repo-g1`；shim 配 `GATE_ADD_DELAY=5`（`worktree add` 前睡 5s，窗口即 create 的 await yield 期）。
2. driver 脚本：发 prompt（start worktree bg subagent）→ 轮询 shim 日志出现 `worktree add` START → 再等 1s（确保落在 5s 窗口内）→ 向 pi stdin 发 RPC `{"id":2,"type":"new_session"}`。
3. `new_session` 触发 `session_before_switch(reason:"new")` → `onParentNew()` → `disposeAllRecords`（CAS running→closed）——单测 cancel-during-create 用的同款触发路径（无需提前知道 subagentId）。
4. 观测 shim 时间线 + 扩展日志 + 终态。

### 时间线（UTC）

| 时刻 | 事件 | 证据源 |
|---|---|---|
| 04:24:25.056 | 读命令并发（status + rev-parse 同毫秒） | shim-g1.log |
| 04:24:25.117 | `worktree add` START（shim 睡 5s，create 挂起中） | shim-g1.log |
| 04:24:26.601 | driver 派发 `new_session`（进入窗口 1.48s） | g1-events.log |
| **04:24:26.605** | **`[subagents] /new 级联关闭 1 个 subagent`**（onParentNew → disposeAllRecords CAS closed；此刻 record.worktreeHandle 仍 undefined，dispose 侧 cleanup 跳过） | subagents-2026-08-16.log warn |
| 04:24:30.170 | `worktree add` END rc=0 → create 返回 → 赋值 handle → 守卫检查 `record.status==="closed"` 命中 | shim-g1.log |
| 04:24:30.183→30.206 | **守卫主动 cleanup**：`worktree remove --force`（23ms，rc=0） | shim-g1.log |
| 04:24:30.217→30.242 | `branch -D`（25ms，rc=0） | shim-g1.log |

### 终态核验

- `git worktree list` 仅 main；`git branch` 仅 main；worktrees.json entries=[]；checkout 目录空。
- **子进程未白跑**：无 `rev-parse --abbrev-ref HEAD`（buildEnvBlock 仅在 runSpawn 执行）出现在 add 之后；`~/.pi/agent/subagents/<enc-g1>/` 目录不存在（无 subagent session jsonl）；无残留 pi 进程。
- RPC `new_session` 响应 `{"success":true,"data":{"cancelled":false}}`——旧 turn 的 tool call 被允许完成（这正是守卫得以执行的窗口），start 的 toolResult 在 new_session 响应之前到达。

### 判定

**通过**。守卫在 create-await 竞态窗口被抢先终态后 13ms 内启动主动清理、71ms 内完成全部回收，未依赖 60s reaper 宽限，子进程零启动。

### 附带观察（不影响判定）

- start 的 toolResult `bgResponse.status` 硬编码 `"running"`（`subagent-actions.ts:219`），守卫 early-failed 返回时 tool 层文案不变——对父 agent 的可见形态与正常启动无区分（详见 §6 建议）。

---

## 4. 门 2：per-repo mutex 串行化 + 前驱失败不传染（P-mutex + §4.2 场景 5）——判定：通过

### 目的

同 repo 并发 2 个 worktree subagent spawn：写类 git 命令按到达顺序串行（时间窗互斥）、读类并发、无饥饿；第一个写命令失败后同 repo 后继写命令仍正常执行（链吞 rejection，不传染）。

### 方法

1. repo：`/tmp/pblock-gates/repo-g2`。并发载体用扩展自带编排：预置 `.pi/workflows/gate2a.js`（`parallel()` + 两个 `agent({worktree:true})`——worker 侧 `Promise.allSettled` 派发，主线程 `gate.withSlot` fire-and-forget 执行，两路 `executeAndAwait` → `wtm.create` 真并发；这是设计所述 wave 并行场景的最小复现）。
   - **坑 1（已修）**：workflow meta 的 `phases` 必填，缺失则 config-loader 判 `available=false`，`workflow run` 静默跑空（仅一条 warn）。补 `phases: [run]` 后正常。
   - **坑 2（已修）**：脚本放进 repo 但未提交 → `status --porcelain` 非空 → DirtyWorktreeError，create 反复失败（shim 日志只见 3 轮读命令爆发、无 add）。`git commit` 后解决。
2. Round A（串行化）：shim `GATE_ADD_DELAY=3`，无失败注入。
3. Round B（失败不传染）：`GATE_FAIL_FIRST_ADD=1`（首个 `worktree add` exit 128 + stderr），其余正常。
4. 每轮结束核验终态（worktree/branch/registry/children session）。

### Round A 原始时间线（UTC，shim-g2a.log）

```
04:45:33.478-33.585  [启动 reaper] 回收上一轮提前退出残留的 2 个孤儿：
                    remove(c7e44c94) rc=128（checkout 已被退出期 dispose 部分清理，best-effort 吞错）
                    branch -D(c7e44c94) rc=0；remove(d1d8be99) rc=0；branch -D(d1d8be99) rc=0
04:45:37.082-37.112  [并发派发实证] 4 条读命令同毫秒窗口并发：
                    2×status --porcelain + 2×rev-parse HEAD（两个 create 的读阶段，读类不加锁）
04:45:37.121→40.160  worktree add #1（pi-sub-sa-6a871b25）3.04s rc=0   ← shim 延迟 3s
04:45:40.171→43.210  worktree add #2（pi-sub-sa-14e3d4f3）3.04s rc=0   ← START = #1 END + 11ms
04:45:40.171→40.190  rev-parse --abbrev-ref HEAD（agent#1 的 buildEnvBlock 读命令，
                    与 add #2 的写窗口完全重叠——读写并发、写写互斥的直接观测）
```

- `worktree add` 窗口零重叠（#2 START 40.171 > #1 END 40.160）；若 mutex 缺失，两条 3s 延迟的 add 会并行重叠（窗口几乎重合）——判据方向性明确。
- 两个子 agent 均完成各自任务（session jsonl：bash toolCall + "done" 回复）。
- 终态全清：worktrees.json entries=[]、branch 仅 main、worktree list 仅 main。
- 首轮同场景已复现一次（attempt 记录：add#2 START = #1 END + 10ms，4 读同毫秒）——**可复现**。

### Round B 原始时间线（UTC，shim-g2b.log）

```
04:57:58.062-58.095  4 条读命令同毫秒并发（两个 create）
04:57:58.102→58.115  worktree add #1（pi-sub-sa-1ef3a031）END-FAIL rc=128（注入失败）
04:57:58.124→58:01.186  worktree add #2（pi-sub-sa-bb0595cd）START = 失败后 9ms → 3.06s rc=0 ★
04:57:59.148-59.168  agent#1 失败重试的 create 读命令（与 add #2 写窗口重叠——读不排队）
04:58:01.195→04.238  worktree add #3（pi-sub-sa-7abe16db，agent#1 重试）→ 3.04s rc=0 ★
```

★ = 判据核心：**前驱 add 失败（rc=128）后，同 repo 队列中的后继 add（#2）与重试 add（#3）均正常执行且成功**——`prev.catch(()=>{}).then(run)` 的吞 rejection 语义实测成立；若链式实现直接 `await prev`，#2/#3 会携带 #1 的错误 reject（错误级联）或整链断裂。

- 失败传播形态：agent#1 的 create 抛 `GitRunError`（message `git worktree failed: ...`）→ `finalizeFailed` 终态化 → error-recovery 层自动重试 → 重试 create 成功。
- 两个子 agent 最终都完成任务（session jsonl 均有 bash + "done"）。
- 终态全清（registry []、branch 仅 main、无 worktree）。

### 判定

**通过**。串行化（写写互斥 + 读写并发 + 无饥饿）与前驱失败不传染（后继 9ms 内照常执行、同批最终全部成功）均拿到毫秒级时间线实证。

### 附带观察（不影响判定，供后续排查）

1. **「不可见清理」异常**：Round A 第二轮中，子 agent 完成后至 pi 退出前，registry/worktree/branch 在某时刻被清空但 shim 无对应 `branch -D`/`worktree remove` 记录（registry mtime 04:47:09；退出期 dispose 的 remove 出现在 04:54:31 且 rc=141 SIGPIPE）。该清理的发起路径未在本任务范围内定位（候选：one-shot 成功后 `finalizeRoundToIdle` 的 idle-timeout 链或 error-recovery 的重试清理），记录为待查项——不影响 mutex 判定（mutex 在进程内于 `gitRunAsync` 层生效，与哪个 git 二进制执行无关）。
2. **workflow 完成通知缺失**：两轮的 pi stdout 均未见 workflow 完成通知 turn（主 agent 只收到 "Started workflow"）。子 agent 任务实际已完成。属 workflow 域行为，超出本四门范围。
3. pi 退出（stdin EOF）时 dispose 的 fire-and-forget cleanup 可能被进程退出截断（attempt 1 留下 2 孤儿、由下一轮启动 reaper 兜底回收）——与设计 §3.3 设计点 5 的声明一致（reaper 兜底），且本实验两次实证该兜底闭环有效。

---

## 5. 四门共同的环境事实（复现要点）

- 主 pi 进程 title 会被重写为 "pi"，`pgrep -f`/`ps aux` 命令行匹配失效；定位用进程树（child 的 PPID = 主 pi）或 `lsof -p <pid>` 的 cwd。
- registry（`~/.pi/agent/subagents/worktrees.json`）为全局单文件（agentDir 级），跨 repo 共享——每门实验前需确认 `entries: []`。
- repo 路径以 realpath 落注册表（`/tmp/...` → `/private/tmp/...`），patch/session 目录编码用 `--private-tmp-pblock-gates-repo-gN--`。
- shim 管道语法坑：`env PATH=... driver | pi` 只对 driver 生效；须在 runner 脚本内 `export PATH` 再起管道。
- 测试 repo 必须树干净（含 workflow 脚本在内的任何未跟踪文件都会触发 DirtyWorktreeError）。

## 6. 遗留问题清单（按门 4 判定延伸）

| # | 问题 | 性质 | 建议 |
|---|---|---|---|
| 1 | ~~collectPatch 产物缺尾换行，`git apply --check` 失败（门 4 不通过的根因）~~ **已修复**（2026-08-16）：`gitRunAsync` 输出保真不 trim + 消费点自行 trim + patch 尾换行回归断言；复测 `git apply --check` exit 0，详见 §1 修复与复测子节 | 存量 bug（同步时代同样存在），非异步化回归 | 已完成，无需后续动作 |
| 2 | start 的 `bgResponse.status` 硬编码 `"running"`，守卫 early-failed 时文案不区分 | 观察项 | 从 `handle.details.status` 取值 |
| 3 | Round A 的「不可见清理」路径未定位 | 待查项 | 用 PI_EXT_DEBUG 定向插桩 idle-timeout / error-recovery 链路复现 |
| 4 | workflow run 完成通知未到达主 agent（两轮复现） | workflow 域，超出本四门 | 单独 issue |
