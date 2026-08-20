# P3 Gate 行为级验收报告（data-source-governance：场景 3 + 场景 5 + 高危问题归因）

> 验收对象：docs/architecture/data-source-governance.md §4 场景 3（重开一致性）+ 场景 5（subagent 单源一致）+ P1P2 gate 报告第三节问题 2 归因。
> 执行环境：真实 `pnpm dev` Electron app + 真实 pi 子进程（`apps/electron/resources/pi/pi-darwin-arm64`，spawn 参数含 16 个 extension 与 subagent-workflow），无 mock。
> 验收方：独立 verifier subagent；未修改任何生产代码/文档；无 git 写操作。
> 数据目录：dev 隔离 `~/.xyz-agent-dev/`（端口 1420/9222/3310）。验收全程 3 次 dev 启停，均精确 kill 本方进程组（PGID 51196 / 53337 / 54534），结束均已停止并确认端口清空。

## 结论（三行）

- **场景 3（重开一致性）：PASS**——create 路径 session 单次重启重开，消息分组 / subagent 注入 / 用量与重开前一致；等价性测试 40/40 通过（fixture 驱动覆盖，见 §1.4 覆盖关系说明）。
- **场景 5（subagent 单源一致）：PASS**——重开后四处（侧栏 SubagentList / 主对话注入 turn / `session.getSubagents` RPC / entry 扫描）状态一致（closed + 相同 result 摘要）；JSONL 存在自描述 `subagent-record` custom entry（3 条状态机快照）；W18 混沌测试 2/2 通过。附 1 项设计内差异（live 态 running-resumable，见 §2.3）。
- **高危问题归因（P1P2 报告问题 2：restore 后新对话不落原 JSONL）：复现成立，根因在 W11 之前的既有链路（计划外）**——tmp 附着管线由 `40f2e0300`（2026-07-17，sidecar metadata 计划 W1）引入，本计划 W11（`5ae15ff46`）未触碰该行为；完整根因链与本环境一手复现证据见 §3。

---

## 一、场景 3（重开一致性）证据

### 1.1 操作序列（session `01a019c7-0c13-7508-8255-8986602bff2d`，create 路径新建，Stock cwd，MiMo-V2.5-Pro / 思考最高）

| 步骤 | 操作 | 结果 |
|---|---|---|
| 1. 首轮 | 发「介绍自己 + 中文从 1 数到 20」 | 完整回复（介绍 + 一~二十） |
| 2. steer | turn 进行中输入「转向：数到 10 就停下，不用数到 20，改用阿拉伯数字」+ **Alt+Enter** | `message.follow_up` 入队，第二轮消费：回复阿拉伯数字 1-10 |
| 3. `!` bash | 输入 `!pwd` 发送 | UI 显示 `pwd / exit 0 / /Users/zhushanwen/Stock`（live 期实时通路曾显示 protocol error 占位，见 §4.2；重开后 entry 通路显示正确输出） |
| 4. 后台 subagent | 「用 subagent 工具在后台启动子代理读 package.json 的 name 字段」 | 后台启动（Subagent · general-purpose · read-package-name）→ 完成注入「子代理已完成任务 ✅ package.json 中 "name" 字段的值是："xyz-agent"（版本 0.9.2）」 |

before 基线（重启前）：JSONL 25 行 / mtime 19:29:26 / md5 `983ee786cd87d1134aadb277410279eb`；用量 44.1K · 4%。

### 1.2 重启与重开

`kill -TERM -<PGID>` 精确停 dev → 端口 1420/9222/3310 确认清空 → 重新 `pnpm dev` → 侧栏点击该 session 重开（走 `restoreSession` 路径）。

### 1.3 对照表（重开前 vs 重开后）

| 对照项 | 重开前 | 重开后 | 一致 |
|---|---|---|---|
| turn 分组 1（介绍+数数） | 「已工作1s · 思考 ×1」+ 完整内容 | 同 meta 同内容 | ✅ |
| turn 分组 2（steer 转向） | 「已工作1s · 思考 ×1」+ 1-10 阿拉伯数字 | 同 meta 同内容 | ✅ |
| turn 分组 3（!pwd） | pwd / exit / *(protocol error 占位)* | pwd / **exit 0 / /Users/zhushanwen/Stock** | ⚠️ 内容更完整（见 §4.2，重开后反而正确） |
| turn 分组 4（subagent 指令+注入） | 「工作中11s · 思考 ×3 · 工具 ×1」+ 完成注入 turn | 「已工作12s · 思考 ×3 · 工具 ×1」+ 同一完成注入 turn | ✅（计时 ±1s 漂移，见 §4.1） |
| 用量 | 44.1K · 4% | 44.1K · 4% | ✅ |
| 模型/思考档 | MiMo-V2.5-Pro / 最高 | 同 | ✅ |
| 消息结构 | 4 turn 组 + 底部 5 条 quote | 同 | ✅ |

