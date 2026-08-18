# plugin-trust-hardening 执行审查（exec-review）

> 对象：`.xyz-harness/2026-08-17-plugin-trust-boundary-hardening/spec.md`（设计文档）+ `.cw/plugin-trust-hardening/`（冻结 spec 树）。
> 本文自包含：不依赖对话上下文。审查基线 commit `74ab61503`（分支 `cw/plugin-trust-hardening/api-contract-hardening`，含全部三个 slice）。

## 1. 结论

**四单元全部 verified**：security-trust-boundary（8 pass/0 fail/1 manual）、lifecycle-robustness（5/0/1）、api-contract-hardening（6/0/1）、根单元 plugin-trust-hardening（4/0/2，终态 commit 365f77572 复验）。设计 §4 的 16 个验收场景全部有承载（§3 映射表）。6 个实施期门全部有结论（§4）。设计偏差 8 条已逐条裁决并记录（§5；其中 3 条设计侧失准已回写勘误，commit 953ada4de）。3 个 UI 手动项按 spec 设计留待用户执行（§6）。已知问题 1 项已根治（测试端口竞态，§7）。**2026-08-18 设计-代码对齐复审**（三域独立审查共 98 项、逐项 file:line 证据）发现 5 项代码缺陷与 8 处文档失准，已全部修复与勘误（§8）。

### 交付 commit 链（分支 cw/plugin-trust-hardening/api-contract-hardening）

| commit | 内容 |
|---|---|
| ab3a253ac / 98979919e | （前置）退出假 crash toast 两处止血修复 |
| b3dff1d07 | 设计文档 + cw 树 spec 冻结 |
| ece9f95c3 | security slice S1-W1..W5（WS 认证握手/鉴权反查/沙箱边界/builtin 注入/路径校验） |
| e6572d0b0 | lifecycle S2-W1+W2（入口防御/并发模型/复合键） |
| 4ebfd3a9a | lifecycle S2-W3+W4（rebuild 约束/崩溃对称化/关停顺序反转）+ verify-lifecycle-e2e.sh |
| 9e3fae6a1 | contract S3-W1+W2（命令链复合键/sessions 事件/events 降级） |
| 5cc2d61ae | contract S3-W3+W4（窄校验层/限流/毒化隔离） |
| 74ab61503 | verify-plugin-contract.sh + scripts/cw-acceptance/ 根验收包装 |
| 953ada4de | 设计文档勘误回写（§5 偏差 2/4/5 的设计侧修正） |
| 365f77572 | 测试端口竞态修复：传输层 EADDRINUSE 归位 reject + wss error 转发修复 + 共享 startOnFreePort helper（§7 已知问题的根治） |
| 2b59f7887 | 设计-代码对齐复审代码修复（§8）：fork exit-0 分流 / invokeResult 归属校验 / CJS 监控日志 / renderer auth 单测激活 / e2e setModel 探针 |

全量回归终态：runtime 263 files / 3052 tests 零回归（工程起点基线 3002 → 3052）；core 35 pass；extensions:typecheck 零错误。根单元在 365f77572 重新 verify 通过（AC-I1 在曾触发 flake 的干净 clone 条件下直接绿）。

## 2. 金丝雀验证汇总

每个实施批次都做了「源码还原到修复前 → 新测试必须以缺陷一致的模式失败 → 恢复后复绿」的反向验证：

- security W 批：恶意 fixture 在旧代码下逃逸成功（SEC-A1~A5 的 e2e 在修复前 FAIL）
- lifecycle L-A：8/8 失败（含 `terminate 未调用`、`notification 异常冒泡` 命中断言本体）
- lifecycle L-B：单测 6/6 失败；e2e LC-C2 命中「关停中复活」、LC-C4 命中「关停丢数据」
- contract C-A：19/20 失败 + HEAD 缺陷探针（裸键覆盖成立、单数方法名漂移证实动态命令从未可执行）
- contract C-B（续作）：失败模式含 `NotifyRateLimiter is not a constructor`（re-export 缺陷）、`parseStatusBarUpdate is not a function`（旧整包丢弃行为）
- contract C-C：脚本反向金丝雀（断言反转 → CT-D1/CT-D2 FAIL + exit 1）

## 3. AC-I4：设计 16 场景 ↔ 验收承载映射

