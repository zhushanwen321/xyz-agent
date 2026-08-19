# Final Gate 行为级验收报告（restore-fork-attach-fix：V1 / V2a / V2b / V3 + G-X）

> 验收对象：`docs/architecture/restore-fork-attach-fix.md` §4 验收表 V1-V3（V4-V7 已由 W1/W2 verifier 覆盖，本报告不重复）。
> 执行环境：真实 `pnpm dev` Electron app + 真实 pi 子进程（dev 资源 pi `apps/electron/resources/pi/pi-darwin-arm64`，默认模型 MiMo-V2.5-Pro），无 mock。数据目录 dev 隔离 `~/.xyz-agent-dev/`。
> 执行方：gate executor subagent；未修改任何生产代码/文档；无 git 写操作。
> 验收时间：2026-08-19 22:08-22:42（本机）。全程 8 次 dev 启停，均精确 kill 本方进程组（PGID 见 §5），结束端口 1420/9222/3310 全部确认清空；打包版 TaiJi.app（用户在用，全程未触碰）不受影响。

## 总结论：PASS（4/4 场景 + G-X 全部通过）

| 场景 | 结论 |
|------|------|
| G-V1 restore 现代文件后对话落盘（前次 gate 数据丢失复现点） | **PASS**——同款操作序列下 bug 反转：暗号轮落登记原文件、二次重启零丢失、用量无回退 |
| G-V2a restore legacy session_end 文件（含 AI 失忆防线） | **PASS**——F3 归一化 strip session_end 原路径落回；**AI 能复述「香蕉37」**（树索引未断链）；重开幂等零变换 |
| G-V2b restore cwd 死路径文件 | **PASS**——不抛 MissingSessionCwdError；header cwd 归一化为 homedir、路径不变；AI 复述「芒果88」；对话落原文件；重开一致且幂等 |
| G-V3 fork 后对话落盘 | **PASS**——暗号 forkF9 轮完整落 fork 文件；header parentSession 血缘指针指向源文件；源文件字节不变；重开一致 |
| G-X attach 断言不误伤 | **PASS**——全程 restore/fork/重开共 9 次附着，runtime log 零 attach 断言 throw；`$TMPDIR` 零新增孤儿；sessions 目录零 `.tmp-migrate-*` 残留 |

与前次 gate（`2026-08-19-data-source-governance-p1p4/gate/p3-gate-report.md` §3.3）的关键对照：前次同场景「restore 后发暗号 → 原文件 mtime 零更新 → tmp 出现孤儿 → 第二次重启整轮消失、用量回退」。本次 G-V1 相同时序下：原文件 mtime 22:10:53→22:14:59 推进、7→16 行增长、tmp 零新增、第二次重启后暗号轮完整在列、用量 43.4K→50.5K 单调无回退。**P0 数据丢失 bug 在真实 app 环境下确认修复。**

---

## 一、G-V1：restore 现代文件后对话落盘（核心场景）

### 1.1 操作时间线

| 时刻 | 操作 | 结果 |
|------|------|------|
| 22:10 | boot1 新建会话，发「介绍自己，一句话即可」 | 完整回复；文件 7 行 / md5 `34ae2e2b` / mtime 22:10:53 / 1839B；用量 43.4K·4% |
| 22:12 | `kill -TERM -44788` 精确重启（boot2） | 端口清空后重起，侧栏点开该会话（= restoreSession 路径，F2 直附着，restore 本身零写：文件仍 7 行 / md5 不变 / mtime 不变） |
| 22:14:40 | 发「记住这句暗号：gate验证X7」 | **发消息期间原文件推进：7→16 行、md5 `34ae2e2b`→`c2816876`、mtime 22:10:53→22:14:59、1839B→30076B**；line 8 user 暗号 + line 16 assistant「已记住。暗号 gate验证X7 已存入…」完整在列；用量 43.4K→50.5K·5% |
| 22:15 | `kill -TERM -31908` 第二次重启（boot3） | kill 后文件完好（16 行 / md5 `c2816876` 不变——落盘数据不依赖进程存活） |
| 22:16 | 重开该会话 | **暗号轮完整在列**（消息 + 回复 + 已工作14s/思考×4/工具×3 meta）；用量 50.5K·5% 无回退 |

