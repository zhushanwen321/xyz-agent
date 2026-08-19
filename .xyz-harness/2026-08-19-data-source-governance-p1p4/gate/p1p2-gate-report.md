# P1+P2 Gate 行为级验收报告（data-source-governance）

> 验收对象：docs/architecture/data-source-governance.md §4 场景 1 后半（P1 gate）+ 场景 2（P2 gate）
> 执行环境：真实 `pnpm dev` Electron app + 真实 pi 子进程（dev pi binary：`apps/electron/resources/pi/pi-darwin-arm64`），无 mock。
> 验收方：独立 verifier subagent；未修改任何生产代码/文档；无 git 写操作。
> 数据目录：dev 环境隔离于 `~/.xyz-agent-dev/`（`XYZ_AGENT_DATA_DIR` + 端口 offset 100 → runtime 3310），与打包版 TaiJi.app（3210，`~/.xyz-agent/`）互不干扰。机器上打包版与 feat-remote-use worktree 实例同时在跑，经端口/数据目录隔离确认不污染本验收。

## 结论

- **场景 1 后半（P1 gate：非活跃改名 + R1 代码断言）：PASS**
- **场景 2（P2 gate：断连自愈 + renderer 一致性）：PASS（三条硬标准全过；附 2 项高优先级发现问题，其中 tmp 写入数据丢失问题建议单独立项修复）**

---

## 一、场景 1 后半（P1 gate）证据

### 1.1 行为验证：非活跃 session 右键改名

- 目标：session `019ffd0c-f84f-77bc-af1e-d1975be13bfe`（Stock 组「测试指令与目录查看」，最后活动 2026-08-13，无 pi 进程持有——改名前 `ps` 确认全机无 dev pi 进程）。
- 操作（18:46:24）：侧栏 hover session 项 → Pencil 按钮（title=重命名）→ RenameSessionDialog 填入「验收P1-非活跃改名Stock」→ 确认。
- 改名前文件基线：`~/.xyz-agent-dev/pi/sessions/2026-08-13T21-35-13-487Z_019ffd0c-...jsonl`，24 行，md5 `d814d9f3...`，mtime 2026-08-13。

**改名 entry（JSONL 尾部，由 pi 写入非 xyz 直写）**：

```
{"type":"session_info","id":"4c9327eb","parentId":"77181943","timestamp":"2026-08-19T10:46:24.982Z","name":"验收P1-非活跃改名Stock"}
```

行数 24→25。**短命 pi 铁证（三方一致）**：

1. dev runtime 日志（`~/.xyz-agent-dev/logs/runtime-2026-08-19.log`）：
   ```
   10:46:24.442 [rpc] spawning pi: .../pi-darwin-arm64 --mode rpc --no-extensions ...
   10:46:24.946 [rpc] send: type=switch_session
   10:46:24.982 [rpc] send: type=set_session_name
   10:46:24.988 [rpc] process exited with code 143
   ```
   端到端 546ms（与 W11 设计「探针 ~600ms」吻合）。
2. pi stdout tee 日志（`~/.xyz-agent-dev/logs/pi-2026-08-19-ephemeral-1787136384442-dd506ccd-744.jsonl`，文件名含 `ephemeral-<Date.now()>` 即 withEphemeralPi 的 ephemeralId）RPC transcript：
   ```
   response id=rpc_1 command=switch_session success=true
   session_info_changed name="验收P1-非活跃改名Stock"   ← pi 自身广播
   response id=rpc_2 command=set_session_name success=true
   ```
3. 全目录 diff（改名前后 `~/.xyz-agent-dev/pi/sessions` 全量 mtime/行数/md5 快照对比）：**唯一变化 = 目标 JSONL +1 行**，所有 sidecar（.meta.json/.project.json 等）与其他 session 零变化——最小写入面。

**改名生效**：侧栏即时显示「验收P1-非活跃改名Stock」；**dev app 完整重启后（第二次 pnpm dev）侧栏仍显示该名**（entry 持久化于 JSONL，跨重启存活）。