| 场景 | 承载验收 | verify 结果 |
|---|---|---|
| A1 沙箱 import 拦截 | SEC-A1（e2e） | pass |
| A2 裸名/CJS 逃逸 | SEC-A2（e2e） | pass |
| A3 身份伪冒（含分区） | SEC-A3（e2e） | pass |
| A4 合规插件全通 | SEC-A4（e2e） | pass |
| A5 路径注入 | SEC-A5（e2e） | pass |
| B1 WS 认证 | SEC-B1（e2e）+ SEC-U2（unit，回环/maxPayload） | pass |
| B2 监听面 + 贴图回归 | SEC-U2（unit，绑定面）+ SEC-M1（manual，贴图/lsof） | unit pass；manual 待用户 |
| C1 并发开关 | LC-C1（unit，API 层 20 轮真实 Host+Activator）+ LC-M1（manual，UI 连点） | unit pass；manual 待用户 |
| C2 崩溃后退出 | LC-C2（e2e） | pass |
| C3 单插件回调 bug | LC-C3（unit，宿主层 + rpcClient 层双覆盖） | pass |
| C4 关停零丢失 | LC-C4（e2e） | pass |
| D1 SDK 死链路 | CT-D1（e2e） | pass |
| D2 命令执行 | CT-D2（e2e） | pass |
| D3 风暴限流 | CT-D3（unit）+ CT-M1（manual，真实 UI 风暴） | unit pass；manual 待用户 |
| D4 毒化隔离 | CT-D4（runtime unit）+ CT-D5（core unit） | pass |
| E1 全量回归 | AC-I1 / AC-I2 / AC-I3（根 e2e） | pass |

结论：16/16 场景有承载，无遗漏；无「验收存在但场景无目标」的孤儿。B2/C1/D3 三场景的 UI 面按 spec 设计为 manual，其逻辑层均有自动化覆盖。

## 4. AC-I5：6 个实施期门结论

| 门 | 结论 |
|---|---|
| maxPayload 实测校准 | `MAX_WS_PAYLOAD_BYTES` 进 shared 常量（SEC-U2 锁定）；贴图通路实测归 SEC-M1 手动项 |
| token 握手 × renderer 重连 | SEC-B1 e2e 验证无 token 拒 + env/0600 文件双通路；renderer authed 状态机单测当时为 it.todo defer（原记录把 ws-listen-hardening / plugin-identity-auth 引作 renderer 侧单测属归因错误——两者实为服务端 ConnectionManager 与 plugin RPC 鉴权测试，见 §8 修正），2026-08-18 对齐复审已激活为真实断言 |
| CommandPopover 动态命令消费 | 结论：当前唯一消费方是 commandExecutor（分离 pluginId+commandId），无动态命令消费场景；`plugin:commandRegistered` 广播无前端消费者，广播消费留待真实需求出现 |
| statusline 回归（external 强制 sandbox × builtin trusted） | e2e A3（built-in statusline 发现并激活）通过；每次 pre-commit 的 Plugin E2E 均含 statusline 场景，多轮全绿 |
| 存量 external 插件影响 | 复核：`EXTERNAL_PLUGIN_ENABLED` 2026-08 才翻 true，无已知安装面（无分发渠道），实施中未发现存量自报 trusted 的 external 插件，影响集判定为空 |
| CJS createRequire 混用监控 | 拦截器保留；监控日志当时未实现（原记录「已加」失实，见 §8 修正），2026-08-18 对齐复审已补一次性监控日志；观察期至 ~2026-11，无命中再做减法删除 |

## 5. 设计偏差记录（逐条裁决：全部接受）

