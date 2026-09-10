/**
 * 测试连接 port —— per-协议真实最小请求探测 provider 连通性（M3a）。
 *
 * 🔒 三层架构：services 定义 port，infra/model-connection-tester.ts 实现。
 * transport（settings-message-handler）经 ctx 注入消费，组合根（index.ts）
 * 构造 infra 实例并经 server.setServices 装配（对齐 ports/model.ts 的
 * IModelSource 模式）。协议集 SSOT 与请求/错误编码在 infra 实现侧。
 */

export interface ConnectionTestRequest {
  /** 协议（pi model.api）。未知协议由实现返回 `unsupported` 行，不抛。 */
  api: string
  modelId: string
  /** 已由编排层按回落链解析好的请求端点（非空）。 */
  baseUrl: string
  apiKey?: string
}

/** 单行测试结果（协议 × 代表模型）；`error` 语法见 infra/model-connection-tester.ts 文件头。 */
export interface ConnectionTestResult {
  api: string
  modelId: string
  ok: boolean
  error?: string
}

export interface IModelConnectionTester {
  /** 该协议是否在首版支持集内（协议集 SSOT 在本实现，services 层不复制）。 */
  supports(api: string): boolean
  test(request: ConnectionTestRequest): Promise<ConnectionTestResult>
}