**无 auto-rename 覆盖**：改名后在该 session 内继续对话（v1 轮 1+1 提问），pi stderr 经 runtime 转发：
```
10:49:21.347 [rename-session] t=... turnIndex=0 skip: count=2
```
rename-session 扩展 skip，手动名未被覆盖。（短命 pi spawn 参数为 `--no-extensions`，不存在扩展干扰路径。）

### 1.2 R1 代码断言

**R1 脚本**：

```
$ python3 .githooks/check_pi_direct_write.py
[OK] R1 pi session 直写检查通过：扫描 239 文件，allowlist 命中 0 处（无（W11 已清空））
exit code = 0
```

**git grep 逐条核对**（`git grep -nE "openSync\('(a|w)'|appendFile|writeFile|atomicWrite" packages/runtime/src/`，命中 62 处）分类：

| 类别 | 命中 | 结论 |
|---|---|---|
| 测试文件（`__tests__`/`*.test.ts`，约 30 处） | writeFileSync 写 mkdtempSync 临时 fixture | 非 pi JSONL 本体，允许（R1 规则内置不扫测试） |
| sidecar 家族四后缀 | session-file-utils.ts:148(.meta.json)/225(.project.json)/283(.preset.json)/443(.handoff.json) 的 atomicWrite | 允许清单内（xyz 自有 sidecar） |
| session-fork.ts:175 | `writeFile(newFilePath, ...)` fork 新文件创建型 | 允许清单内（D3b 登记） |
| session-lifecycle.ts:517/:676 | 写 `os.tmpdir()` 下 `xyz-session-*.jsonl`/`xyz-fork-*.jsonl` 中转拷贝（switchSession 后 finally unlink），注释明示「源文件零写」 | 非本体（tmpdir 目标，R1 调用点可见豁免） |
| session-service.ts:1762 | 写 attachments 目录图片附件（writeImage） | 非 pi JSONL |
| session-service.ts:1844 | segments.json（renderer 分段状态 sidecar）tmp+rename | 非本体 |
| 其余（agent-crud / pi-settings-store / pi-provider-store / auth-storage / quota-* / plugin-* / preset-service / project-store / app-config-store / worktree-config-helper / recent-workspaces-store / fs-utils(atomicWrite 实现) / json-store / logger / extension-service:517(pkgJson)） | 全部指向 xyz 自有配置/存储文件或通用工具实现 | 非指向 pi session JSONL |
| 注释行（logger.ts、scanner-base.ts、process-manager.ts:258、session-file-utils.ts:405/409/422/496、session-lifecycle.ts:361 等） | 历史说明文本（「已随 W11 删除」等） | 非代码 |

**结论：不存在指向 pi session JSONL 本体的写路径。**

---

## 二、场景 2（P2 gate）证据

### 2.1 断连机制与真实性论证

机制（两层组合，脚本 `gate/scenario2-disconnect.js`）：

1. **阻断层**：CDP `Network.emulateNetworkConditions offline=true`。前置验证（`probe-block-check.js`）：offline 下页面新建 `WebSocket('ws://localhost:3310/gate-probe')` 52ms 内 readyState=3（握手被网络栈拒绝）——offline 能阻断**新建** WS 握手；但对**已建立** WS 无效（15s 探针 `probe-offline.js` 期间无 onclose/reconnecting）。
2. **断开层**：CDP `Runtime.queryObjects(WebSocket.prototype)` 枚举页面 WS 实例 → 对 OPEN 的 `ws://localhost:3310/` 调用 `.close()` → **触发 ws-client 的真实 onclose**（非主动摘回调 disconnect）。

由此走完整真实断连-重连路径（v4 断连日志 `scenario2-v4-disconnect-console.log`）：

```
+31ms    offline=true
+460ms   closed renderer runtime WS instances: ["ws://localhost:3310/"]
+461ms   CONSOLE [ws] reconnecting in 1000 ms (attempt 1)   ← 真实 onclose → scheduleReconnect
+1466ms  attempt 1 失败（offline 阻断握手）→ backoff 2s
+3470ms  attempt 2 失败 → 4s
+7473ms  attempt 3 失败 → 8s
+15474ms attempt 4 失败 → 16s
+30351ms offline=false restored
+31360ms attempt 5/6 created → 无后续 error = 连接成功（恢复后 1009ms）
```