### 1.2 通过标准逐项判定

| 标准 | 判定 | 证据 |
|------|------|------|
| 暗号轮完整在列 | PASS | UI innerText 含「记住这句暗号：gate验证X7」+「已记住。暗号 gate验证X7 已存入 ~/.xyz-pi-memory/MEMORY.md」（截图 v1-03） |
| 发消息期间原文件 mtime 推进、行数增长（对话落登记文件，非 tmp） | PASS | 7→16 行 / mtime +4m06s / md5 变更，文件为 sessions 目录登记原文件 |
| `$TMPDIR` 无新 `xyz-session-*.jsonl` 孤儿 | PASS | 全程仅 3 个**前次 gate 遗留**基线孤儿（mtime 18:55/19:12/19:35，均早于本 gate 开始 22:08；见 §6） |
| 用量无回退 | PASS | 43.4K→50.5K→50.5K（JSONL totalTokens 终值 50400/50501） |

**G-V1 判定：PASS**

---

## 二、G-V2a：restore legacy session_end 文件（含 AI 失忆防线断言）

### 2.1 fixture 构造（v2，最终采用）

`~/.xyz-agent-dev/pi/sessions/2026-08-19T14-30-22-360Z_0480a089-2d7a-487c-8d84-e16b107f31f1.jsonl`（9 行，手工构造）：真实 header（version 3，cwd=/Users/zhushanwen/Stock 存活）+ model_change / thinking_level_change / session_info + 两轮含「暗号香蕉37」的 user/assistant message entries（assistant 含真实形态 usage 结构）+ 末行 `{"type":"session_end","outcome":"done","reason":"stop","timestamp":"…"}`（无 id/parentId，模拟 W4 旧格式）。基线：9 行 / md5 `0f0cdb9d` / mtime 22:30:22。

> 首版 fixture（`…_6270c168-….jsonl`）assistant 消息缺 `usage` 字段，restore 与归一化本身全部正确，但问暗号时 pi 进程内 getState（pi-mono `agent-session.ts:2979` 对 assistant 消息无守卫读 `usage.input`）抛 `undefined is not an object (evaluating 'message.usage.input')`，prompt 失败。**定性：fixture 保真度缺陷（真实 pi 产物必有 usage），非修复缺陷**——该文件留在 sessions 目录（8 行归一化形态）作过程痕迹。v2 fixture 补齐 usage 后全流程通过。

### 2.2 操作时间线

| 时刻 | 操作 | 结果 |
|------|------|------|
| 22:31 | boot5 侧栏点开该会话（restoreSession，含 session_end → 走 F3 归一化） | **同路径归一化**：9→8 行（session_end 行被 strip，`type==session_end` 精确计数 0）、md5 `0f0cdb9d`→`9a03eb95`、mtime 22:30:22→22:31:35（rename-over）、header cwd 不变（存活路径不 fallback）、无双文件（`ls *0480a089*` 唯一）、零 `.tmp-migrate-*` 残留 |
| 22:31:54 | 问 AI「这个会话历史里记录的暗号是什么？只回答暗号本身。」 | **AI 回答「香蕉37」**——历史进入 LLM 上下文，树索引未断链（W2 设计核心防线）；该轮落原文件：8→11 行 / mtime 22:31:58 |
| 22:32-22:33 | `kill -TERM -57006` 重启（boot6）→ 重开该会话 | **幂等零变换**：文件字节级不变（11 行 / md5 `a0ee30af` / mtime 22:31:58 三项全同），session_end 仍为 0，UI 历史完整含暗号问答轮 |

### 2.3 通过标准逐项判定

| 标准 | 判定 | 证据 |
|------|------|------|
| restore 不报错 | PASS | 无 error、会话正常打开（截图 v2a-02） |
| **AI 能复述「香蕉37」**（上下文未断链） | PASS | UI 回复正文「香蕉37」（JSONL line 11 assistant 亦含） |
| session_end 行被 strip、归一化落回原路径、无新文件/无双文件 | PASS | `type==session_end` 计数 0；路径不变；同 id 唯一文件 |
| 再次 restore 零变换直附着（幂等） | PASS | 重开后 md5/mtime/行数三项字节级不变（F2 收敛，F3 至多执行一次） |

