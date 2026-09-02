// [tc-transport-consolidation u1 桥] pending 实现已下沉 @xyz-agent/core/transport/api；本桥为迁移中间态，u5 codemod 改写全部消费者后删除。pending 是模块级单例，桥 re-export 后全进程消费者（壳 TransportPorts 装配与后续 core 内部）解析到同一 core 单例。
export * from '@xyz-agent/core/transport/api'
