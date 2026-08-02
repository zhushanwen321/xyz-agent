# 0001: 手动 DI 组装，不引入 IoC 容器

## 状态

已接受

## 上下文

Agent Runtime 需要从上帝类（server.ts 574L + session-pool.ts 472L）重构为 Service + Transport 分层。核心模块（SessionService、ConfigService、ModelService）需要通过依赖注入解耦，使 Transport 层（server.ts）只负责消息路由。

可选方案：
1. **tsyringe / inversify** — IoC 容器，自动解析依赖图
2. **手动构造函数注入** — 在 index.ts 中手动 new 所有对象并传入依赖

## 决策

手动构造函数注入。index.ts 负责组装依赖图。

## 理由

- 项目只有 3 个 Service + 1 个 Transport，依赖图深度 2 层。IoC 容器的学习成本（装饰器/容器配置/生命周期管理）远超收益
- 手动组装在 index.ts 中一目了然，调试时直接看构造函数参数就知道依赖关系
- 避免 reflect-metadata 运行时开销和装饰器编译配置
- 服务端 Node.js 单进程，不存在需要动态加载/替换实现的场景

## 后果

- 新增 Service 时需要手动在 index.ts 中添加组装代码
- 如果 Service 数量增长到 10+，需要重新评估（但当前项目规模不太可能）
- 测试时需要手动构造 stub，但因为接口已定义（interfaces.ts），stub 创建成本低