**G-V2a 判定：PASS**

---

## 三、G-V2b：restore cwd 死路径文件

### 3.1 fixture 构造

`~/.xyz-agent-dev/pi/sessions/2026-08-19T14-33-12-713Z_670fe5df-8977-472a-a2ce-f34b85825b48.jsonl`（6 行）：header `cwd=/tmp/gone-1787149992`（构造时确认不存在）+ 一轮「暗号芒果88」历史（assistant 含真实 usage）。基线：6 行 / md5 `486653c9` / mtime 22:33:12。

### 3.2 操作时间线

| 时刻 | 操作 | 结果 |
|------|------|------|
| 22:34 | boot6 侧栏点开（cwd 死 → 走 F3 归一化 cwd fallback） | **restore 成功，未抛 MissingSessionCwdError**：header 首行 cwd `/tmp/gone-1787149992` → `/Users/zhushanwen`（homedir），路径不变（同 id 唯一文件）、6 行结构保留、md5 `486653c9`→`f7996d22`、mtime 22:34:14 |
| 22:34:41 | 问 AI「这个会话历史里记录的暗号是什么？」 | **AI 回答「芒果88」**；该轮落原文件：6→15 行 / mtime 22:34:53 |
| 22:35-22:36 | `kill -TERM -60455` 重启（boot7）→ 重开 | **一致且幂等**：15 行 / md5 `86316ac0` / mtime 22:34:53 字节级不变；header cwd 保持 homedir；UI 历史 + 暗号问答轮完整（截图 v2b-02） |

**G-V2b 判定：PASS**（restore 不阻塞用户、cwd 归一化正确、对话落原文件、重开一致）

---

## 四、G-V3：fork 后对话落盘

### 4.1 操作时间线

| 时刻 | 操作 | 结果 |
|------|------|------|
| 22:37 | boot7 打开 G-V1 会话（源文件 16 行 / md5 `c2816876`），hover turn-2 点「fork 提问」 | composer 进入「将发到新分支 · 与主线隔离」态（截图 v3-02） |
| 22:37:58 | 发「记住暗号 forkF9」 | fork 文件生成：`2026-08-19T14-37-58-650Z_efd9fa53-….jsonl`；回复「已记住。暗号 forkF9 已追加到“暗号”分类」落 **fork 文件**（24 行 / md5 `d411e8eb` / mtime 22:38:16，含继承的源两轮历史 + forkF9 轮 line 17-24）；**源文件字节不变**（16 行 / md5 `c2816876` / mtime 22:14:59 三项全同）；UI 出现「已在新分支提问 / 查看分支」，点开分支视图完整（截图 v3-03） |
| 22:38-22:39 | `kill -TERM -64861` 重启（boot8）→ 重开 fork 会话 | **fork 文件字节级不变**（24 行 / md5 `d411e8eb` / mtime 22:38:16）；UI 完整显示继承历史 + forkF9 轮；用量 51K·5%（截图 v3-04） |

### 4.2 血缘指针核验

fork 文件 header（line 1）：

```json
{"type":"session","version":3,"id":"efd9fa53-d94c-406b-ab42-6c79aaa24d29","timestamp":"2026-08-19T14:37:58.650Z","cwd":"/Users/zhushanwen/Stock",
 "parentSession":"/Users/zhushanwen/.xyz-agent-dev/pi/sessions/2026-08-19T14-10-48-642Z_01a01a5c-40c2-7c92-9d53-41397e2636cc.jsonl",
 "forkEntryId":"38b68738"}
```

`parentSession` 精确指向源文件完整路径——血缘未断。fork 同时继承 `.project.json`（projectId=测试项目）等 sidecar，侧栏显示「fork 自 …/01a01a5c….jsonl」标注。

**G-V3 判定：PASS**

---

## 五、G-X：attach 断言不误伤 + 环境完整性

