// [tc-transport-consolidation u2 桥] extension 域实现已下沉 @xyz-agent/core/transport/api/domains/extension（出站 extension.ui_response 自 ../transport 改锚 core ws-client.send，transport.send 为其纯透传）；本桥为迁移中间态，u5 codemod 改写全部消费者（import 前缀替换）后删除。
export * from '@xyz-agent/core/transport/api/domains/extension'
