// [tc-transport-consolidation u1 桥] request 实现已下沉 @xyz-agent/core/transport/api（出站直连 core ws-client.send，不再经壳 transport.ts）；本桥为迁移中间态，u5 codemod 改写全部消费者后删除。
export * from '@xyz-agent/core/transport/api'
