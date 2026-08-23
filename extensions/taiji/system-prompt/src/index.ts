/**
 * System prompt injection extension for Pi.
 *
 * Registers a `before_agent_start` hook that:
 *  1. Reads <dataDir>/system-prompt.json every turn (mtime-cached, see
 *     `cachedReadFileSync`).
 *  2. When `append.enabled === true` and `append.prompt` is non-blank,
 *     appends the user's text to the event's systemPrompt.
 *  3. Reads the global instructions file `~/.agents/AGENTS.md` (candidates
 *     AGENTS.md / AGENTS.MD / CLAUDE.md / CLAUDE.MD — mirroring pi's native
 *     `loadContextFileFromDir`) every turn and appends it under a labeled
 *     header. Opt-in by file existence: no file → no injection. Skipped when
 *     pi was spawned with `--no-context-files` (consistent with pi's native
 *     context-file opt-out). `XYZ_GLOBAL_AGENTS_DIR` overrides the global
 *     directory (test hook / escape hatch).
 *
 * Injection order per turn: base prompt → global instructions → append config
 * (the explicitly configured text wins last).
 *
 * Fail-safe: any error in the handler is swallowed and `undefined` is returned
 * so the agent loop is never blocked.
 */

import path from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import type { ExtensionAPI, BeforeAgentStartEvent } from '@earendil-works/pi-coding-agent'

const CONFIG_FILE = 'system-prompt.json'

/**
 * mtime 级文件内容缓存（KV-cache 稳定性改造）：每 turn 仍 stat 判变（文件被编辑后
 * 下一轮即读到新内容，语义与逐 turn 重读一致），但 mtime 未变时跳过 readFileSync——
 * 注入文本进每 turn system prompt，读盘路径上不引入额外开销。进程级缓存，per-process
 * = per-session，生命周期对齐。stat/read 失败 → 驱逐条目返回 null。
 */
const fileContentCache = new Map<string, { mtimeMs: number; size: number; content: string }>()

function cachedReadFileSync(filePath: string): string | null {
  try {
    const stat = statSync(filePath)
    const entry = fileContentCache.get(filePath)
    // 双键判变：mtimeMs 相同粒度内被外部编辑器/脚本覆写且长度变化时 size 仍能命中
    if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) return entry.content
    const content = readFileSync(filePath, 'utf-8')
    fileContentCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, content })
    return content
  } catch {
    fileContentCache.delete(filePath)
    return null
  }
}

/** Global instruction candidates, mirroring pi's loadContextFileFromDir. */
const GLOBAL_AGENTS_CANDIDATES = ['AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']

/**
 * Resolve the data directory from the environment.
 *
 * Priority:
 *  1. `process.env.XYZ_AGENT_DATA_DIR` (explicit)
 *  2. `path.resolve(process.env.PI_CODING_AGENT_DIR ?? '', '..', '..')`
 *     (PI_CODING_AGENT_DIR == <dataDir>/pi/agent, two levels up == dataDir)
 *
 * Re-read on every handler invocation so env changes between turns/sessions
 * take effect without reloading the extension.
 */
function resolveDataDir(): string {
  if (process.env.XYZ_AGENT_DATA_DIR) {
    return process.env.XYZ_AGENT_DATA_DIR
  }
  return path.resolve(process.env.PI_CODING_AGENT_DIR ?? '', '..', '..')
}

/**
 * Resolve the global agents directory.
 *
 * Priority:
 *  1. `process.env.XYZ_GLOBAL_AGENTS_DIR` (explicit override; tests / escape
 *     hatch)
 *  2. `~/.agents` (the user-global agents dir that also hosts skills/templates)
 *
 * Re-read on every handler invocation so env changes take effect.
 */
function resolveGlobalAgentsDir(): string {
  if (process.env.XYZ_GLOBAL_AGENTS_DIR) {
    return process.env.XYZ_GLOBAL_AGENTS_DIR
  }
  return path.join(homedir(), '.agents')
}

/**
 * Read the global instructions file. First candidate that exists and is a
 * regular file with non-blank content wins (mirrors pi's loadContextFileFromDir
 * semantics). Returns { path, content } or null; never throws.
 */
