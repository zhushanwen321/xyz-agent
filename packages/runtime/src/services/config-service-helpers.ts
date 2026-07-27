/**
 * 纯辅助函数 + 默认/合并/校验逻辑，从 config-service.ts 提取以控制文件行数。
 *
 * 设计原则：本文件全部是纯函数（无 this、无 IO），只依赖入参 + shared 类型。
 * IO（existsSync/readFileSync/atomicWrite）仍留在 ConfigService，便于测试 mock。
 *
 * 三组逻辑：
 * 1. atomicWrite 临时后缀 + agent markdown 解析（通用辅助）
 * 2. system-prompt.json 的默认值 / 防御性合并 / 长度校验（FR-6/FR-7，ADR-0038）
 * 3. terminal.json 的默认值 / 防御性合并 / 字段范围校验（Phase 6 settings）
 */
import {
  SYSTEM_PROMPT_MAX_LENGTH,
  type SystemPromptConfig,
  type TerminalConfig,
} from '@xyz-agent/shared'
import { extractFrontmatter, extractDescription } from '../utils/frontmatter.js'

/** Terminal config 校验范围（与 TerminalPage 前端一致）。 */
export const FONT_SIZE_MIN = 6
export const FONT_SIZE_MAX = 72
export const SCROLLBACK_MAX = 100000

/** 合法的终端光标样式（setTerminalConfig 校验 + mergeTerminalConfig 兜底共用）。 */
const VALID_CURSOR_STYLES: TerminalConfig['cursorStyle'][] = ['block', 'underline', 'bar']

// ── atomicWrite 后缀 ──────────────────────────────────────────────

/**
 * 生成 atomicWrite 的唯一 tmp 后缀（时间戳 + 随机串），避免并发写入撞固定 .tmp 文件。
 * saveAppConfig / setSystemPromptConfig / setTerminalConfig 共用。
 */
