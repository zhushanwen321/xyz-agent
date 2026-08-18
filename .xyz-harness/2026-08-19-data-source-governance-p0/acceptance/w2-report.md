# W2 验收报告：数据登记表初版（verifier 独立验收）

> 验收人：verifier subagent（对抗式独立验收，builder 自报全部待证实）
> 日期：2026-08-19
> 验收基线：commit `118e6169e` 的 w2-acceptance.md；工作区 HEAD = `9dcffa736`（W1，基线的直接子提交）
> 总结论：**PASS**（附 1 项 minor 偏差记录，不阻断；见「发现的问题」）

## 1. 防篡改检查

| 检查项 | 命令 | 结果 |
|---|---|---|
| 验收权威 1 | `git diff 118e6169e -- .xyz-harness/2026-08-19-data-source-governance-p0/acceptance/w2-acceptance.md` | 空（无篡改） |
| 验收权威 2 | `git diff 118e6169e -- docs/architecture/data-source-governance-plan.md` | 空 |
| 验收权威 3 | `git diff 118e6169e -- docs/architecture/data-source-governance.md` | 空 |
| 全量扫描 | `git status -uall --porcelain` | 仅 2 项：`M ledger.md`（主 agent 豁免）+ `?? docs/architecture/data-source-registry.md`（W2 交付物）——无越界改动、无代码文件改动 |

sha256 快照（验收时点）：

```
838862bb23692daa822bc4a9f178d3e895e70ef963516cf3bb1cb1383b895d48  w2-acceptance.md
f76097ed3055fd88b6d29e6bdbcc0c5216d78e0dc14e105519ca6795cc1f06c4  data-source-governance-plan.md
34adb1120075edecd406cd577232129dd6e85ec553ef0d0dbfc3a98641efdcb2  data-source-governance.md
68d3082fed239225a83ed8c76eeef6ad1f03d41939474e24c1e4c05377345071  data-source-registry.md（交付物）
```

## 2. 通过命令实跑（w2-acceptance.md 三条）

1. **行数**：`grep -c "^| " docs/architecture/data-source-registry.md` = **29**。人工计数：主表 13 数据行（#1-#12 + P1 plugin）+ 写点表 6 行 + 例外表 7 行 = 26 数据行 + 3 表头行 = 29。覆盖验收要求的 12 数据行 + 1 plugin 声明 + 4 例外 + 2 合法形态 + 1 非写点注记（20 行）另含 #1 写点处置表 6 行（验收内容第 4 条要求）。**通过**。
2. **内容级**：「移除期限 = W11」7 处命中；sessionName（2 行）/ thinkingLevel（2 行）/ 占位值（4 行）三类区分表述在位（§2 专节 + 主表行内双写）；「不单独登记」2 处（#1 行 + §2 第 1 条）；#1 六处写点处置去向在位（§3 表 L44-49：2 已移除 + 3 带 W11 期限 + 1 创建型保留）；例外②③含竞态边界表述。**通过**。
3. **一致性**：
   - `grep -n "persistSessionName" session-lifecycle.ts` → `:331`（代码，非活跃 else 分支）+ `:335`（注释）——代码命中仅剩非活跃分支 1 处。**通过**。
   - `grep -n "persistHandedOff\|patchSessionCwd" session-file-utils.ts` → `:455` persistHandedOff 实现 / `:521` patchSessionCwd 实现均在位（另有注释命中 :145/:479/:515/:529）。**通过**。
   - `grep -rn "tryPersistLabel\|labelPersisted" packages/runtime/src --include="*.ts"` → 0 命中（exit 1）。**通过**。

## 3. 真实性抽查（源码逐条核对记录）

### 3.1 12 条数据行 vs 父文档 §2.2

12/12 一一对应，无遗漏、无编造类别。权威源逐条一致：#1 pi session_info+内存、#2 pi 文件+agent 态、#3 get_session_stats、#4 get_state、#5 pi agent 态、#7 session 文件 entries、#8 xyz 扩展 record-store、#9 xyz 扩展 RunStore、#10 git 工作区、#11 get_state.isStreaming、#12 get_commands。#6 登记表采 D6 终态口径（深度=pi pendingMessageCount / 内容=renderer 提交日志）——D6 是父文档自身裁决（L237「已核实为终态」），非编造。plugin sessionData 条目与 §2.2 覆盖范围说明（L106）逐句对得上。

### 3.2 空值语义三条 vs D1b

