/** Mock 数据层 — 系统提示词设置页（SystemPromptPage）静态数据 */

/** C7：mock 拉取 pi 当前生效系统提示词（首次启用填充的修改起点） */
export const FETCHED_PI_PROMPT = `你是 pi，一个交互式编码 agent。\n你通过读写文件、执行命令、编辑代码来帮助用户完成任务。\n保持回复简洁，明确展示文件路径。`

/** C7：append 卡首次启用模板（追加无默认全文，模板更轻，spec §5） */
export const APPEND_TEMPLATE = `请遵循以下额外指引：\n- 回答前先阅读相关文件\n- 修改涉及多文件时先列出改动清单`

/** append 卡默认追加内容（初始已启用；快照初值与其一致 → 首屏 clean） */
export const DEFAULT_APPEND = `\n附加规则：\n- 优先复用现有代码而非新建\n- 修改前先理解上下文`

/** pi 默认系统提示词只读参考（占位 stub；真实全文不内置，demo 裁剪项） */
export const PI_DEFAULT_REF = `# pi 默认系统提示词（只读参考）\n你是 pi，一个由 ZCode 驱动的 agent……\n[此处为内置系统提示词全文，仅作参考]`