export function uniqueTmpSuffix(): string {
  // eslint-disable-next-line no-magic-numbers -- base36 radix + slice 掉 "0." 前缀（惯用唯一串生成）
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`
}

// ── Agent markdown 解析 ───────────────────────────────────────────

/** Extract name and description from agent markdown frontmatter. */
export function parseAgentMd(content: string): { name: string; description: string } {
  const { frontmatter } = extractFrontmatter(content)
  // name 是简单单行键值，inline 提取（不进通用 helper——name 是 agent 专属字段）
  let name = ''
  for (const fl of frontmatter.split('\n')) {
    if (fl.startsWith('name:')) name = fl.slice('name:'.length).trim()
  }
  const description = extractDescription(frontmatter)
  return { name, description }
}

/** Runtime type guard for thinkingLevelMap values. */
export function isValidThinkingLevelMap(v: unknown): v is Record<string, string | null> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  return Object.values(v as Record<string, unknown>).every(val => val === null || typeof val === 'string')
}

// ── System prompt config（FR-6/FR-7，ADR-0038）───────────────────

export function defaultSystemPromptConfig(): SystemPromptConfig {
  return {
    version: 1,
    replace: { enabled: false, prompt: '' },
    append: { enabled: false, prompt: '' },
  }
}

/**
 * 防御性合并：把磁盘读到的 raw（可能字段缺失/类型错）合并到默认值上。
 * corrupted=false（字段级容错，不视为损坏）；只有 JSON.parse 失败才 corrupted=true。
 */
export function mergeSystemPromptConfig(raw: unknown): SystemPromptConfig {
  const base = defaultSystemPromptConfig()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base
  const r = raw as Record<string, unknown>
  const replaceRaw = r['replace']
  const appendRaw = r['append']
  const replace = (typeof replaceRaw === 'object' && replaceRaw !== null && !Array.isArray(replaceRaw))
    ? replaceRaw as Record<string, unknown>
    : {}
  const append = (typeof appendRaw === 'object' && appendRaw !== null && !Array.isArray(appendRaw))
    ? appendRaw as Record<string, unknown>
    : {}
  return {
    version: typeof r['version'] === 'number' ? r['version'] : base.version,
    replace: {
      enabled: typeof replace['enabled'] === 'boolean' ? replace['enabled'] : false,
      prompt: typeof replace['prompt'] === 'string' ? replace['prompt'] : '',
    },
    append: {
      enabled: typeof append['enabled'] === 'boolean' ? append['enabled'] : false,
      prompt: typeof append['prompt'] === 'string' ? append['prompt'] : '',
    },
  }
}

/**
 * 校验 setSystemPromptConfig 的 prompt 长度（replace + append 复用同一上限）。
 * 返回首个越界字段的错误信息；全部合法返回 undefined。
 */
export function validateSystemPromptConfig(config: SystemPromptConfig): string | undefined {
  if (config.replace.prompt.length > SYSTEM_PROMPT_MAX_LENGTH) {
    return `replace prompt exceeds max length (${SYSTEM_PROMPT_MAX_LENGTH})`
  }
  // append 同样校验长度：append 虽不走 argv（无 Windows 32k 限制），但无上限会导致
  // 每轮拼进 systemPrompt 的 token 失控。复用同一上限保持双卡 UX 一致。
  if (config.append.prompt.length > SYSTEM_PROMPT_MAX_LENGTH) {
    return `append prompt exceeds max length (${SYSTEM_PROMPT_MAX_LENGTH})`
  }
  return undefined
}

// ── Terminal config（Phase 6 settings）────────────────────────────

export function defaultTerminalConfig(): TerminalConfig {
  return {
    version: 1,
    shell: '',
    shellArgs: [],
    fontSize: 14,
    fontFamily: '',
    scrollback: 5000,
    cursorStyle: 'block',
    bell: true,
  }
}

/**
 * 防御性合并：把磁盘读到的 raw（可能字段缺失/类型错）合并到默认值上。
 * corrupted=false（字段级容错，不视为损坏）；只有 JSON.parse 失败才 corrupted=true。
 */
export function mergeTerminalConfig(raw: unknown): TerminalConfig {
  const base = defaultTerminalConfig()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base
  const r = raw as Record<string, unknown>
  const cursorRaw = r['cursorStyle']
  return {
    version: typeof r['version'] === 'number' ? r['version'] : base.version,
    shell: typeof r['shell'] === 'string' ? r['shell'] : base.shell,
    shellArgs: Array.isArray(r['shellArgs']) ? r['shellArgs'].filter((a): a is string => typeof a === 'string') : base.shellArgs,
    fontSize: typeof r['fontSize'] === 'number' && Number.isFinite(r['fontSize']) ? r['fontSize'] : base.fontSize,
    fontFamily: typeof r['fontFamily'] === 'string' ? r['fontFamily'] : base.fontFamily,
    scrollback: typeof r['scrollback'] === 'number' && Number.isFinite(r['scrollback']) ? r['scrollback'] : base.scrollback,
    cursorStyle: typeof cursorRaw === 'string' && (VALID_CURSOR_STYLES as string[]).includes(cursorRaw) ? cursorRaw as TerminalConfig['cursorStyle'] : base.cursorStyle,
    bell: typeof r['bell'] === 'boolean' ? r['bell'] : base.bell,
  }
}

/**
 * 校验 setTerminalConfig 的数值范围 + 光标样式（防异常值写盘后破坏 xterm 渲染或终端启动）。
 * 返回首个非法字段的错误信息；全部合法返回 undefined。
 */
export function validateTerminalConfig(config: TerminalConfig): string | undefined {
  if (!Number.isFinite(config.fontSize) || config.fontSize < FONT_SIZE_MIN || config.fontSize > FONT_SIZE_MAX) {
    return `fontSize out of range (${FONT_SIZE_MIN}-${FONT_SIZE_MAX}): ${config.fontSize}`
  }
  if (!Number.isFinite(config.scrollback) || config.scrollback < 0 || config.scrollback > SCROLLBACK_MAX) {
    return `scrollback out of range (0-${SCROLLBACK_MAX}): ${config.scrollback}`
  }
  if (!VALID_CURSOR_STYLES.includes(config.cursorStyle)) {
    return `invalid cursorStyle: ${config.cursorStyle}`
  }
  return undefined
}
