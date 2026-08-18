# plugin-trust-hardening 执行审查（exec-review）

> 对象：`.xyz-harness/2026-08-17-plugin-trust-boundary-hardening/spec.md`（设计文档）+ `.cw/plugin-trust-hardening/`（冻结 spec 树）。
> 本文自包含：不依赖对话上下文。审查基线 commit `74ab61503`（分支 `cw/plugin-trust-hardening/api-contract-hardening`，含全部三个 slice）。

## 1. 结论

**四单元全部 verified**：security-trust-boundary（8 pass/0 fail/1 manual）、lifecycle-robustness（5/0/1）、api-contract-hardening（6/0/1）、根单元 plugin-trust-hardening（4/0/2）。设计 §4 的 16 个验收场景全部有承载（§3 映射表）。6 个实施期门全部有结论（§4）。设计偏差 8 条已逐条裁决并记录（§5）。3 个 UI 手动项按 spec 设计留待用户执行（§6）。已知问题 1 项（测试基建 flake，与本次改动无关，§7）。

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

全量回归终态：runtime 262 files / 3047 tests 零回归（工程起点基线 3002 → 3047）；core 35 pass；extensions:typecheck 零错误。

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
| token 握手 × renderer 重连 | SEC-B1 e2e 验证无 token 拒 + env/0600 文件双通路；renderer authed 状态机有单测（ws-listen-hardening / plugin-identity-auth） |
| CommandPopover 动态命令消费 | 结论：当前唯一消费方是 commandExecutor（分离 pluginId+commandId），无动态命令消费场景；`plugin:commandRegistered` 广播无前端消费者，广播消费留待真实需求出现 |
| statusline 回归（external 强制 sandbox × builtin trusted） | e2e A3（built-in statusline 发现并激活）通过；每次 pre-commit 的 Plugin E2E 均含 statusline 场景，多轮全绿 |
| 存量 external 插件影响 | 复核：`EXTERNAL_PLUGIN_ENABLED` 2026-08 才翻 true，无已知安装面（无分发渠道），实施中未发现存量自报 trusted 的 external 插件，影响集判定为空 |
| CJS createRequire 混用监控 | 拦截器保留 + 监控日志已加；观察期至 ~2026-11，无命中再做减法删除 |

## 5. 设计偏差记录（逐条裁决：全部接受）

| # | 偏差 | 理由与裁决 |
|---|---|---|
| 1 | `plugin-hot-reload.test.ts` mock 协议修正（deactivate 应回 `deactivated`，旧 mock 回 `activated`） | 真实协议（plugin-bootstrap.ts:169）核实无误；旧单键匹配掩盖失真，复合键落地后必须修正。接受 |
| 2 | `cancelPendingRebuilds()` 落点从 host.shutdown（链末）前移到 PluginService.shutdown 第一步 | 设计只写「shutdown 清 timer」未指定落点；LC-C2 首跑实测证明链末清理太晚（deactivateAll 期间冷却到期会复活）。接受 |
| 3 | `assignWorker` trusted 复用补 pluginIds 去重 | e2e 实测暴露 crash-rebuild 轮次 id 累积；process 宿主同款修复（M6a-06）的对称补齐。接受 |
| 4 | sessions 创建入口 3 处（create/restoreSession/forkSession），非设计写的 4 处（无独立 clone/precreate 方法） | 设计期事实偏差；三处全挂 + 全测。接受（以代码为准） |
| 5 | sessions 定向投递用 rpcServer.notify（Worker onNotification 契约），非设计原文「rpcServer.invoke 通道」 | Worker 侧 session-api 既有监听形态决定；invoke 为 request/response 形态不匹配。接受 |
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

**测试端口 TOCTOU 竞态 flake（与本次改动无关）**：`data-flow-integration.test.ts` 等 6 个测试文件使用「listen(0) 拿临时端口 → close → 再绑」的 `getFreePort` 模式，close 到重绑之间并行 worker 可拿到同端口 → `EADDRINUSE` unhandled error → 同 worker 内等回包的用例超时。根单元 verify 首跑命中一次（AC-I1 FAIL），诊断后重跑通过（本地全量多轮稳定）。生产语义「EADDRINUSE → process.exit(1)」是 security slice 刻意的 fail-fast（防端口劫持，ws-listen-hardening.test.ts 锁定），不应为测试便利修改。后续改进（独立事项）：测试侧引入「EADDRINUSE 重试换端口」的共享 fixture helper 替换 6 处复制粘贴的 getFreePort。

## 8. 工程过程备注

- contract S3-W3+W4 批次因用量配额中断一次，续作批次先逐项核实中断时的 14 文件实现（全部成立）再补缺口，并修复中断遗留的三处缺陷（shared re-export 缺失致运行时 TypeError、tool/hook-api 零校验、ui-api 日志判定基于 message 永不命中）。
- 各批次均遵守「禁 commit、越清单改动最小化 + 披露」纪律，由协调者审查 diff 后统一提交；全部 pre-commit 检查（含 runtime bundle 验证 + Plugin E2E + SEC 场景回归）通过。