| # | 偏差 | 理由与裁决 |
|---|---|---|
| 1 | `plugin-hot-reload.test.ts` mock 协议修正（deactivate 应回 `deactivated`，旧 mock 回 `activated`） | 真实协议（plugin-bootstrap.ts:169）核实无误；旧单键匹配掩盖失真，复合键落地后必须修正。接受 |
| 2 | `cancelPendingRebuilds()` 落点从 host.shutdown（链末）前移到 PluginService.shutdown 第一步 | 设计只写「shutdown 清 timer」未指定落点；LC-C2 首跑实测证明链末清理太晚（deactivateAll 期间冷却到期会复活）。接受；设计原文已勘误回写（落点明确为关停链第一步） |
| 3 | `assignWorker` trusted 复用补 pluginIds 去重 | e2e 实测暴露 crash-rebuild 轮次 id 累积；process 宿主同款修复（M6a-06）的对称补齐。接受 |
| 4 | sessions 创建入口 3 处（create/restoreSession/forkSession），非设计写的 4 处（无独立 clone/precreate 方法） | 设计期事实偏差；三处全挂 + 全测。接受（以代码为准；设计原文已勘误回写，见 spec.md 勘误记录） |
| 5 | sessions 定向投递用 rpcServer.notify（Worker onNotification 契约），非设计原文「rpcServer.invoke 通道」 | Worker 侧 session-api 既有监听形态决定；invoke 为 request/response 形态不匹配。接受；设计原文已勘误回写 |
| 6 | commands invoke 用通知形态 + invoke.result 回传，非 request 形态 | plugin-bootstrap 的 handleIncomingRequest 属 lifecycle 已验证产物（禁改段）；通知形态复用 Worker 既有监听且 handler 抛错毫秒级回传（优于 10s 超时）。接受 |
| 7 | CT-D2「返回值回传」以三路口径断言（reply 非 error + 错误毫秒级回传 + handler 调用计数/args 日志） | 既有 WS 契约 `plugin.executeCommand` reply 固定 `pong` 不含返回值——契约形态，非实现缺陷。接受（口径如实记录） |
| 8 | notify/ui 限流常量 20/s、8KB、4KB、100ms、toast≤5 全部实测校准后落地（见 shared/constants.ts 注释：日志均值 0.005 条/s + 探针突发峰值 2 条/s） | 实施期门要求项，非偏差，记录备查 |

附带披露：`pnpm-lock.yaml` 两次出现「非本任务产生的 M 状态被幂等 `pnpm install --prefer-offline` 规范化回 HEAD」（lifecycle L-B、contract C-C 批次），原修改内容不可知；两次均未主动 restore，属包管理器正常行为。工作区各批次收尾均确认与 HEAD 一致。

## 6. Manual 项处置（留待用户执行）

以下 3 项按冻结 spec 为 manual 类型，其逻辑层均有自动化覆盖（见 §3），UI 层验收步骤如下，建议合并前执行：

1. **SEC-M1**（贴图回归 + lsof）：`pnpm dev` → renderer 粘贴 5MB 截图发送正常；`lsof -i :<runtime端口>` 仅 127.0.0.1 绑定
2. **LC-M1**（UI 连点 + 退出观察）：`pnpm dev` → 对同一插件毫秒级连点开关 20 次，状态一致无卡死；退出应用无崩溃 toast；重启后插件激活状态与退出前一致
3. **CT-M1**（风暴实测 + toast 上限）：恶意插件形态 200 notify/s + 1MB statusbar text → 前端流畅、toast 在列 ≤5、超大条目日志可见拒绝、error 总线事件 console 可见

AC-I4 / AC-I5 两条根 manual 验收由本文档 §3 / §4 完成核对，即为其结论记录。

## 7. 已知问题

**测试端口 TOCTOU 竞态 flake（与本次改动无关，已根治）**：`data-flow-integration.test.ts` 等 6 个测试文件使用「listen(0) 拿临时端口 → close → 再绑」的 `getFreePort` 模式，close 到重绑之间并行 worker 可拿到同端口 → `EADDRINUSE`。根单元 verify 首跑命中一次（AC-I1 FAIL），诊断后重跑通过。**修复（commit 365f77572，2026-08-18）**：探针实测发现更深层根因——ws 库把 httpServer 的 error 转发到 wss 对象再 emit，wss 无 error listener 时 `emit('error')` 直接抛 uncaughtException 并中断 httpServer listeners 遍历（这解释了首跑事故中「unhandled EADDRINUSE 而非 exit/reject」的现象）。三层修复：① `connection-manager.ts` EADDRINUSE 归位为 reject + 可操作文案（对齐 callback-server.ts 先例），补 wss error listener；② 进程退出决策上移到 `index.ts` 组合根（生产 fail-fast 语义不变）；③ 共享 `test/helpers/free-port.ts` 的 `startOnFreePort`（撞端口换号重试，上限 5 次）迁移全部 6 文件。新增确定性回归用例（占端口 → 第二个 server 必须 reject）+ helper 重试单测；全量 3052 绿 ×3 轮 + 8-worker 并行压力轮绿；根单元在 365f77572 干净 clone 复验 AC-I1 直接通过。

