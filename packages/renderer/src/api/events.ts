// [tc-transport-consolidation u1 桥] events 实现已下沉 @xyz-agent/core/transport/api；本桥为迁移中间态，u5 codemod 改写全部消费者后删除。三通道 handler 注册表随迁移保持模块级单例语义。
export * from '@xyz-agent/core/transport/api'