截图对照：`p3-before-01-chat.png` / `p3-before-02-subagent.png` ↔ `p3-after-01-chat.png` / `p3-after-02-subagent.png`。

**判定：消息分组、用量、注入内容一致 → PASS**（两处非实质差异单列 §4.1/§4.2）。

### 1.4 等价性测试（CI 侧）

```
cd packages/runtime && pnpm exec vitest run src/__tests__/equivalence/
Test Files  9 passed (9)
     Tests  40 passed (40)
```

关键用例（真实 pi 子进程驱动，非纯 fixture）：
- `live-reload.test.ts > store 级同构：实时累积 state == get_entries 重放 state（prompt 含工具调用）` ✅
- `live-reload.test.ts > store 级同构：bash 执行（独立持久化路径）+ 二次 prompt 的双通道合并` ✅
- `live-reload.test.ts > 混沌注入：乱序 / 丢失 / 重复投递 → 脏 state，权威重放后收敛到与纯重放一致` ✅
- `chaos.test.ts`（W22 混沌）3/3 ✅、`broadcast-getstate.test.ts` 2/2 ✅、`scalar-state-invalidation`（W7）6/6 ✅、`usage-queue-commands-invalidation`（W8）7/7 ✅

**覆盖关系说明（如实）**：测试为 fixture pi（真实 pi 子进程 + 真实 RPC 协议）驱动，**非本验收实况 session（01a019c7）驱动**。本 session 覆盖的形态（普通 prompt turn / bash 独立持久化通路 / 工具调用 turn / custom entry）分别被上述用例逐类覆盖，等价性（live ≡ reload）结论对该形态成立。

---

## 二、场景 5（subagent 单源一致）证据

### 2.1 四处状态对照

对照对象：`sa-19fe2896-81b4-4c04-898c-19541a6a1078`（general-purpose / read-package-name / background）。

| 数据源 | 取数方式 | 值 |
|---|---|---|
| ① 侧栏 SubagentList（live，完成注入后） | DOM（`button[title='子代理']` 面板 + spinner 探针） | `general-purpose · 2 turns · 87.5k tok`，**running**（animate-spin spinner + cancel 按钮），截图 `p3-before-02-subagent.png` |
| ② 主对话注入 turn | DOM | 「子代理已完成任务 ✅ package.json 中 "name" 字段的值是："xyz-agent"（版本 0.9.2）。」 |
| ③ `session.getSubagents` RPC（live） | CDP 经页面已 auth 的 3310 WS 实例直发 `{type:'session.getSubagents', id, payload:{sessionId}}`（脚本 `gate/p3-probe-subagents.js`，reply `session.subagents`） | `status:"running"`, turns:2, totalTokens:87508, 含 result |
| ④ 重开后（entry 扫描路径） | 重启重开后侧栏 DOM + 同 RPC 探针 | 侧栏无 spinner，`2 turns · 87.5k tok · 4m16s`；RPC `status:"closed", closedReason:"parent-shutdown", endedAt:1787139212400, elapsedSeconds:256`，turns/tokens/result 同上；截图 `p3-after-02-subagent.png` |

JSONL（`~/.xyz-agent-dev/pi/sessions/2026-08-19T11-27-50-291Z_01a019c7-….jsonl`）中的自描述 custom entry：

```
line 15: {"type":"custom","customType":"subagent-record","data":{"v":1,"id":"sa-19fe2896-…","agent":"general-purpose","task":"读取 …package.json…","slug":"read-package-name","status":"running","mode":"background","startedAt":1787138956399,…}}
line 23: {"…subagent-record…","data":{…,"status":"running","turns":2,"totalTokens":87508,"result":"`\"name\"` 字段的值是 **`\"xyz-agent\"`**，版本为 `0.9.2`。","sessionFile":"~/.xyz-agent-dev/pi/agent/subagents/…/…01a019c8-….jsonl",…}}
line 26: {"…subagent-record…","data":{…,"status":"closed","closedReason":"parent-shutdown","endedAt":1787139212400,…}}   ← kill dev 时扩展 shutdown hook 写入
```

### 2.2 W18 混沌等价测试（任务允许引用，不实况注入）

```
w18-record-entry-chaos.test.ts (2 tests) — 2 passed
 ✓ 场景 5 收尾：拦截 entry_appended 不投递 → bg-notify 兜底事件触发失效 → 重拉收敛到 entry 扫描权威值
 ✓ 双信号全丢的兜底：entry_appended 与 bg-notify 都被拦截 → 后续任一事件触发重拉，历史丢失 entry 一并收敛
