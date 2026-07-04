import { readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ScannedSkillInfo } from '@xyz-agent/shared'
import { expandHome, inferSourceType, forEachScannedDir } from './scanner-base.js'
import { extractFrontmatter } from '../../utils/frontmatter.js'

const DESCRIPTION_MAX_LENGTH = 200
const TRIGGER_MIN_LENGTH = 2
const TRIGGER_MAX_LENGTH = 40
const BYTES_1KB = 1024
const BYTES_1MB = BYTES_1KB * BYTES_1KB

// skill 的 frontmatter 字段（description / argument-hint）用引号包裹语法（"..." / '...' / 裸值），
// 与 agent 的多行 `>-`/`|` 语法不同，故 description/argumentHint 解析留在本文件；
// 只抽 frontmatter 分割骨架（D1）。
export function parseSkillMd(content: string): { description: string; triggers: string[]; argumentHint?: string } {
  const { frontmatter, bodyStartLine } = extractFrontmatter(content)
  const lines = content.split('\n')
  let description = ''
  const triggers: string[] = []

  // 从 frontmatter 中提取 description 字段（支持 "..." / '...' / 裸值）
  const fmDescMatch = frontmatter
    .match(/^description:\s*(?:"([^"]+)"|'([^']+)'|(.+?))\s*$/m)
  const fmDesc = fmDescMatch?.[1] ?? fmDescMatch?.[2] ?? fmDescMatch?.[3]?.trim()

  // 正文 description：frontmatter 后第一个非标题、非空行
  for (let i = bodyStartLine; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (line.startsWith('#')) continue
    description = line.slice(0, DESCRIPTION_MAX_LENGTH)
    break
  }

  // 从 frontmatter 中提取 argument-hint 字段（支持 "..." / '...' / 裸值）
  const hintRaw = frontmatter
    .match(/^argument-hint:\s*(?:"([^"]+)"|'([^']+)'|(.+?))\s*$/m)
  const argumentHint = hintRaw?.[1] ?? hintRaw?.[2] ?? hintRaw?.[3]?.trim()

  // 优先用 frontmatter description 提取 triggers（含触发词模式）
  const triggerSource = fmDesc ?? description
  const triggerPattern = /["\u201c]([^"\u201d\u2018\u2019]+?)["\u201d]/g
  let match: RegExpExecArray | null
  while ((match = triggerPattern.exec(triggerSource)) !== null) {
    const t = match[1].trim()
    if (t.length >= TRIGGER_MIN_LENGTH && t.length <= TRIGGER_MAX_LENGTH) triggers.push(t)
  }

  return { description, triggers, argumentHint }
}

function formatFileSize(bytes: number): string {
  if (bytes < BYTES_1KB) return `${bytes} B`
  if (bytes < BYTES_1MB) return `${(bytes / BYTES_1KB).toFixed(1)} KB`
  return `${(bytes / BYTES_1MB).toFixed(1)} MB`
}

/**
 * Load a single skill from its directory (containing SKILL.md directly).
 * Used by loadSkills to read already-registered skill paths.
 * Returns null if the directory doesn't contain a valid SKILL.md.
 */
export function loadSkillFromDir(rawDirPath: string): ScannedSkillInfo | null {
  const dirPath = expandHome(rawDirPath)
  if (!existsSync(dirPath)) return null

  const skillMdPath = join(dirPath, 'SKILL.md')
  if (!existsSync(skillMdPath)) return null

  try {
    const content = readFileSync(skillMdPath, 'utf-8')
    const { description, triggers, argumentHint } = parseSkillMd(content)
    const stat = statSync(skillMdPath)
    const name = dirPath.split('/').pop() ?? ''
    const sourceType = inferSourceType(rawDirPath)

    return {
      id: `${sourceType}-${name}`,
      name,
      description,
      sourceType,
      sourcePath: skillMdPath,
      triggers,
      argumentHint,
      content,
      fileSize: formatFileSize(stat.size),
      tools: [],
      alreadyImported: false,
    }
  } catch {
    return null
  }
}

export function scanSkills(sources: string[], existingSkillIds: Set<string>): ScannedSkillInfo[] {
  const results: ScannedSkillInfo[] = []

  forEachScannedDir(sources, (dirPath, name, sourceType) => {
    const skillMdPath = join(dirPath, 'SKILL.md')

    if (!existsSync(skillMdPath)) return

    try {
      const content = readFileSync(skillMdPath, 'utf-8')
      const { description, triggers, argumentHint } = parseSkillMd(content)
      const stat = statSync(skillMdPath)
      const id = `${sourceType}-${name}`
      const alreadyImported = existingSkillIds.has(id)

      results.push({
        id,
        name: name,
        description,
        sourceType,
        sourcePath: skillMdPath,
        triggers,
        argumentHint,
        content,
        fileSize: formatFileSize(stat.size),
        tools: [],
        alreadyImported,
      })
    // eslint-disable-next-line taste/no-silent-catch -- intentional: skip unreadable skills, continue scanning
    } catch (e) {
      console.error(`[skill-scanner] error reading ${dirPath}:`, e)
    }
  })

  return results
}
