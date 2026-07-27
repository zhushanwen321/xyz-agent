/**
 * wsUrlToHttpOrigin —— WS 同源 HTTP origin 推导纯函数。
 *
 * 用途（spec §十 D8）：远程模式下 DetailPane 图片走签名 URL，`<img src>` 需要把 ws(s):// 配置地址
 * 转成同源的 http(s):// 拼接 signUrl 相对路径（`/file?...`）。
 *
 * 行为：
 * - ws://host:port → http://host:port
 * - wss://host     → https://host（无显式端口不补端口）
 * - 非 ws(s) scheme 或畸形输入 → 安全降级返回空串（保证 imageUrl 拼接不 crash，spec §十 D8）。
 *
 * 无依赖、无副作用。
 *
 * 依赖方向：无下游（被 DetailPane.vue 等远程图片消费方调用）。
 */

/**
 * 把 WS 地址推导为同源 HTTP origin。
 *
 * @param wsUrl ws:// 或 wss:// 开头的完整 URL
 * @returns 同源 http(s)://host[:port] 字符串；无法解析时返回空串
 */
export function wsUrlToHttpOrigin(wsUrl: string): string {
  if (!wsUrl) return ''
  let parsed: URL
  try {
    parsed = new URL(wsUrl)
  } catch {
    // 畸形 URL 构造器抛 TypeError → 安全降级返回空串，不 crash 调用方
    return ''
  }
  const protocol = parsed.protocol
  let httpProtocol: string
  if (protocol === 'ws:') {
    httpProtocol = 'http:'
  } else if (protocol === 'wss:') {
    httpProtocol = 'https:'
  } else {
    // 非 ws(s) scheme（含已是 http(s)）：按 spec §十 D8，对无法识别为 WS 的输入降级返回空串，
    // 避免错误替换污染 imageUrl。调用方应仅对 WS 配置地址调用本函数。
    return ''
  }
  // URL.host 自动含端口（有显式端口时为 host:port，否则纯 host），原样保留
  return `${httpProtocol}//${parsed.host}`
}
