// [tc-transport-consolidation u2 桥] chat 域实现已下沉 @xyz-agent/core/transport/api/domains/chat（单域子路径，域目录无 barrel——10 个同名导出冲突不可打平）；本桥为迁移中间态，u5 codemod 改写全部消费者（import 前缀替换）后删除。域内 events/request 依赖经 core 内相对路径解析，与壳 events/request 桥指向同一 core 单例。
export * from '@xyz-agent/core/transport/api/domains/chat'
