/**
 * slash 命令 icon 组件映射 —— 薄 re-export（SSOT 在 @xyz-agent/ui）。
 *
 * 设计分层（audit §15.6 新发现-1 归位）：
 * - core `command-store.ts` 产出 icon key 字符串（builtin 命令名 / source 泛化 key）
 * - @xyz-agent/ui 把 key 绑定到 lucide 组件（SLASH_ICON_COMPONENTS，跨前端壳共享 SSOT）
 * - 本文件仅保持 renderer 消费方 import 路径不变（CommandPopover / Composer / CommandDocPanel）
 *
 * 命令专属 icon key 推断（iconKeyForCommand）已在 core 实现，消费方直接
 * `import { iconKeyForCommand } from '@xyz-agent/core'`（见 stores/command.ts）。
 */
export { SLASH_ICON_COMPONENTS } from '@xyz-agent/ui'
