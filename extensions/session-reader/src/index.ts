import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/**
 * pi-session-reader extension 入口。
 *
 * M1 阶段：仅含 core 纯逻辑核（src/core/），不注册任何工具/命令。
 * M3 将在此 registerTool('session_read', ...)（design.md §3.4 接口规格）。
 * M4 将在此 addAutocompleteProvider（TUI # 补全，ctx.mode === 'tui' 时）。
 */
export default function sessionReaderExtension(_pi: ExtensionAPI) {
  // M1: 无副作用。core 模块由测试直接 import。
}