function readGlobalAgentsFile(): { path: string; content: string } | null {
  const dir = resolveGlobalAgentsDir()
  // Match candidates against real directory entries (exact case) instead of
  // existsSync-per-candidate: on case-insensitive filesystems (macOS APFS
  // default) existsSync('AGENTS.md') would hit a file actually named
  // AGENTS.MD, reporting an injected path that differs from the on-disk
  // filename and shadowing the later exact-case candidate.
  let entries: Set<string>
  try {
    entries = new Set(readdirSync(dir))
  } catch {
    return null
  }
  for (const name of GLOBAL_AGENTS_CANDIDATES) {
    if (!entries.has(name)) continue
    const filePath = path.join(dir, name)
    try {
      if (statSync(filePath).isFile()) {
        const content = cachedReadFileSync(filePath)
        if (content !== null && content.trim()) {
          return { path: filePath, content }
        }
      }
    } catch (err) {
      // best-effort：候选文件 stat/read 失败（如权限）→ 试下一个候选，never throw into the agent loop。
      console.debug('[xyz-system-prompt-extension] candidate file read failed, trying next:', err)
    }
  }
  return null
}

/**
 * Read & parse the config file. Missing / malformed / partial → all-default.
 * Returns the effective config object; never throws.
 */
function readConfig(dataDir: string): {
  version: number
  replace: { enabled: boolean; prompt: string }
  append: { enabled: boolean; prompt: string }
} {
  const parsed = readJsonIfValid(path.join(dataDir, CONFIG_FILE))
  if (!parsed) {
    return {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: false, prompt: '' },
    }
  }
  // Merge defensively — every field has its own default.
  // replace 字段仅防御性解析保持 config 结构完整，不参与本 hook 逻辑——
  // replace 走 --system-prompt CLI（ADR-0038），hook 只处理 append。
  return {
    version: typeof parsed.version === 'number' ? parsed.version : 1,
    replace: readSection(parsed.replace),
    append: readSection(parsed.append),
  }
}

/** Read a JSON file and return it as an object; missing / malformed / non-object → null. */
function readJsonIfValid(filePath: string): Record<string, unknown> | null {
  try {
    const raw = cachedReadFileSync(filePath)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    return isJsonObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

/** Defensive field parsing for a `replace`/`append` config section. */
function readSection(raw: unknown): { enabled: boolean; prompt: string } {
  const section = isJsonObject(raw) ? raw : {}
  return {
    enabled: section.enabled === true,
    prompt: typeof section.prompt === 'string' ? section.prompt : '',
  }
}

/**
 * pi 是否以 --no-context-files / -nc 启动。用户显式退出 AGENTS.md / CLAUDE.md
 * 发现时，全局文件不得从这条通路溜回来。pi CLI 把 -nc 视为 --no-context-files
 * 的等价短形式（cli/args.ts），两种形式都必须命中守卫——与镜像侧
 * （argv-mirror.ts 同样解析两种形式）保持一致。
 */
function contextFilesDisabled(): boolean {
  return process.argv.includes('--no-context-files') || process.argv.includes('-nc')
}

/** Append the global instructions (~/.agents/AGENTS.md ...) under a labeled header. */
function withGlobalInstructions(prompt: string): string {
  if (contextFilesDisabled()) return prompt
  const global = readGlobalAgentsFile()
  if (!global) return prompt
  return prompt + '\n\n# Global instructions (' + global.path + ')\n\n' + global.content
}

/** Read the append config and apply it to the prompt (empty append → unchanged). */
function withAppendPrompt(prompt: string): string {
  const cfg = readConfig(resolveDataDir())
  if (!cfg.append.enabled || !cfg.append.prompt.trim()) return prompt
  return prompt + '\n\n' + cfg.append.prompt
}

/**
 * Build the injected system prompt. Injection order per turn:
 * base prompt → global instructions → append config (the explicitly
 * configured text wins last). Returns the new systemPrompt, or undefined
 * when nothing changed.
 */
function buildSystemPrompt(event: BeforeAgentStartEvent): { systemPrompt: string } | undefined {
  const basePrompt = typeof event.systemPrompt === 'string' ? event.systemPrompt : ''
  const newPrompt = withAppendPrompt(withGlobalInstructions(basePrompt))
  return newPrompt === event.systemPrompt ? undefined : { systemPrompt: newPrompt }
}

/** 落盘诊断（pi stderr 经 rpc-client 写入 logs/pi-*.jsonl），不泄露配置内容。 */
function logHookFailure(err: unknown): void {
  try {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    process.stderr.write(`[xyz-system-prompt-extension] before_agent_start hook failed: ${msg}\n`)
  } catch (nestedErr) {
    // best-effort：stderr 写失败的终极兜底——console 内部吞错不会抛，仍不外泄到 agent loop。
    console.debug('[xyz-system-prompt-extension] stderr write also failed:', nestedErr)
  }
}

export default function (pi: ExtensionAPI): void {
  pi.on('before_agent_start', (event: BeforeAgentStartEvent) => {
    try {
      return buildSystemPrompt(event)
    } catch (err) {
      // Never block the agent loop.
      logHookFailure(err)
      return undefined
    }
  })
}