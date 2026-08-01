/** Mock 数据层 — 终端设置页（TerminalPage）静态数据 + 异步存取模拟。
 * 字段对齐真实项目 @xyz-agent/shared protocol.ts TerminalConfig（config.getTerminalConfig / setTerminalConfig）。*/

/** 终端配置（真实字段：version/shell/shellArgs/fontSize/fontFamily/scrollback/cursorStyle/bell） */
export interface TerminalConfig {
  version: number
  shell: string
  shellArgs: string[]
  fontSize: number
  fontFamily: string
  scrollback: number
  cursorStyle: 'block' | 'underline' | 'bar'
  bell: boolean
}

/** config.getTerminalConfig 返回结构（corrupted = 磁盘配置损坏，已回退默认） */
export interface TerminalConfigResult {
  config: TerminalConfig
  corrupted: boolean
}

/** 磁盘默认配置（首次启动 / 损坏回退后的落盘值） */
export const DEFAULT_TERMINAL_CONFIG: TerminalConfig = {
  version: 1,
  shell: '',
  shellArgs: [],
  fontSize: 14,
  fontFamily: '',
  scrollback: 1000,
  cursorStyle: 'block',
  bell: false,
}

/** 字号合法区间（对齐真实组件输入 min=6 / max=72） */
export const FONT_SIZE_MIN = 6
export const FONT_SIZE_MAX = 72
/** 回滚行数合法区间（对齐真实组件输入 min=0 / max=100000） */
export const SCROLLBACK_MIN = 0
export const SCROLLBACK_MAX = 100000

/** RPC 延迟模拟：加载 400ms / 保存 500ms（设计上下文 §4.3：mock 延迟 400-600ms） */
export const LOAD_DELAY_MS = 400
export const SAVE_DELAY_MS = 500

/** demo 开关：翻成 true 可预览 corrupted 提示条（真实场景由后端磁盘损坏检测驱动，demo 默认干净） */
export const DEMO_CORRUPTED = false

/** 模拟 config.getTerminalConfig（加载成功分支；失败分支 demo 不触发，加载失败走 save-bar 错误条） */
export function fetchTerminalConfig(): Promise<TerminalConfigResult> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ config: { ...DEFAULT_TERMINAL_CONFIG }, corrupted: DEMO_CORRUPTED })
    }, LOAD_DELAY_MS)
  })
}

/** 模拟 config.setTerminalConfig：范围越界 → reject（服务端校验失败分支，页面 save-bar 显示错误条）。
 * 成功后 resolve 保存值（快照以此刷新，dirty 自动归零）。 */
export function saveTerminalConfig(config: TerminalConfig): Promise<TerminalConfig> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (config.fontSize < FONT_SIZE_MIN || config.fontSize > FONT_SIZE_MAX) {
        reject(new Error(`字号需在 ${FONT_SIZE_MIN}-${FONT_SIZE_MAX} 之间`))
        return
      }
      if (config.scrollback < SCROLLBACK_MIN || config.scrollback > SCROLLBACK_MAX) {
        reject(new Error(`回滚行数需在 ${SCROLLBACK_MIN}-${SCROLLBACK_MAX} 之间`))
        return
      }
      resolve({ ...config })
    }, SAVE_DELAY_MS)
  })
}
