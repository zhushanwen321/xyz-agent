// ws-client 不变量测试骨架（D2：AC7 双交付之可执行骨架）。
//
// P0 阶段 ws-client 尚未迁入 core（P1 transport 迁移才落地），本文件用 it.todo 声明 5 类行为
// 的断言点（vitest todo 计为 skipped，不计 failed，exit 0）。P1 ws-client 迁入后，it.todo
// 替换为真实断言——断言点对应 ws-client-invariants.md 规格的逐条特征。
//
// 不变量定义修正（renderer-rebuild-architecture.md §5.1 / B.2-4）：
//   旧「本地模式逐字节不变」不可执行（测试无法锁定字节级）→
//   新「特征测试覆盖的关键行为不变」（5 类行为特征断言）。
import { describe, it } from 'vitest'

describe('ws-client 不变量 ① 连接状态机', () => {
  it.todo('合法迁移 connecting → open 可达（onopen 触发）')
  it.todo('合法迁移 open → closing → closed 可达（主动 close）')
  it.todo('非法迁移 open → connecting 被拒绝（不重置状态）')
})

describe('ws-client 不变量 ② auth 握手', () => {
  it.todo('auth.ok 后触发 session 通道订阅 + flush pending 队列')
  it.todo('auth.reject 后触发降级（不进入消息处理，标记连接不可用）')
  it.todo('auth 消息在 open 前不发（连接就绪后才握手）')
})

describe('ws-client 不变量 ③ close code 分流', () => {
  it.todo('1006（异常关闭）触发重连走退避序列')
  it.todo('4001（认证失效）不重连，标记需重新认证（壳降级 UI）')
  it.todo('4xxx（服务端正常关闭，如 4000/4003）不重连')
})

describe('ws-client 不变量 ④ seq 回放', () => {
  it.todo('seq gap 检测后发起 reconcile 请求（拉取缺失区间）')
  it.todo('reconcile 响应 → seqReset → reload 会话历史（重载前静默窗口逻辑保留）')
  it.todo('presence 弱可靠通道不入 seq 桶（靠 auth.ok/presence.list 兜底）')
})

describe('ws-client 不变量 ⑤ 重连退避', () => {
  it.todo('指数退避序列符合 base/cap/jitter 参数（如 1s/2s/4s… capped 30s + jitter）')
  it.todo('visibilitychange（页面可见）触发立即重连，并重置退避计数')
  it.todo('连续重连失败达上限后停止重连（防无限重试）')
})