| D1b 原文 | 登记表 §2 | 判定 |
|---|---|---|
| owner 快照整字段覆盖含显式空值；sessionName 空 = 合法态（未命名）；label 同链不单独登记「可守卫」 | 第 1 条完整落字（含 wire 层归一「key 缺失 = 未命名 = 覆盖」） | 一致 |
| thinkingLevel 是具体字符串联合类型不含 undefined，无空值语义永不 guard；wire 层 key 缺失按协议异常 | 第 2 条同表述 | 一致 |
| 磁盘扫描占位值 modelId:''/tokenCount:0 不覆盖已知真值（session-scanner.ts:81-82） | 第 3 条同表述 + 实测 `session-scanner.ts:81-82` 确为 `modelId: ''` / `tokenCount: 0`（真实路径 `packages/runtime/src/services/session/session-scanner.ts`，登记表未写目录与父文档口径一致） | 一致 |

无混淆。**通过**。

### 3.3 例外七项源码逐条核实（重点抽查）

| 项 | 登记表声明 | 源码实测 | 判定 |
|---|---|---|---|
| ① 非活跃 rename 直写 | `session-lifecycle.ts:331` | `:327 else` 分支内 `:331 this.sessionStore.persistSessionName(...)`；`:319-323` 活跃分支为 `client.setSessionName` RPC（无直写） | 属实 |
| ② persistHandedOff | `:455` 实现、`:467` openSync('a')；调用链 handoff-service.ts:286 → session-service.ts:1076 → session-store.ts:88 | `:455 export function persistHandedOff`、`:467 openSync(filePath,'a')`；`services/handoff-service.ts:286 markHandedOff` 调用、`session-service.ts:1070` 签名 `:1076` 体内调用、`session-store.ts:88` 透传 | 属实 |
| ③ patchSessionCwd | `:521` 实现、`:543` atomicWrite；唯一生产调用 `session-lifecycle.ts:434`；PRECONDITION pi spawn 前；mtime<1s 防御 | `:521` / `:543 atomicWrite(filePath, ...)`；grep 全仓唯一生产调用 = `session-lifecycle.ts:434`（restoreSession cwd 降级闭包内）；docstring `:513` PRECONDITION；`:527-529` mtime 防御警告 | 属实 |
| ④ 队列唯一提交方 | 入口 session-message-handler.ts | `:419 case 'message.steer'` / `:431 case 'message.follow_up'` 入口在位（命令名偏差见 §6） | 语义属实 |
| ⑤ sidecar 四后缀 | `.meta.json` :146 / `.project.json` :223 / `.preset.json` :281 / `.handoff.json` W11 迁入 | `:146 atomicWrite(filePath+'.meta.json')`、`:223 projectSidecarPath`、`:281 presetSidecarPath` 三处实测在位 | 属实 |
| ⑥ fork 创建型 | `session-fork.ts:74` 函数、`:175` writeFile | `:74 export async function createForkedSessionFile`、`:175 await writeFile(newFilePath, ...)` | 属实 |
| ⑦ 非写点注记 | 删除链 + pi-maintenance renameSync | `session-lifecycle.ts:346-349` destroySession→trash 在位；`infra/pi/pi-maintenance.ts:44/:88/:93` renameSync 目录迁移在位 | 属实 |

### 3.4 #1 六写点处置 vs W1 后代码现状

写点 1（活跃 rename）：`:319-323` RPC 在位、无 persistSessionName——已移除属实。写点 2（tryPersistLabel）：全仓 0 命中——已移除属实；`persistExplicitLabel` 在 `session-lifecycle.ts:116`（登记表写 :116，实测一致）。写点 3/4/5：见上表。写点 6：见上表。**6 处全部与源码现状一致**。

### 3.5 plugin sessionData 条目 vs session-data-store.ts

WriteBackCache（:16/:34/:51）、per-write debounce 500ms（`FLUSH_DEBOUNCE_MS = 500`）、定时 flush 5s（`FLUSH_INTERVAL_MS = 5_000`）、磁盘恢复（文件头声明）、消费者 PluginService/session-data-api/plugin-rpc-setup 经唯一类入口——**描述全部属实**。

### 3.6 额外抽查（主表行内引用）

`rpc-client.ts:519 setSessionName`（实测 :519 方法 + :512 JSDoc）、`index.ts:298 sessionMetaCache.setLabel`（session_info_changed 回写）、`session-lifecycle.ts:326 setLabel`（rename 回写）——metaCache「2 生产写点」计数属实。

## 4. 行为对抗抽查

### 4.1 反向写点扫描（SSOT 完备性检验）

