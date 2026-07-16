# Retrospect — subagent-runtime-push-badge

## 目标回顾
Runtime 在 subagent 状态变化时主动推送 session.subagents 广播，前端被动消费更新 sidebar Agents badge 计数，替代「只有切到 subagents tab 才拉取」的轮询模式。

## 做了什么
- **W1（runtime）**：EventInterpreter 维护 per-session 内存态 SubagentRecord[]。tool-call-start 缓存 startParam，tool-call-end 合并 details 建 running 记录并广播，bg-notify 更新终态并广播。复用现有 broker.broadcast 通道（opts.send）。
- **W2（前端）**：subagent store 新增 subscribeSubagentPush 订阅 session.subagents 推送。useSubagentListSync 删除 activityKey 轮询 watch，改为推送订阅 + RPC 首拉兜底。

## 做得好的
- 架构决策在 plan 前充分澄清（数据来源、推送时机、input 缓存策略三个决策点），避免了实现中途返工
- TDD 严格执行（U1-U4 红绿、E1-E2 红绿）
- 复用现有基础设施：protocol.ts 的 session.subagents 已定义、broker.broadcast 通道现成、events.dispatchSession 路由现成——三层都零改动

## 做得不好的
- plan 的 expected.text 措辞和实际测试结果不完全一致，导致 cw test 全 fail，需 replan 修正 expected 重走 dev→review→test。教训：写 expected 时应直接从测试断言复制，不复述
- review 发现的三元冗余（`status = cond ? 'running' : 'running'`）是写实现时复制粘贴遗漏，TDD 没抓到（测试只验结果值不验代码结构）

## 技术债 / 后续
- **bg-notify 到达但内存态无对应记录**（session 恢复后只收到 bg-notify）：当前静默跳过，靠 RPC 首拉兜底。长期可考虑 bg-notify 时也从 details 建记录
- **内存态生命周期**：per-session（interpreter 实例级），session 销毁时随实例释放。未显式测试 session 销毁场景
- **fileCount badge** 的实时更新问题（invalidate 只标记不重拉顶层）不在本 topic 范围，待后续
- **workflowCount badge** 硬编码 0，待 workflow 数据链路实现
