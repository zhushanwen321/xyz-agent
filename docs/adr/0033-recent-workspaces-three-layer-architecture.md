# ADR-0002: recent-workspaces 采用三层架构（不引入 DDD4）

- **Status**: accepted
- **Date**: 2026-07-03
- **From**: `2026-07-03-recent-workspaces §system-architecture §1, §decisions D-003`

## 背景

recent-workspaces 功能需要：记录用户最近使用的目录（cwd）、去重、LRU 淘汰保 10、持久化到本地文件、启动时读取、前端展示与搜索。

设计时考虑过引入 DDD4（领域驱动分层 + 聚合根 + 领域事件）。理由是「最近工作区」是一个独立的领域概念，似乎值得专门的领域层。

## 决策

采用三层架构（transport handler / service+store / 前端 store），**不引入 DDD4**。

```
transport/workspace-message-handler  ← RPC 路由（零业务）
  └─ services/workspace/workspace-service  ← 写入时机编排 + INV-1 主守卫
      └─ services/workspace/recent-workspaces-store  ← LRU/去重/排序（纯算法）+ WriteBackCache 持久化
```

## 备选方案（取舍）

| 方案 | 取舍 |
|------|------|
| **三层（采纳）** | 核心计算是技术流程编排（LRU/去重/排序纯算法），无业务规则引擎/聚合行为，三层足矣 |
| DDD4（聚合根 + 领域事件） | 过度设计——没有跨聚合的业务不变式，没有领域事件消费者，领域层会退化为 store 的薄包装 |

## 后果

- store 层是纯算法 + 持久化，无业务规则注入点，测试简单（单测覆盖 LRU/去重/损坏降级即可）
- service 层只做「写入时机编排 + 空值守卫」，不持有数据
- 未来若「最近工作区」演化出业务规则（如按项目类型分组、使用频率加权），可升级为领域层——但 YAGNI，当前不做

## 验证

- store 层单测 11 条（T1.1-T1.8 + flushAll/startFlushTimer 行为）全绿
- service 层单测 7 条（T2.1-T2.7）全绿
- 跨进程持久化 E2E（T4.6）real Playwright 18.3s pass