## 8. 设计-代码对齐复审（2026-08-18，实施完成后第二轮）

三域独立对抗审查（security-trust-boundary 38 项 / lifecycle-robustness 27 项 / api-contract-hardening 33 项，共 98 项，逐条以 file:line 代码证据核对、不复用本文前述结论）。统计：对齐 75（含 12 条合理超出设计）/ 代码缺陷 5 / 文档失准 8 / 事实澄清 2 / 实施记录失实 2（即本节修正的 §4 两处）。全部处置完毕：

### 代码缺陷修复（5 项 + 1 项合并跑暴露的衍生修复）

| # | 缺陷（审查编号） | 修复 | 验证 |
|---|---|---|---|
| R1 | fork 宿主 exit-0 误判 crash（L-5）：子进程 `process.exit(0)` 时父进程事件序为 disconnect → exit，旧实现 disconnect 无条件走 handleProcessCrash → 假崩溃 toast + CRASHED 态 + crashCounts 累积；Worker 版已有 clean-exit 分流，fork 版缺失且方向相反 | `plugin-host-process.ts` 补 `handleProcessCleanExit`（镜像 Worker 版）+ exit handler 按 code 分流 + disconnect 延迟裁决。修复方案中 setImmediate 延迟一拍被 50 次 fork 探针证伪（49 次 exit 事件晚于 setImmediate 一整个事件循环圈），改为 `DISCONNECT_GRACE_MS=250` grace 窗口（SIGCHLD 传播 ms 级，25 倍余量） | 新增 `plugin-host-process-exit.test.ts` 3 用例（真实 fork：exit(0) 不误报 / 存活断 IPC 仍报 crash / terminate 路径回归）；canary：恢复缺陷后用例以 crash 残留模式失败 |
| R1b | R1 的 grace 窗口与 rebuild 竞态（定向跑未触发、合并全量跑暴露，既有用例 TC13）：旧 child 的 disconnect 定时器在 rebuild 换新 handle 后到期，误把新 handle 标 crashed——`removeAllListeners` 摘得掉旧 child 的监听器，摘不掉已在飞的定时器（processId 为 `sandbox-<pluginId>` 确定值，重建不换 id） | grace 回调首行补 child 实例归属防御：`processInstances.get(processId) !== child` 直接放行（旧 child 的迟到断开不归新 handle 管） | TC13 恢复绿；两测试文件 ×3 轮迭代稳定；全量 3060 绿 |
| R2 | `plugin.commands.invoke.result` 回传无归属校验（C-29）：任意 Worker 可伪造他人 handlerId 的 result/error，resolve/reject 他人命令 pending——违反设计 D2「复合键 + 归属校验」在回传段的对称（当前威胁面为空：commands 族 fail-closed 不在权限映射、trusted 互不设防是声明语义；但设计明确要求，且未来开放 commands 能力即成漏洞） | `CommandRegistration` 增必填 `workerId`（register 时从 ctx 通道身份捕获，不可伪造）；`deliverInvokeResult` 按来源 workerId 校验归属，不匹配或无注册（已清理）均 fail-closed 拒绝投递 + warn（含双方 workerId）。连带适配层 `plugin-rpc-setup.ts` 透传第三参（不透传则归属恒 undefined、全部回传被拒） | contract-hardening.test.ts 新增 4 用例（35 绿）；canary：移除校验后用例以「伪造回传 resolve 了 pending」的缺陷一致模式失败 |
| R3 | CJS createRequire 混用监控日志未实现（S-36；§4 原记录「已加」失实）：设计 §5 门要求「保留拦截器 + 监控日志，3 个月无命中再减法」，代码零日志 | `initSandbox` 的 `_resolveFilename` patch 首次触发时一次性监控日志（含 pluginDir 与观察期至 ~2026-11 标记，放行/拒绝均计为「CJS 通路存在」信号） | `plugin-sandbox-escape.test.ts` 新增 fork 隔离用例（两个不同 helper 排除 CJS 模块缓存假阴性；断言触发 ≥2 次而日志恰 1 次） |
| R4 | renderer authed 状态机单测 it.todo（S-33）：defer 理由「auth 能力迁入 core 时激活」已过时——auth 握手已在 core `ws-client.ts` 落地（connect(url, token) 双参 / 首条 auth / auth.result ok 才 connected） | 「不变量 ② auth 握手」3 条 todo 转真实断言。其中「auth.ok 后触发订阅 + flush」前提属 use-connection 编排层（core ws-client 无该职责），改写为语义等价断言：auth.ok → connected、握手期业务消息丢弃（对照：握手完成后同形状消息正常进入）、auth.reject → close 走重连链不进 connected、open 前不发任何消息且 open 后首条即 auth（payload 包裹形态） | 12 passed / 6 todo（② describe 零 todo 残留）；core 全量 942 pass 零回归 |
| R5 | e2e A4 缺 spec 点名的 `agent.setModel` 未授权样本（S-28；此前以 storage.delete 等价替代） | verify-plugin-e2e.sh evil-c fixture 补 `plugin.agent.setModel` 未授权探针（PERMISSION_DENIED 断言，归 SEC-A3 判定组） | e2e 全场景 SEC-A1~A5 PASS |

