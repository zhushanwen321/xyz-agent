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

/** 页面文案（对齐真实组件 i18n 语义，UI 文案按 v6 设计稿润色；仿 mock/worktree.ts TEXT 模式） */
export const TEXT = {
  pageTitle: '终端配置',
  pageDesc: 'Shell、字体与终端偏好。修改仅对新启动的终端会话生效，已启动的终端不动态切换。',
  corruptedMsg: '终端配置文件已损坏，已回退默认配置',
  groupShell: 'Shell',
  shell: '默认 Shell',
  shellHint: '终端启动时使用的 shell 命令，留空使用 $SHELL 默认。',
  shellPlaceholder: '留空使用 $SHELL 默认',
  shellArgs: 'Shell 参数',
  shellArgsHint: '传递给 shell 的启动参数，逗号分隔（如 -l,-i）。',
  shellArgsPlaceholder: '逗号分隔，如 -l,-i',
  groupAppearance: '外观',
  fontSize: '字号',
  fontSizeHint: '终端字体大小，范围 6-72。',
  fontFamily: '字体',
  fontFamilyHint: '终端字体族，留空使用默认（如 Menlo, monospace）。',
  fontFamilyPlaceholder: '留空使用默认字体，如 Menlo, monospace',
  cursorStyle: '光标样式',
  cursorStyleHint: '终端光标的显示形态：方块 / 下划线 / 竖线。',
  cursorBlock: '方块',
  cursorUnderline: '下划线',
  cursorBar: '竖线',
  groupBehavior: '终端行为',
  scrollback: '回滚行数上限',
  scrollbackHint: '终端回滚缓冲区保留的最大行数，范围 0-100000。',
  bell: '响铃',
  bellHint: '收到响铃控制序列（BEL）时发出提示音。',
  saved: '已保存',
  unsaved: '未保存',
  save: '保存',
  saving: '保存中…',
  discard: '放弃',
  discardChanges: '放弃改动',
  continueEdit: '继续编辑',
  leaveTitle: '放弃未保存的改动？',
  leaveDesc: '终端配置有未保存的修改，离开后会丢失。可以先保存再离开，或直接放弃。',
  errFontSize: '请输入有效的字号',
  errScrollback: '请输入有效的回滚行数',
  errLoadFailed: '加载配置失败',
  errSaveFailed: '保存失败',
} as const

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
