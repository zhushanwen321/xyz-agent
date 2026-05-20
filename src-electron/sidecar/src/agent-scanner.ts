import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ScannedAgentInfo, ScanSourceType } from '@xyz-agent/shared'

const DESCRIPTION_MAX_LENGTH = 200

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

function inferSourceType(path: string): ScanSourceType {
  if (path.includes('.pi/')) return 'pi'
  if (path.includes('.claude/')) return 'claude'
  if (path.includes('.agents/')) return 'agents'
  return 'custom'
}

// 手写的 YAML frontmatter 解析，仅支持简单的 key: value 和多行 > 格式
// 不支持嵌套对象、引号内冒号、多行数组等复杂 YAML 场景
function parseAgentMd(content: string): { description: string; tools: string[] } {
  const lines = content.split('\n')
  const tools: string[] = []

  // 提取 YAML frontmatter 内容
  const frontmatterLines: string[] = []
  let inFrontmatter = false
  let frontmatterEnd = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true
        continue
      } else {
        frontmatterEnd = i + 1
        break
      }
    }
    if (inFrontmatter) frontmatterLines.push(lines[i])
  }

  const fmText = frontmatterLines.join('\n')

  // 从 frontmatter 提取 description（支持多行 > 或 |）
  let description = ''
  const fmDescMatch = fmText.match(/^description:\s*[>\|]?\s*$/m)
  if (fmDescMatch) {
    // 多行 description（> 或 | 格式）：取后续缩进行
    const startIdx = fmText.indexOf(fmDescMatch[0]) + fmDescMatch[0].length
    const remaining = fmText.slice(startIdx)
    const multilineParts: string[] = []
    for (const line of remaining.split('\n')) {
      if (line && !line.startsWith(' ') && !line.startsWith('\t')) break
      multilineParts.push(line.trim())
    }
    description = multilineParts.join(' ').trim().slice(0, DESCRIPTION_MAX_LENGTH)
  } else {
    const singleLine = fmText.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim()
    if (singleLine) description = singleLine.slice(0, DESCRIPTION_MAX_LENGTH)
  }

  // 正文 fallback
  if (!description) {
    for (let i = frontmatterEnd; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      if (line.startsWith('#')) continue
      description = line.slice(0, DESCRIPTION_MAX_LENGTH)
      break
    }
  }

  // 从 frontmatter 提取 tools
  const toolsMatch = fmText.match(/^tools:\s*(.+)$/m)?.[1]
  if (toolsMatch) {
    for (const t of toolsMatch.split(',')) {
      const trimmed = t.trim()
      if (trimmed) tools.push(trimmed)
    }
  }

  return { description, tools }
}

export function scanAgents(sources: string[], existingAgentIds: Set<string>): ScannedAgentInfo[] {
  const results: ScannedAgentInfo[] = []

  for (const rawSource of sources) {
    const source = expandHome(rawSource)
    const sourceType = inferSourceType(rawSource)

    if (!existsSync(source)) continue
    let entries
    try {
      entries = readdirSync(source, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const dirPath = join(source, entry.name)
      // statSync 跟随符号链接，正确处理 symlinked agent 目录
      try {
        if (!statSync(dirPath).isDirectory()) continue
      } catch {
        continue
      }

      // 查找主配置文件：优先 agent.md，备选目录名.md 或 SKILL.md
      const candidates = ['agent.md', `${entry.name}.md`, 'SKILL.md']
      let configPath: string | null = null
      let content = ''

      for (const c of candidates) {
        const p = join(dirPath, c)
        if (existsSync(p)) {
          configPath = p
          try { content = readFileSync(p, 'utf-8') } catch { continue }
          break
        }
      }

      if (!configPath) continue

      try {
        const { description, tools } = parseAgentMd(content)
        const id = `${sourceType}-${entry.name}`
        const alreadyImported = existingAgentIds.has(id)

        results.push({
          id,
          name: entry.name,
          description,
          sourceType,
          sourcePath: configPath,
          content,
          icon: entry.name.charAt(0).toUpperCase(),
          tools,
          alreadyImported,
        })
      // eslint-disable-next-line taste/no-silent-catch -- intentional: skip unreadable agents, continue scanning
      } catch (e) {
        console.error(`[agent-scanner] error reading ${dirPath}:`, e)
      }
    }
  }

  return results
}