### 文档失准修正（spec.md 勘误 4-6 条 + 8 处就地修正 + 3 处代码注释）

- **spec.md 勘误记录新增**：勘误 4（D3 缺参回退 cwd 探测而非跳过——完全跳过会废掉无主进程形态的 e2e 基线）、勘误 5（D6「activatePlugin 补 DEACTIVATING 守卫」由 pending 复合键 + 单通道 IPC FIFO 结构性达成，显式守卫不需要，lifecycle-races.test.ts 固化该语义）、勘误 6（传输 listen 失败路径原文无覆盖：传输层 reject + 组合根 exit(1) fail-fast + free-port helper）。
- **spec.md 就地修正**：auth 消息形态 `{type:'auth', payload:{token}}`（原文字面失准）；maxPayload 16MB 定值说明（原「取小」公式字面结果 8MB 与实际取值矛盾，16MB 为 P99.9 × 2~4 倍绝对上限，单图 >12MB 传输层先拒属预期收紧）；A3 验收前半句（「已授权伪冒被鉴权层拒」与 D1 身份覆写语义自相矛盾，修正为未授权拒/已授权放行+分区覆写）；§4 D3 通过标准 toast 口径（20/s 是 runtime 丢弃率，前端展示上限是在列 ≤5）；D7 命令返回值终点（runtime pending 层；WS reply 保持 pong 契约）；D7 notify/ui 双入口共享同一令牌桶合并计费。
- **代码注释修正**：plugin-security.ts 历史翻转记录根因（「sandboxDir 之前恒空」→「注入入口文件路径致 `startsWith(dir + sep)` 判界恒 false」）；plugin-activator.ts handleWorkerReply 注释依据（引用不存在的「DEACTIVATING 守卫」→ 复合键 + IPC FIFO 实际机制）；shared/constants.ts maxPayload 校准注释数学。

### 本节修正的本文档失实记录（2 处）

§4「token 握手 × renderer 重连」行原把 ws-listen-hardening / plugin-identity-auth 引作 renderer authed 状态机单测——两者实为服务端 ConnectionManager 与 plugin RPC 鉴权测试，均非 renderer 侧（当时 renderer 侧为 it.todo）；§4「CJS createRequire 混用监控」行原写「监控日志已加」——当时未实现。两处均已就地修正并回指本节。

### 复审终态验证

runtime 全量 **3060/3060 绿**（3052 → 3060：+8 = exit-0 ×3 + invokeResult 归属 ×4 + CJS 监控 ×1）；core 全量 **942 passed / 6 todo**；`tsc --noEmit`（runtime + shared）零错误；verify-plugin-e2e.sh 全场景 PASS。各项 canary 均按「恢复缺陷 → 新测试以缺陷一致模式失败 → 复绿」协议执行（见各 worker 报告，关键失败输出已存档于 §8 各行）。

## 9. 工程过程备注

- contract S3-W3+W4 批次因用量配额中断一次，续作批次先逐项核实中断时的 14 文件实现（全部成立）再补缺口，并修复中断遗留的三处缺陷（shared re-export 缺失致运行时 TypeError、tool/hook-api 零校验、ui-api 日志判定基于 message 永不命中）。
- 各批次均遵守「禁 commit、越清单改动最小化 + 披露」纪律，由协调者审查 diff 后统一提交；全部 pre-commit 检查（含 runtime bundle 验证 + Plugin E2E + SEC 场景回归）通过。