`grep -rn "openSync\|appendFile\|writeFile\|atomicWrite" packages/runtime/src --include="*.ts" | grep -iv test` 全量命中逐条分类：

**指向 sessions 目录的写点全集 = 7 处，全部有登记条目**：

| 写点 | 登记条目 |
|---|---|
| session-file-utils.ts:430（persistSessionName openSync 'a'） | §3 写点 3 |
| session-file-utils.ts:467（persistHandedOff openSync 'a'） | §3 写点 4 |
| session-file-utils.ts:543（patchSessionCwd atomicWrite） | §3 写点 5 |
| session-fork.ts:175（writeFile 新建） | §3 写点 6 |
| session-file-utils.ts:146/.meta.json、:223/.project.json、:281/.preset.json | 例外⑤ sidecar 家族 |

**不指向 sessions 目录（不属写点定义）**：session-lifecycle.ts:464/:623（`join(tmpdir(), ...)` restore/fork tmp 拷贝——plan W3 条件 B② 明言的 tmpdir 通道）、session-service.ts:1415（getAttachmentsDir/tmpdir 图片落盘）、:1497（segments.json 在 `getAttachmentsDir(sessionId)` 内，非 sessions 目录）。其余命中（logger/json-store/fs-utils/config-store 族/quota/auth/plugin-storage/project-store 等）均为 configDir 或 xyz 自有目录写，非 sessions。

**未发现「登记表未覆盖的真实写点」。完备性检验通过。**

### 4.2 表格结构

`awk -F'|'` 列数检查：主表 15 行全部 8 字段（7 数据列 = plan 步骤 1 的 7 字段）、写点表 8 行全 4 字段（3 列）、例外表 9 行全 5 字段（4 列）。各表内列数一致，无渲染错乱。

### 4.3 行号偏差声明核对

表头声明第 4 条 vs 实测：`:302→:331` ✓、`persistHandedOff :464→:455（append :467）` ✓、`patchSessionCwd :518→:521（atomicWrite :543）` ✓。三组偏差全部如实记录。

## 5. 裁决清单（builder 上报 2 项）

1. **#10 FileChanges「无专门 wave」**：核实父文档 §5 单元表全 19 单元（P0.1-P4.3）——无 FileChanges 双管线收敛单元；父文档对 #10 仅 §2.2 清单行 + 失败模式 C 提及（L87「两条路径实现不同、bash 无法覆盖」），无处置决策条目。登记表如实登记现状 + 原则性目标 + 引用 W22（= P4.1 等价性测试族，plan L29/L65 属实）作回归验证面。**裁决：如实登记，处理恰当。**
2. **#11 session 活跃态「无专门 wave」**：19 单元无活跃态 5 源派生收敛单元（P1.1 六实例 = label/thinkingLevel/modelId/usage/queue 深度/commands，不含 isStreaming；P1.5 是 runtime 侧 state 话题数据源切换，非 renderer 派生收敛）。登记表区分「写入口收敛（W13 覆盖）」与「派生上移 runtime（原则性目标，无 wave）」，表述自洽。**裁决：如实登记，处理恰当。**

主表全部 W 编号引用（W7/W8/W9/W10/W11/W12/W13/W14/W15/W16/W17/W18/W19/W20/W21/W22）与 plan §1.1 wave 总表逐一对位，无编造 wave。

## 6. 发现的问题

**[MINOR] #6 行队列命令名前缀错误**——`docs/architecture/data-source-registry.md:23`（主表 #6「唯一写入口」列）写「WS `session.steer` / `session.followUp`」，源码实际 WS 命令名为 `message.steer` / `message.follow_up`（`packages/runtime/src/transport/session-message-handler.ts:419/:431`、`packages/shared/src/protocol.ts:61/:343`）。父文档 D6 原文为泛指「经 WS steer/followUp」（无前缀），登记表具体化时写错。入口文件路径、唯一提交方语义、D6 分权威表述均正确；错误不击穿 w2-acceptance.md 任何明文验收条款（三条通过命令与验收内容 1-6 均不含此检查点），不影响写点治理与例外登记。建议后续 wave（或 W14 落地时）顺手修正，本 wave 不阻断。

## 7. 总结论

**PASS**。防篡改 3/3、通过命令 3/3、条款对照（12 数据行 + 空值语义三条 + 例外七项 + 六写点 + plugin 条目 + 表头声明）全部通过；反向写点扫描未发现未登记真实写点（SSOT 完备性成立）；#10/#11 裁决恰当；行号偏差如实记录。1 项 minor 偏差（#6 命令名前缀）记录在案不阻断。W3/W4 可解锁。