指数退避 1s→2s→4s→8s→16s 与 ws-client 常量一致；重连成功后 auth 握手 + resubscribeAll + 快照拉取（后续 ping 探针 `probe-ping.js` 收到 pong 证明连接 authed 存活）。

### 2.2 执行历程（v1→v5）

| 轮 | session | 结果 | 归因 |
|---|---|---|---|
| v1/v2/v3 | 019ffd0c-f84f / 18dc | 对话流回复缺失 +「进行中」卡死 | **被 mimo-v2-pro 模型 API error 污染**（pi `stopReason=error`，assistant content 空；runtime 写 session_end error sidecar；error turn 的 UI 流状态卡死并抑制后续渲染——store 内 17 条消息但 UI 只显示占位）。非断连自愈缺陷，判定作废重跑 |
| v3'（15s 意外断连） | 18dc | followUp 回复「8」未显示 | 仍有 v2 error 残留干扰，不足以定性 |
| **v4（正式 30s）** | 01a019bb（新建，Stock cwd，无污染） | 见 2.3 对照表 | 干净基线 |
| **v5（12s + 5s 窗口精准验证）** | 同上 | 见 2.3 | 重连后 ~3s 抓取（5s 窗口内） |

v4 前置条件齐备：已切过模型（runtime 日志两次 `model.switch`：mimo-v2-pro → mimo-v2.5-pro，最终 MiMo-V2.5-Pro）、有用量（首轮山诗后 44.1K）、队列压 followUp（turn 进行中 Alt+Enter = `message.follow_up` 入 pi 队列）。

### 2.3 通过标准对照（v4 + v5）

RPC 权威值来源：pi stdout tee 日志（`pi-2026-08-19-bfb54d64-*.jsonl`）中最新的 `get_state` / `get_session_stats` response（pi 进程自身返回，非 xyz 投影）。

| 对照项 | pi get_state / get_session_stats 权威值 | renderer UI（v5 重连后 ~3s，5s 窗口内） | 一致 |
|---|---|---|---|
| 模型 | `mimo-v2.5-pro`（name: MiMo-V2.5-Pro） | MiMo-V2.5-Pro | ✅ |
| 思考档位 | `thinkingLevel: "high"` | 「最高」 | ✅ |
| 用量百分比 | contextUsage 44288/1048576 = **4.22%**（v4 时点 44139 = 4.21%） | 「44.3K」（4%） | ✅ |
| 队列深度 | `pendingMessageCount: 0`（followUp 已消费） | 无队列指示 | ✅ |
| isStreaming | false（3 轮 turn 全部 turn_end + agent_settled） | 「已工作」残留（见发现问题 #1） | ⚠️ |
| 错误 toast | — | v4/v5 全程 0 toast | ✅ |
| 对话流完整性 | tee：turns=3（山诗 + 逐行解释 + followUp 回答） | 全部消息与回复完整渲染，**断连窗口内完成的 followUp 回复（「解释一共覆盖了 8 行诗。」「一共数了 15 个数字。」）在重连后完整出现** | ✅ |

截图：`09-v4-after-reconnect.png`（30s 断连恢复后完整对话流）、`10-v5-final-state.png`（v5 稳态）。

**判定：三条硬标准（状态一致 / 无 toast / 消息完整）全部满足 → PASS。**

---

## 三、发现的问题（验收过程中暴露，建议后续处理）