- **附着次数**：全程 9 次（G-V1 restore×2 + create×1、G-V2a v1 restore×1、G-V2a2 restore×2、G-V2b restore×2、fork attach×1），runtime log（`~/.xyz-agent-dev/logs/runtime-2026-08-19.log`）中 attach 断言相关 throw / mismatch / 「登记路径不一致」**零命中**——正常流程零误伤。
- **gate 窗口（14:10Z 起）全部 ERROR 仅 2 条**，均与 attach 无关：① `[rename-session] model not available, skipping`（G-V1 建会话时扩展的良性跳过）；② 首版 G-V2a fixture 的 `message.usage.input` 错误（§2.1 已归因为 fixture 保真度，v2 复测消除）。`prompt failed` 全量检索仅此 1 条。
- **8 次 dev 启停全部精确 kill 本方进程组**，PGID 依次：44788 / 31908 / 73080 / 74214 / 57006 / 60455 / 64861 / 69449；结束终检：1420/9222/3310 全空、全部 PGID 成员数 0。启动前均先 `lsof` 确认端口空闲（无并行会话冲突）。
- **打包版 TaiJi.app**（用户在用）全程未触碰，结束时确认仍在运行。

**G-X 判定：PASS**

---

## 六、$TMPDIR 与 sessions 目录终检

| 检查项 | 结果 |
|--------|------|
| `$TMPDIR/xyz-session-*.jsonl` 孤儿 | 仅 3 个前次 gate 遗留基线（`…-019ffd0c-18dc-…-1787137829319` / `…-019ffd0c-f84f-…-1787136526690` / `…-01a019c7-…-1787139239905`，mtime 18:55/19:12/19:35 均早于本 gate 开始）——**本 gate 零新增**（I2 不变量成立） |
| sessions 目录 `.tmp-migrate-*` 残留 | 0 |
| 暗号落点分布（grep 全 sessions 目录） | gate验证X7 → 仅 G-V1 文件及其 fork（继承历史，符合预期）；香蕉37 → 仅两个手工构造的 G-V2a fixture；芒果88 → 仅 G-V2b 文件；forkF9 → 仅 fork 文件。**无任何暗号落入 tmp 或登记外文件** |

## 七、文件证据总表（终态）

| 文件（`~/.xyz-agent-dev/pi/sessions/`） | 终态 | 角色 |
|---|---|---|
| `2026-08-19T14-10-48-642Z_01a01a5c-….jsonl` | 16 行 / `c2816876…` / 22:14:59 | G-V1 登记文件 + G-V3 fork 源 |
| `2026-08-19T14-16-30-856Z_6270c168-….jsonl` | 8 行 / `9a03eb95…` / 22:26:19 | G-V2a 首版 fixture（过程痕迹，归一化形态） |
| `2026-08-19T14-30-22-360Z_0480a089-….jsonl` | 11 行 / `a0ee30af…` / 22:31:58 | G-V2a v2 fixture（正式验证） |
| `2026-08-19T14-33-12-713Z_670fe5df-….jsonl` | 15 行 / `86316ac0…` / 22:34:53 | G-V2b fixture（cwd 已归一化 homedir） |
| `2026-08-19T14-37-58-650Z_efd9fa53-….jsonl` | 24 行 / `d411e8eb…` / 22:38:16 | G-V3 fork 文件（parentSession → 01a01a5c 源文件） |

## 八、截图清单（`/tmp/gate-final-shots/`，随 OS tmp 生命周期）

| 文件 | 内容 |
|------|------|
| v1-00-initial.png / v1-01-newtask.png | 初始状态 / 新建会话 |
| v1-02-passphrase-sent.png | G-V1 restore 后暗号轮已发送 |
| v1-03-after-2nd-restart.png | **G-V1 关键证据：第二次重启后暗号轮完整在列（50.5K·5%）** |
| v2a-00-project-switcher.png | 项目切换（见 §九-1 环境说明） |
| v2a-01-asking.png | G-V2a 首版 fixture 问暗号（fixture usage 错误现场） |
| v2a-02-idempotent-reopen.png | **G-V2a 关键证据：重开后历史 + 香蕉37 问答完整** |
| v2b-01-asked.png / v2b-02-after-restart.png | **G-V2b 关键证据：芒果88 问答 / 重启重开一致** |
| v3-01-fork-clicked.png / v3-02-fork-panel.png | fork 入口 / 「将发到新分支」态 |
| v3-03-branch-view.png | fork 分支视图（forkF9 轮完整） |
| v3-04-after-restart-reopen.png | **G-V3 关键证据：重启重开 fork 一致（51K·5%）** |