```

（W18 为 mock RPC 层确定性测试，符合验收权威「live 层只需引用其测试名与通过状态」。）

### 2.3 判定与设计内差异说明

- **重开后四处一致达成**：侧栏 = RPC = entry 扫描 = closed（parent-shutdown），turns=2 / totalTokens=87508 / result 摘要（"xyz-agent" 0.9.2）四处相同；主对话注入 turn 持久且内容一致。subagent-record custom entry 存在（3 条状态机快照）。→ **PASS**
- **设计内差异（非缺陷，如实记录）**：live 完成注入后 record 保持 `running` 而非 closed——这是 subagent-workflow v4 B-1 的 **running-resumable** 设计（`extensions/subagent-workflow/src/execution/finalize-record.ts:229-233`：轮终回 running，旧 idle 折入 running，可冷路径 resume；closed 是显式关闭/parent-shutdown 后的统一终态）。验收标准字面的「closed」在重开后达成；live 态四处同为 running（①③一致 + ②注入正文含相同 result）单源自洽。
- parent-shutdown 终态化的语义合理性：app 进程死亡后后台 subagent 不可能继续 running，kill 时写终态 entry（JSONL 第 26 行，mtime 与 kill 时刻吻合）是正确行为。

---

## 三、高危问题归因（P1P2 报告第三节问题 2）

### 3.1 归因结论

**复现成立（本环境一手复现）；根因不在本计划（data-source-governance）引入的代码，属计划外既有链路。**

- tmp 附着管线（拷贝源 JSONL 到 `os.tmpdir()` → `switchSession(tmpFile)` → finally unlink）由 commit **`40f2e0300`「feat(W1): sidecar metadata for session_end」（2026-07-17，sidecar metadata 计划）** 引入——引入前 restoreSession 是 `client.switchSession(target.filePath)` 直切原文件（对话落原 JSONL，无此问题）。
- 本计划 **W11（`5ae15ff46`，2026-08-19）** 的 diff 仅将 cwd 死路径降级从「源文件直写 patchSessionCwd」迁移为「tmp 首行 header 变换 applyHeaderCwdFallback」，**未改变 tmp 拷贝/switchSession/unlink 任何行为**（git show 逐行核对）。

### 3.2 根因链（代码位置）

1. `packages/runtime/src/services/session/session-lifecycle.ts:516-523`（restoreSession）：`writeFileSync(join(tmpdir(), \`xyz-session-${sessionId}-${Date.now()}.jsonl\`), cleaned)` → `client.switchSession(tmpFile)` → finally `unlinkSync(tmpFile)`。注释「pi 已读入内存」的假设不成立。
2. pi 侧（`~/Code/git-fork/pi-mono-workspace/main/packages/coding-agent/src/core/agent-session-runtime.ts:207`）：`switchSession` → `SessionManager.open(sessionPath)` → `session-manager.ts setSessionFile()`：`this.sessionFile = resolvePath(sessionFile)`——**直接采用传入路径为永久写入目标，无复制回 sessions 目录的逻辑**。
3. runtime unlink tmp 后，pi 后续轮次 `_persist` 以 append 模式写 sessionFile（tmp 路径）→ **重建 tmp 文件，只写增量 entry**（实测 tmp 首行非 session header，是 message entry）。
4. 原 JSONL 永不更新；app 重启后新 runtime 按 sessions 目录扫描原 JSONL → restore 后的对话全部丢失。pi 进程存活期间数据仅在 runtime 内存 + tmp 增量文件。

### 3.3 本环境一手复现证据（时间线）

| 时刻 | 事件 | 证据 |
|---|---|---|
| 19:27-19:29 | create 新 session 01a019c7，三步操作完成 | JSONL 25 行（md5 983ee786） |
| 19:33:32 | 第 1 次重启 dev，重开 session（= restore：tmp 拷贝 + switchSession） | 原文件追加 line 26（kill 时 parent-shutdown entry）→ 26 行 |
| 19:35 | **restore 后发「记住这句暗号：重启验证第一次」**，UI 正常收到回复「重启验证第一次。」 | **原 JSONL 停在 26 行 / mtime 19:33:32 零更新**；tmp 出现 `$TMPDIR/xyz-session-01a019c7-…-1787139239905.jsonl`（1220B，含该 user 消息 + assistant thinking 增量） |
| 19:36 | 第 2 次重启 dev，重开 session | **「重启验证第一次」整轮从 UI 消失**，用量 44.2K→44.1K 回退；grep 计数：原 JSONL 0 处 / tmp 2 处 |

截图：`p3-loss-after-second-restart.png`（丢失后状态）。另：P1P2 gate 期间两个 session 的同类 tmp 孤儿（`xyz-session-019ffd0c-18dc-…` 13 行、`xyz-session-019ffd0c-f84f-…` 10 行，均只含 restore 后增量）在 `$TMPDIR` 长期残留，与前序报告互证。

补充维度：kill 时 pi 内存缓冲未 flush，tmp 也只有 3 行（assistant 正文缺失）——即 restore 路径下数据同时暴露于「落错文件」与「kill 前未 flush」双风险。

### 3.4 对场景 3 判定的影响

按任务判定规则：「复现但根因在本计划外既有链路 → 场景 3 按实况判定 + 单列计划外已知问题」。场景 3 实况：三步操作在 create 路径 session 上执行（验收步骤未要求 restore 起点），单次重启重开一致 → **场景 3 PASS**。**边界条件（如实声明）**：若三步操作发生在「restore 后的 session」上，第二次重启将丢失全部新增对话，届时重开一致性标准无法满足。建议该问题单独立项修复（方向：switchSession 后将 pi sessionFile 指回原 JSONL 路径，或 restore 管线改为 pi 认可的会话目录内文件）。

---

## 四、验收中发现的其他问题

1. **[中] turn-meta 工时指示 live 期不复位**：subagent 注入 turn 完成后仍显示「工作中11s」（P1P2 报告问题 1 同族，本次无断连也复现）；重开后经 entry 时间戳重建显示「已工作12s」。纯状态感知问题，不影响内容一致性。
2. **[中] `!` bash live 实时通路输出丢失**：live 期 UI 显示 `[protocol error: malformed bash response from pi]`，而 pi stdout tee 中 response 完整（`{"output":"/Users/zhushanwen/Stock\n","exitCode":0,…}`），runtime 收到的 `data` 为空（runtime log `bash: malformed PiBashResult … data=`）。**重开后 entry 扫描路径显示正确输出**（pwd / exit 0 / /Users/zhushanwen/Stock）——持久化通路正确，仅实时通路 data 字段解析异常。该 shape guard 由 `e5c9e33e2`（2026-07-26，PR #116 review fixes）引入，亦属计划外既有，建议单独排查 pi bash response 的字段位置。
3. **[低] 重开后 session 名显示回退为文件名**：重开后顶部显示「01a019c7.jsonl」（P1P2 报告问题 4 的 pre-auth drop 同族表现），对话内容与功能不受影响。

---

## 五、附件清单（均在 gate/ 目录）

| 文件 | 说明 |
|---|---|
| p3-gate-report.md | 本报告 |
| p3-00-initial.png / p3-01-newtask.png | 初始状态 / 新建任务 |
| p3-02-subagent-list.png | live 期 subagent 侧栏（running spinner） |
| p3-before-01-chat.png / p3-before-02-subagent.png | 重启前对照基线（对话流 / subagent 侧栏） |
| p3-after-00-restart-landing.png / p3-after-01-chat.png / p3-after-02-subagent.png | 重启后重开（landing / 对话流 / subagent 侧栏） |
| p3-loss-after-second-restart.png | 高危问题丢失现场（第二次重启后） |
| p3-probe-subagents.js | session.getSubagents RPC 探针（CDP 复用页面已 auth WS） |

## 六、环境收尾

- 3 次 `pnpm dev` 均为精确 kill 本方进程组（`kill -TERM -51196 / -53337 / -54534`），验收结束端口 1420/9222/3310 全部确认清空。
- 打包版 TaiJi.app 全程未触碰；测试数据留在 `~/.xyz-agent-dev/`（正常使用痕迹）。
- `$TMPDIR` 下 3 个 `xyz-session-*.jsonl` 孤儿文件保留作证据未清理（OS 重启会自动清 tmp）。
