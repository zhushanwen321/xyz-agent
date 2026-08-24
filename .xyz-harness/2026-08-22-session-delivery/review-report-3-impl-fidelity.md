# 第三轮对抗式审查报告：实现 vs 设计忠实度（implementation fidelity）

> 审查对象：feat-firstmate-new-session 分支已集成的 delivery kernel 全部实现（merge commit 1eaa23c99 起）
> 审查依据：design.md D1-D9 决策 / §3.4 接口草案 / D4 策略默认值表 / D7 副作用处置表 / G4 行为等价
> 核实方式：以设计条款为基准逐条 read 实现代码（非测试通过推断）
> 结论：**6 must-fix / 4 should-fix / 3 suggestion**——架构骨架忠实（D1-D3/D5-D7/D9、单例约束、范围纪律、S1/S2 e2e 驱动纪律全过），但内核三个「设计了没生效」的运行时保障（两处被假测试掩盖）+ notifier 三处 G4 回归（合批 details 结构破坏前端渲染器）。

## Findings 与修复处置（全部已修复，commits dcb537bdd / 8e969b16c / b550b0e11）

| # | 级别 | 问题 | 修复 |
|---|------|------|------|
| 1 | must | watch-dog 定义后从未调用（settled 丢失无恢复路径）；delivery-settled.test 假通过（退避强发碰巧满足断言） | scheduleFlush 有订阅装配 busy 时启动 watchdog；假测试改真测试（真实 subscribeSettled 不触发 + backoff max 500 + 30s 快进，断言只能由 watchdog 满足） |
| 2 | must | port.send 抛错零重试（失败即终态 rejected 丢消息；compaction TOCTOU 自愈路径缺失） | 「成功才离队」+ inflightBatch 按 backoff 有限重试，达上限 settle rejected；补前两败后成/达上限两用例 |
| 3 | must | sendChecked idle 分支旁路 in-flight 防重（F3 双注入复活） | 删裸 port.send 旁路，统一投递循环（checked waiter + 单独成批 + pump 优先直投）；补「挂起期间 settled 边沿 port.send 恰好 1 次」用例 |
| 4 | must | notifier 未装配 subscribeSettled（D8 主路径在第一个消费者落空） | NotifierHost 增 onAgentSettled 注入 + disposed 包装（照 scheduler 先例）；测试锁「10s 零投递 + 边沿送达」证明切边沿驱动 |
| 5 | must | revive 后通知永久静默（内核 disposed 不可逆，/resume /fork /new 真实时序） | notifier 工厂化：revive 幂等 dispose 旧 handle 重建；测试锁 dispose→静默→revive→恢复送达 |
| 6 | must | 合批 details.items 装 payload 而非 record，破坏 bg-notify-render（extractBgNotifyRecord 全失败退化默认渲染） | 内核 buildBatchPayload 规则：items = custom 且有 details 装 details（record），否则装 payload；golden 补 items[0] record 形态锁 + 端到端渲染往返锁 |
| 7 | should | 退避强发未限定「无订阅装配」（与 settled 边沿竞速） | 有订阅装配 busy 不设退避 timer 只挂 watchdog；无订阅保持退避强发；补 [锁 #7] 用例 |
| 8 | should | sendChecked busy 分支可达性未确认即 resolve（僵尸 busy 标志假 queued） | 与 #3 合并：busy 直接经投递路径入 pi 队列受理（探针 P1 受理即回），resolve=已受理；pi 死 reject；消费方测试同步翻转 |
| 9 | sugg | DeliveryMessage 多 merge 字段（设计是 send opts 单通道） | 删字段（grep 零消费） |
| 10 | should | hasPendingMessages 端口字段内核零消费（迁移前双条件 gate 弱化） | isBusy() = !isIdle() \|\| hasPendingMessages() 用于 gate/settled 复核/watchdog 三处；补双用例 |
| 11 | should | scheduler 终态按 content 反查 task（同 prompt 错配、删除后静默丢） | dispatchViaDelivery 挂 dedupeKey:task.id，onSettled 按 id 精确反查；补同 prompt 双任务/先删后到两用例 |
| 12 | sugg | dedupeKey 缺失静默跳过（「必填」无 enforcement） | handle 级一次性 warn，消息照投不参与去重 |
| 13 | sugg | golden 合批断言未锁 items 元素结构（#6 失明根因） | 并入 #6 的 record 形态锁 + 渲染往返锁 |

## 顺带发现（修复中主动报告）

notifier `isIdle: this.isIdleFn` 构造期快照 latent bug（git 追溯 e726711d0 起 host.isIdle 恒 undefined，「isIdle gate 竞态修复」从未生效）——改为 late-bind，无行为回归（无 service 测试注入 host isIdle）。

## 排除项确认（不算偏离）

U7 评估项未迁移 / D5 二期未实现 / registry hasPendingMessages 一期固定 false / S6 未收 root spec——均设计声明范围。send() 不支持 kind 时 warn+return（D9「同步 reject」与「send 永不 throw」设计内张力，取 never-throw 侧非静默，可接受）；park 模式错误不重试（与 scheduler 现状单次尝试等价，G4 角度正确）。

## 修复后验证

- `packages/session-delivery`：57/57 全绿（#1 假测试已变真）
- `packages/runtime` 全量：3742 passed / 4 skipped，唯一 fail = pi-settings-store 跨进程锁（与本工作零接触、单独复跑 3×全绿的并行负载时序 flaky，历史已有加固 commit）
- subagent-workflow 2422 / scheduler 235 全绿；extensions 三连 exit 0（162 warnings 为存量基线）
- 四路真机 e2e 复跑（S1-S4）：全 PASS（S1 含修复后行为翻转的 pi 侧 pendingMessageCount 结构化断言）