## 九、过程发现（非阻断，如实记录）

1. **侧栏项目视图过滤**（环境特性，非缺陷）：手工构造的 session 无 `.project.json` 绑定，在「测试项目」激活视图下被 SessionList 项目过滤隐藏（renderer `SessionList.vue` visibleGroups 按 projectId 过滤）；切换到默认项目视图后立即可见。fork 则继承了源的项目绑定出现在测试项目视图。全程经 pinia 调用与 UI 完全同一 action `setActiveProject` 切换。
2. **首版 G-V2a fixture 的 usage 缺失**（§2.1）：pi 侧 getState 对 assistant 消息 usage 无守卫，fixture 必须带真实形态 usage——为后续构造 legacy fixture 的注意事项。
3. **G-V2b 归一化后旧分组标签残留**（纯展示）：cwd 归一化为 homedir 后，侧栏分组快照仍按扫描时的旧 cwd（`gone-1787149992`）显示组名，重启后按新 cwd（zhushanwen）分组——列表快照时序差异，不影响任何数据/附着行为。
4. **renderer 列表刷新时机**：新建文件需 dev 重启（或触发 config.sessions 广播的动作）后才进侧栏——扫描 TTL 1s 内可发现，但 renderer 仅在广播/启动时拉取列表。属已知交互形态，与本次修复无关。

## 十、并行改动披露（证据完整性，按规则 0 未触碰）

本 gate 开始于干净工作区（HEAD = `ec38e546f`，即 W2 commit），结束时空降**非本会话的并行改动**（认知外，未提交、未触碰、未还原）：

| 文件 | mtime | 内容（只读 diff 核实） |
|---|---|---|
| `packages/runtime/src/infra/pi/process-manager.ts` | 22:34:59 | **纯注释改动**（withEphemeralPi spawn cwd 注释更新），零行为变化 |
| `packages/runtime/src/services/session/session-lifecycle.ts` | 22:44:32 | renameSession 非活跃分支增强（p1p4-closure W1：未命中 throw + 附着前归一化）+ **把 restoreSession 的 F3 判定/变换抽取为 `normalizeInactiveSessionFileIfNeeded` 共用 helper**（自述「行为不变」；diff 核实：判定条件、变换内容、调用位置、直附着 + assertPiSessionFile 断言序列与 HEAD 语义一致） |
| `test/session-lifecycle-rename.test.ts` + 新增 `__tests__/session-lifecycle-rename-inactive.test.ts` | 22:39:40/46 | rename 相关测试，不影响运行时 |

**对证据的影响评估**：G-V1 / G-V2a / G-V2b 主流程（boot1-6，22:08-22:35）全部在干净 HEAD 代码上执行；G-V2b 重开与 G-V3（boot7-8，22:35-22:40）的 runtime 可能编译到重构进行中的 session-lifecycle.ts——但该重构对 restoreSession 行为不变、不触碰 forkSession（forkSession 无 diff hunk），且这些场景全部 PASS（若重构中途态有行为差异，表现会直接落入各场景失败标准）。结论不受影响；建议主 agent 对并行改动按规则 0 知悉并裁决。

## 十一、环境收尾声明

- 唯一写入仓库的文件 = 本报告；零代码/文档改动；无 git add/commit/push。
- 8 次 `pnpm dev` 进程组全部精确终止（§5），结束端口 1420/9222/3310 确认清空；打包版 TaiJi.app 未触碰。
- /tmp 探针脚本与 dev 日志已清理；截图留 `/tmp/gate-final-shots/`（报告证据引用，随 OS tmp 生命周期）。
- 测试 session 数据留在 `~/.xyz-agent-dev/pi/sessions/`（正常使用痕迹）。
