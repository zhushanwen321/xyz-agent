/**
 * qrcode-terminal 类型声明（包本身未带 .d.ts）。
 *
 * API（与 lib/main.js 实际导出对齐）：
 *  - generate(input, opts?, cb)：cb(qr: string) 收到 ASCII 二维码（每行含 ANSI 颜色码）
 *  - setErrorLevel(level)：'L' | 'M' | 'Q' | 'H'（默认 L）
 *
 * 用途：bootstrap.ts printStartup 经 generate 把连接 URL 渲染成终端可扫二维码。
 */
declare module 'qrcode-terminal' {
  export interface GenerateOptions {
    small?: boolean
  }

  export type ErrorCorrectLevel = 'L' | 'M' | 'Q' | 'H'

  export function generate(
    input: string,
    opts: GenerateOptions,
    cb: (qr: string) => void,
  ): void
  export function generate(input: string, cb: (qr: string) => void): void
  export function setErrorLevel(level: ErrorCorrectLevel): void

  const QRCode: {
    generate: typeof generate
    setErrorLevel: typeof setErrorLevel
  }
  export default QRCode
}