1. **[高] 断连窗口涉及 turn 的「已工作」指示重连后不复位**：v4/v5 中 turn-meta-3/4/5（断连期间活跃的 turn）持续显示「已工作」，而 pi `isStreaming=false`；对照同 session 无断连的 turn-1/2 正常收尾。疑似断连中丢失的 message_end/turn_end 广播未在重连后补齐复位（关联全局规则「错误必须重置 isGenerating + streamingMessage」）。不影响消息内容，影响状态感知。
2. **[高] restore 管线 tmp 附着导致新对话不落原 session JSONL（数据丢失级）**：restore 的 session，pi 经 switchSession 附着于 `os.tmpdir()` 拷贝（`xyz-session-<id>-<ts>.jsonl`），**后续全部对话只写 tmp 文件，原 JSONL 零更新**（实测：18dc 原 JSONL mtime 停留在改名时刻、行数不变；当天对话全在 tmp）。**dev app 重启后重开该 session，当天对话全部丢失**（复现：第二次 dev 后重开 18dc 仅剩 08-13 旧对话 6 条）。pi 进程存活期间数据仅在 runtime 内存 + tmp 文件。此问题同时威胁场景 3（重开一致性）。
3. **[中] 模型 error turn 的 UI 流状态卡死**：mimo-v2-pro 返回 `stopReason=error` 的 turn，UI「进行中…」永久卡住且抑制后续 assistant 回复渲染（store 有数据、UI 显示占位）。
4. **[中] 重连后 renderer 初始化批次 pre-auth 被 drop**：重连握手的 auth 完成前，renderer 发出的 `model.list / config.sessions / preset.list / project.load / presence.list / plugin.mountPoints.sync / config.getGlobalSkills` 被 runtime 以 `dropping pre-auth message` 丢弃且无重发 → 侧栏 session 列表空、session 名回退显示文件名（如「019ffd0c.jsonl」）。页面 reload 后恢复。与 S1-W1「重订阅不会被当 auth 前消息丢弃」的设计意图相悖。
5. **[低] cwd 死路径的非活跃 session 改名失败反馈缺失**：对 cwd 已删除（feat-optimize-ui worktree 已不存在）的非活跃 session 改名，`withEphemeralPi` 的 switch_session 被 pi 拒绝（session-lifecycle 注释明示死路径降级职责在 restore 管线、rename 调用方未处理），改名静默不生效；代码路径存在 toastError 但现场 2s 后未捕获到 toast（可能已消失，未定论）。
6. **[观察] runtime 侧半开连接计数**：offline 阻断期重连尝试在 runtime 侧产生 `client connected (total: 2)` 计数堆积（被 close 的连接因 offline 其 close 帧未送达 runtime）。恢复后不影响功能（pong 正常）。
7. **[观察] 活跃态 Enter 直发行为与注释不符**：Composer.vue 注释称活跃态「⏎ 追加 steer」，实测 v1 在 turn 进行中按 Enter 走了 `message.send` 直发 prompt 并触发 pi error（busy turn 上直发 prompt 报错）。未深挖（超出本 gate 范围）。
8. **[环境] mimo-v2-pro 模型当时返回 error/空回复**（小米 token-plan 服务质量），行为级验收需选 MiMo-V2.5-Pro。

---

## 四、附件清单（均在 gate/ 目录）

| 文件 | 说明 |
|---|---|
| p1p2-gate-report.md | 本报告 |
| session-files-before-rename.txt / dev-session-files-before-rename.txt | 改名前 session 文件快照（打包版/dev 目录） |
| 00-initial-state.png … 10-v5-final-state.png | 各阶段截图 |
| probe-offline.js / probe-block-check.js / probe-ws-state.js / probe-ping.js | 机制探针脚本 |
| scenario2-disconnect.js | 断连主脚本 |
| scenario2-disconnect-console.log / scenario2-v3-disconnect-console.log / scenario2-v4-disconnect-console.log / scenario2-v5-disconnect-console.log | 断连时间线日志 |

## 五、环境收尾

- 第一次 `pnpm dev` 已停（TaskStop + 端口 1420/9222/3310 确认清空）。
- 第二次 `pnpm dev`（v4/v5 用）：验收完成后同样停止（见下方补充记录）。
- 打包版 TaiJi.app（3210）与 feat-remote-use 实例（13800）全程未触碰。
- 测试产生的 session 数据留在 `~/.xyz-agent-dev/`（正常使用痕迹，未清理）。
