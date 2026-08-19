/**
 * Session 文件工具函数
 *
 * 提供 session .jsonl 文件的解析、创建、重命名、扫描等操作。
 * 从 pi-config-bridge.ts 提取以控制文件行数（pi-config-bridge 已删除）。
 */

import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, readdirSync, unlinkSync, writeFileSync, renameSync } from 'node:fs'
import { atomicWrite } from '../../utils/fs-utils.js'
import { parseJsonl, readTailEntries } from '../../utils/jsonl.js'
import { join, dirname, basename } from 'node:path'
import { getSessionsDir } from './pi-paths.js'

// ── 类型定义 ─────────────────────────────────────────────────

export interface SessionHeader {
  id: string
  cwd: string
  timestamp: string
  /** 父 session 血缘键（fork 出的 session header 指回源文件/源 sessionId）。 */
  parentSession?: string
  /** fork 锚点 entry id（截断点）。 */
  forkEntryId?: string
}

// ── 解析工具 ─────────────────────────────────────────────────

/**
 * parseSessionHeader 的头部读块大小（4KB）。
 *
 * session header（type:"session"，含 cwd/parentSession/forkEntryId）固定在 JSONL 首行，
 * 4KB 覆盖正常 header（cwd 长路径 + 路径型字段）。JSONL 行内无换行：块内无换行且未读满
 * （文件本身 < 4KB 的单行文件）按无首行终止处理；块读满仍无换行（首行 > 4KB）回退
 * 全量读取首行——旧 readFileSync 全量读实现可解析任意长度首行，单纯截断会让超长首行
 * JSON.parse 失败 → session 从侧栏消失（W20 review Fix-4 等价性修复）。
 */
const HEADER_READ_CHUNK_BYTES = 4096

/** LF（'\n'）字节值——JSONL 行终止符，Buffer.indexOf 用字节比较。 */
const NEWLINE_BYTE = 0x0a

/**
 * 解析 session JSONL 首行的 session header。
 *
 * wave:perf-w20 微项 9：只读文件头部一小块（而非 readFileSync 全量读再 split('\n')[0]）。
 * header 固定在首行，长 session 文件（数 MB）全量读只为取第一行是纯浪费；扫描器对每个
 * 候选文件调一次本函数，节省随文件数线性放大。
 */
export function parseSessionHeader(filePath: string): SessionHeader | null {
  try {
    const fd = openSync(filePath, 'r')
    let head: Buffer
    let bytesRead = 0
    try {
      const chunk = Buffer.alloc(HEADER_READ_CHUNK_BYTES)
      bytesRead = readSync(fd, chunk, 0, chunk.length, 0)
      head = chunk.subarray(0, bytesRead)
    } finally {
      closeSync(fd)
    }
    const nlIndex = head.indexOf(NEWLINE_BYTE)
    let firstLine: string
    if (nlIndex !== -1) {
      firstLine = head.subarray(0, nlIndex).toString('utf-8')
    } else if (bytesRead >= HEADER_READ_CHUNK_BYTES) {
      // 首行 > 4KB（4KB 块读满仍未见换行）：回退全量读取首行，与旧 readFileSync 全量读
      // 实现严格等价（W20 review Fix-4——超长首行可解析，session 不从侧栏消失）。
      // readFileSync 失败由外层 catch 返回 null，与打开/读取失败同错误面。
      const content = readFileSync(filePath, 'utf-8')
      const contentNl = content.indexOf('\n')
      firstLine = contentNl === -1 ? content : content.slice(0, contentNl)
    } else {
      // 文件本身 < 4KB 且无换行（单行 JSONL）：head 即全量内容
      firstLine = head.toString('utf-8')
    }
    if (!firstLine) return null
    const entry = JSON.parse(firstLine)
    if (entry.type !== 'session') return null
    return {
      id: entry.id,
      cwd: entry.cwd,
      timestamp: entry.timestamp,
      parentSession: typeof entry.parentSession === 'string' ? entry.parentSession : undefined,
      forkEntryId: typeof entry.forkEntryId === 'string' ? entry.forkEntryId : undefined,
    }
  } catch {
    return null
  }
}

/**
 * 从 .jsonl 文件提取最后一个 session_info 的 name 字段。
 * pi 的 session 会 append 多条 session_info，取最后一条作为当前名称。
 *
 * W2 尾读优化：先尾读（readTailEntries）找尾部最后一条 session_info。
 * pi 对 session_info 的持久化是 append（[HISTORICAL] xyz 侧同名直写函数已于 W11
 * 删除，append 语义现仅指 pi 自身的落盘行为），晚期 rename 的 session_info 在尾部可命中。
 * 未命中（INVAR-tail-2 SR1）→ fallback 全量读——早期命名 + 长对话追加会把最后一条
 * session_info 推到文件头部，尾窗找不到，必须 fallback 保证正确性（不丢名字）。
 */
export function extractSessionName(filePath: string): string | null {
  return findLastEntryField(filePath,
    (e) => e.type === 'session_info' && typeof e.name === 'string',
    (e) => e.name as string,
  )
}

// ── session 终态 entry（W4，ADR 0042）─────────────────────────

/**
 * session 结束时的终态类型（W4，ADR 0042 + W1 sidecar 方案）。
 * runtime 在 3 个终态点写 session_end 到 sidecar `.meta.json`（不写 JSONL），scanner
 * 据此派生终态，让前端侧栏无需预加载历史即可显示 done/error/stopped。
 */
export type SessionOutcome = 'done' | 'error' | 'stopped'

/**
 * W-Runtime4：合法的 outcome 值集合（与 SessionOutcome 类型同步）。
 * extractSessionOutcome 读 sidecar/JSONL 时校验值合法性——文件内容可能损坏/被篡改，
 * 不校验直接断言会把无效值当合法终态返回，污染 session 状态。
 */
const VALID_SESSION_OUTCOMES = ['done', 'error', 'stopped'] as const

/**
 * 将 session 终态持久化到 sidecar `.meta.json`（W4，ADR 0042 + W1 sidecar 方案）。
 *
 * 与 JSONL 同目录写 `.meta.json`（存 session_end 元数据），不污染 JSONL——pi 的
 * _persist 永远只写 message/session_info，runtime 的终态独立存 sidecar，避免「pi
 * 忽略未知 type」的隐式约定。
 *
 * [规则 #6] 文件不存在时**绝不创建 sidecar**（与 pi 0.80.3 _persist 的 openSync("wx") 竞态）。
 * 进程崩溃（SIGKILL/OOM）可能来不及执行，这类 session 读不到终态 → scanner 回退 idle。
 *
 * @param filePath session JSONL 绝对路径（sidecar = filePath + '.meta.json'）
 * @param outcome 终态：done（正常完成）/ error（LLM 出错）/ stopped（用户 abort/进程崩溃）
 * @param reason 可选人类可读原因（error 的 errorMessage / stopped 的 abort reason）
 */
export function persistSessionEnd(filePath: string, outcome: SessionOutcome, reason?: string): void {
  if (!filePath) return
  if (!existsSync(filePath)) {
    // 文件不存在（pi 延迟写入窗口 / 首 turn 前崩溃）：绝不创建文件，直接跳过。
    return
  }
  const meta = { type: 'session_end', outcome, reason, timestamp: new Date().toISOString() }
  try {
    // 原子写（tmpfile + rename）：与 sidecar 家族各写点一致，防止并发读读到半写的 sidecar。
    // （[HISTORICAL] 原注释参照 patchSessionCwd——该直写函数已随 W11 删除。）
    atomicWrite(filePath + '.meta.json', JSON.stringify(meta), `meta-${Date.now()}`)
    // W2-2：sidecar 写入后主动失效该文件的 meta 缓存。
    // scanSessionMeta 缓存键只含 JSONL 的 (mtimeMs, size)，sidecar 变更不会让 JSONL 的 stat 变化，
    // 导致命中缓存返回旧 outcome（如 session 被 abort/崩溃 → persistSessionEnd 写 stopped 到 sidecar，
    // 但 JSONL 未变 → 下次 scan 命中缓存 → 返回 stale outcome=null，侧栏显示 idle 而非 stopped）。
    // 删除缓存条目后，下次 scan 重新读 sidecar 拿到新 outcome。
    sessionMetaCache.delete(filePath)
  // eslint-disable-next-line taste/no-silent-catch -- file write: failure must not crash caller
  } catch (e) {
    console.error(`[session-file-utils] persistSessionEnd failed: ${filePath}`, e)
  }
}

/**
 * 计算 session preset sidecar 路径（S-RT-3）。
 *
 * 统一管理 `<sessionFile>.preset.json` 的路径拼接（原 persistPresetBinding/readPresetBinding
 * 各自硬编码 `filePath + '.preset.json'`）。提取为 helper 后：
 *   - 单点维护后缀（未来若改命名规则只改这里）
 *   - 调用方语义清晰（presetSidecarPath(filePath) 比 filePath + '.preset.json' 更自解释）
 *
 * 注意：与 `.meta.json`（session 终态 sidecar）并列但独立，由 metaSidecarPath 风格的
 * 专用 helper 各自管理（meta sidecar 当前内联在 persistSessionEnd/extractSessionOutcome，
 * 属 session-lifecycle 范围，本文件不重构）。
 */
export function presetSidecarPath(filePath: string): string {
  return filePath + '.preset.json'
}

/**
 * 计算 session project 归属 sidecar 路径（D14 语义修正，2026-08-04）。
 * `<sessionFile>.project.json`：session 归属的 project id（与 preset/meta sidecar 并列独立）。
 */
export function projectSidecarPath(filePath: string): string {
  return filePath + '.project.json'
}

/**
 * 将 session 归属 project 持久化到 sidecar `.project.json`（D14：Project 直接关联 Session）。
 *
 * session create 成功 / 手动归类（session.setProject）时调用。归属是 session 级数据，
 * 跟 session 走（删除 session 归属自动消失，fork 继承父归属）。
 *
 * [规则 #6] session JSONL 文件不存在时**绝不创建 sidecar**（与 persistPresetBinding 同守则）：
 * pi 延迟写入窗口内 existsSync=false → 静默跳过；active session 归属经内存态兑底
 *（ManagedSession.projectId），不阻断主流程。
 *
 * @param filePath session JSONL 绝对路径（sidecar = projectSidecarPath(filePath)）
 * @param projectId 归属 project id（空串 = 归回默认项目，删除已存在的绑定 sidecar）
 */
export function persistProjectBinding(filePath: string, projectId: string): void {
  if (!filePath) return
  // 空 projectId（归回默认项目）= 删除绑定 sidecar。readProjectBinding 以 sidecar 为权威（无 sidecar
  // 兑底 undefined → 展示层归入默认项目），若只 return 不删，已存在的 .project.json 会继续生效——
  // 重启后 session 归属回退到旧命名项目（review MF-2 回归）。删除不创建文件，不违反规则 #6，
  // 因此不依赖 JSONL 存在性，放在 existsSync 检查之前执行。
  if (!projectId) {
    const sidecarPath = projectSidecarPath(filePath)
    try {
      if (existsSync(sidecarPath)) {
        unlinkSync(sidecarPath)
        // 与写入分支同失效处理：缓存键只含 JSONL 的 (mtimeMs, size)，sidecar 删除不变 JSONL stat，
        // 不删缓存会命中旧 projectId（扫描读回已删除的归属）。
        sessionMetaCache.delete(filePath)
      }
    // eslint-disable-next-line taste/no-silent-catch -- file delete: failure must not crash caller
    } catch (e) {
      console.error(`[session-file-utils] persistProjectBinding: failed to delete sidecar: ${sidecarPath}`, e)
    }
    return
  }
  if (!existsSync(filePath)) {
    // 文件不存在（pi 延迟写入窗口）：绝不创建文件，直接跳过（ES-RL-1 同款）。
    return
  }
  const binding = { projectId, version: 1 as const }
  try {
    atomicWrite(projectSidecarPath(filePath), JSON.stringify(binding), `project-${Date.now()}`)
    // sidecar 写入后主动失效 sessionMetaCache（缓存键只含 JSONL 的 (mtimeMs, size)，
    // sidecar 变更不变 JSONL stat → 命中缓存返回旧值，与 persistPresetBinding 同处理）。
    sessionMetaCache.delete(filePath)
  // eslint-disable-next-line taste/no-silent-catch -- file write: failure must not crash caller
  } catch (e) {
    console.error(`[session-file-utils] persistProjectBinding failed: ${filePath}`, e)
  }
}

/**
 * 从 `.project.json` sidecar 读取 session 归属 project id。
 *
 * scanSessionMeta 第五读：与 launchPresetId 同批次提取，结果合并进 ScannedSessionMeta.projectId，
 * 享受 sessionMetaCache 缓存（禁止在 scannedToSummary 独立读文件）。
 *
 * @returns projectId 字符串；sidecar 不存在/损坏/projectId 非字符串 → undefined
 */
export function readProjectBinding(filePath: string): string | undefined {
  const sidecarPath = projectSidecarPath(filePath)
  try {
    const raw = readFileSync(sidecarPath, 'utf-8')
    const binding = JSON.parse(raw)
    // 类型守卫：projectId 必须是字符串（sidecar 是文件，内容可能损坏/被篡改）
    if (binding && typeof binding.projectId === 'string') {
      return binding.projectId
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 将 launch preset 绑定持久化到 sidecar `.preset.json`（设计文档 §4）。
 *
 * session create 成功后调用，记录该 session 启动时使用的 preset id。与 `.meta.json`
 * （终态语义）分离：preset 是 launch 配置（create 时写），session_end 是终态（结束时写），
 * 生命周期不同故独立文件，避免互相覆盖。
 *
 * [规则 #6] session JSONL 文件不存在时**绝不创建 sidecar**（与 persistSessionEnd 一致）：
 * pi 延迟写入窗口内 existsSync=false → 静默跳过（ES-RL-1）。active session 即使磁盘无文件
 * 也经 SessionScanner.listAll 合并内存 Map 显示，preset 绑定丢失仅影响 fork/restore 的
 * preset 继承，不阻断主流程。
 *
 * @param filePath session JSONL 绝对路径（sidecar = presetSidecarPath(filePath)）
 * @param presetId launch preset id（如 'builtin:full'）
 */
export function persistPresetBinding(filePath: string, presetId: string): void {
  if (!filePath) return
  if (!existsSync(filePath)) {
    // 文件不存在（pi 延迟写入窗口 / 首 turn 前崩溃）：绝不创建文件，直接跳过（ES-RL-1）。
    return
  }
  const binding = { presetId, version: 1 as const }
  try {
    // 原子写（tmpfile + rename）：与 persistSessionEnd 一致，防止并发读读到半写的 sidecar。
    // S-RT-3：路径经 presetSidecarPath helper 统一拼接。
    atomicWrite(presetSidecarPath(filePath), JSON.stringify(binding), `preset-${Date.now()}`)
    // sidecar 写入后主动失效 sessionMetaCache（与 persistSessionEnd L108 一致）：
    // 缓存键只含 JSONL 的 (mtimeMs, size)，sidecar 变更不变 JSONL stat → 命中缓存返回旧值。
    sessionMetaCache.delete(filePath)
  // eslint-disable-next-line taste/no-silent-catch -- file write: failure must not crash caller
  } catch (e) {
    console.error(`[session-file-utils] persistPresetBinding failed: ${filePath}`, e)
  }
}

/**
 * 从 `.preset.json` sidecar 读取 launch preset 绑定（设计文档 §4）。
 *
 * scanSessionMeta 第四读：与 name/outcome/handedOffTo 同批次提取，结果合并进
 * ScannedSessionMeta.launchPresetId，享受 sessionMetaCache 缓存（禁止在 scannedToSummary
 * 独立读文件，session-scanner.ts:67-69 注释）。
 *
 * @returns presetId 字符串；sidecar 不存在/损坏/presetId 非字符串 → undefined
 */
export function readPresetBinding(filePath: string): string | undefined {
  // S-RT-3：路径经 presetSidecarPath helper 统一拼接。
  const sidecarPath = presetSidecarPath(filePath)
  try {
    const raw = readFileSync(sidecarPath, 'utf-8')
    const binding = JSON.parse(raw)
    // 类型守卫：presetId 必须是字符串（sidecar 是文件，内容可能损坏/被篡改）
    if (binding && typeof binding.presetId === 'string') {
      return binding.presetId
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 从 .jsonl 文件提取最后一条 session_end 的 outcome（W4，ADR 0042）。
 *
 * W2 尾读优化：先尾读找尾部最后一条 session_end。persistSessionEnd 是 session 结束时
 * 最后写入的 entry → session_end 始终在文件最尾部 → 尾读几乎必中。
 * 未命中（理论可能：session_end 后又有别的 runtime 写入）→ fallback 全量读兜底。
 *
 * @returns 终态 outcome；文件无 session_end entry（历史 session / 未结束）返回 null
 */
export function extractSessionOutcome(filePath: string): SessionOutcome | null {
  // 优先读 sidecar（W1 sidecar 元数据方案）
  const sidecarPath = filePath + '.meta.json'
  try {
    const raw = readFileSync(sidecarPath, 'utf-8')
    const meta = JSON.parse(raw)
    if (meta && typeof meta.outcome === 'string') {
      // W-Runtime4：校验 outcome 值合法性——sidecar 是文件，内容可能损坏/被篡改，
      // 不校验直接断言会把无效值（如 typo、旧版残留）当合法终态返回，污染 session 状态。
      if (VALID_SESSION_OUTCOMES.includes(meta.outcome as SessionOutcome)) {
        return meta.outcome as SessionOutcome
      }
      // outcome 非法：sidecar 损坏/篡改，与 sidecar 不存在等价 → fallthrough 到 JSONL 兜底。
      // （原来此处直接 return null，会丢失 JSONL 中可能存在的合法 session_end 终态。）
    }
  } catch { void 0 /* no sidecar or invalid → fallback to JSONL */ }

  // fallback: 从 JSONL 读（历史 session / 无 sidecar / sidecar outcome 非法时的兼容路径）
  // findLastEntryField 的 predicate 只校验了 typeof，未校验值合法性——
  // JSONL 历史数据可能含未知 outcome 字符串（旧版本/手写），同样需校验。
  return findLastEntryField(filePath,
    (e) => e.type === 'session_end' && typeof e.outcome === 'string'
      && VALID_SESSION_OUTCOMES.includes(e.outcome as SessionOutcome),
    (e) => e.outcome as SessionOutcome,
  )
}

/**
 * 尾读 + fallback 全量读，倒序找最后一条匹配 entry 的字段值（W2 共用骨架）。
 *
 * 1. readTailEntries 尾读尾部块（offset=max(0,size-32KB)）
 * 2. 倒序找匹配 predicate 的 entry，命中返回 extract(entry)
 * 3. 尾读未命中（INVAR-tail-2 SR1）→ fallback 全量 readFileSync + parseJsonl 倒序找
 * 4. 全量也无 → 返回 null
 *
 * 错误对等（INVAR-tail-7）：ENOENT/EACCES/JSON parse 错误与原实现一致返回 null，不引入新 throw。
 */
function findLastEntryField<R>(
  filePath: string,
  predicate: (e: Record<string, unknown>) => boolean,
  extract: (e: Record<string, unknown>) => R,
): R | null {
  // 尾读阶段
  const tailEntries = readTailEntries(filePath)
  if (tailEntries !== null) {
    for (let i = tailEntries.length - 1; i >= 0; i--) {
      const entry = tailEntries[i]
      if (typeof entry === 'object' && entry !== null && predicate(entry as Record<string, unknown>)) {
        return extract(entry as Record<string, unknown>)
      }
    }
  }
  // fallback 全量读（INVAR-tail-2: 尾读未命中，目标可能在文件头部）
  try {
    const content = readFileSync(filePath, 'utf-8')
    const entries = parseJsonl(content)
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (typeof entry === 'object' && entry !== null && predicate(entry as Record<string, unknown>)) {
        return extract(entry as Record<string, unknown>)
      }
    }
  } catch {
    return null
  }
  return null
}

// ── 文件操作 ─────────────────────────────────────────────────

// [HISTORICAL] ensureSessionFile 已删除（2026-07-04）。
// 原实现用 openSync(wx) 提前创建 session 文件（含 session+session_info 两行），
// 理由是「pi 延迟写入期间 scanPiSessions 找不到该 session」。但这与 pi 0.80.3
// SessionManager._persist 的 openSync("wx") 冲突 → EEXIST → pi 抛 error → session 卡死。
// 现在依赖 SessionScanner.listAll 合并内存 active session（this.sessions Map），
// 即使磁盘无文件也显示；重启后内存清空，未 flush 的空 session 丢失是合理行为。

// [HISTORICAL] persistSessionName 已删除（W11，数据源治理——绝对写规则全线生效）。
// 原实现 openSync('a') 向 session JSONL 直写 session_info entry（W1 前活跃 + 非活跃
// rename 共用；W1 起仅剩非活跃分支调用）。W11 后 rename 全路径经 pi：活跃分支走既有
// pi 进程 set_session_name RPC，非活跃分支经 process-manager.withEphemeralPi 短命
// 附着同一 RPC——session JSONL 的唯一写方是 pi（pi 对已 flush 文件的 appendSessionInfo
// 立即 appendFileSync 落盘，session-manager.ts _persist）。
// [HISTORICAL] 规则 #6 历史包袱：更早的实现（ensureSessionFile 同期）用 openSync(wx)
// 提前建文件，与 pi _persist 的 openSync("wx") 冲突 → EEXIST → session 永久卡死，
// 后改为「文件不存在时跳过」守卫——该守卫语义已由 sidecar 家族
// （persistSessionEnd/persistPresetBinding/persistProjectBinding/persistHandoffSidecar）继承。

/**
 * 将 handoff 标记持久化到 sidecar `.handoff.json`（FR-5，W11 迁移——D3b 裁决）。
 *
 * 源 session 交接给新 session 后记录交接目标 id。extractHandedOff 读回；scanner
 * scanSessionMeta 提取后填入 ScannedSessionMeta.handedOffTo，供前端识别「该 session
 * 已交接，可在 UI 标记/跳转新 session」。
 *
 * [W11 迁移] 原实现 openSync('a') 向 session JSONL 直写 `handoff_marker` entry——
 * 活跃交接时源 pi 进程在场，xyz 与 pi 是同文件双写方（违反绝对写规则）。迁 sidecar
 * 后 handedOffTo 是 xyz 自有语义（pi 无 handoff 概念），与 `.meta.json` 家族同构。
 *
 * [规则 #6] JSONL 文件不存在时**绝不创建 sidecar**（与 persistSessionEnd 同守卫）：
 * pi 延迟写入窗口内 existsSync=false → console.warn + 静默跳过。
 * 写后失效 sessionMetaCache（缓存键只含 JSONL 的 mtime/size，sidecar 变更不变 JSONL
 * stat → 不失效会命中缓存返回旧 handedOffTo）。
 *
 * @param filePath 源 session JSONL 绝对路径（sidecar = filePath + '.handoff.json'）
 * @param newSessionId 交接目标的新 session id
 */
export function persistHandoffSidecar(filePath: string, newSessionId: string): void {
  if (!filePath) return
  if (!existsSync(filePath)) {
    console.warn(`[session-file-utils] persistHandoffSidecar: file does not exist, skipping (pi delayed write window): ${filePath}`)
    return
  }
  const marker = { type: 'handoff_marker', handedOffTo: newSessionId, version: 1 as const, timestamp: new Date().toISOString() }
  try {
    // 原子写（tmpfile + rename）：与 persistSessionEnd 一致，防止并发读读到半写的 sidecar。
    atomicWrite(filePath + '.handoff.json', JSON.stringify(marker), `handoff-${Date.now()}`)
    // sidecar 写入后主动失效 sessionMetaCache（对齐 persistSessionEnd：缓存键只含
    // JSONL 的 (mtimeMs, size)，sidecar 变更不变 JSONL stat → 命中缓存返回旧值）。
    sessionMetaCache.delete(filePath)
  // eslint-disable-next-line taste/no-silent-catch -- file write: failure must not crash caller
  } catch (e) {
    console.error(`[session-file-utils] persistHandoffSidecar failed: ${filePath}`, e)
  }
}

/**
 * 从 session 提取交接目标 id（FR-5，W11 起优先读 sidecar）。
 *
 * 1. 优先读 sidecar `.handoff.json`（W11 后的权威写点）。
 * 2. sidecar 未命中 → fallback 仅尾读旧 JSONL `handoff_marker` entry（存量 session
 *    兼容——W11 前写入的 marker 永在文件尾部窗口 32KB 内；handoff 是一次性标记，
 *    写入后无后继写方把它推出尾窗）。
 *
 * [NOTE 不复用 findLastEntryField] fallback 刻意保持「仅尾读」——findLastEntryField
 * 尾读未命中会 fallback 全量读（readFileSync + parseJsonl），那会打破 scanSessionMeta
 * 的三读合一预算（W3 AC-merge-1）。旧 marker 总在文件最尾部，尾读必中。返回类型
 * `undefined`（非 null）匹配 ScannedSessionMeta.handedOffTo 的可选字段语义。
 *
 * @returns 交接目标的新 session id；无标记（未交接）返回 undefined
 */
export function extractHandedOff(filePath: string): string | undefined {
  // 优先读 sidecar（W11 后权威写点；对齐 extractSessionOutcome 的 sidecar-first 结构）
  try {
    const raw = readFileSync(filePath + '.handoff.json', 'utf-8')
    const marker = JSON.parse(raw)
    // 类型守卫：handedOffTo 必须是字符串（sidecar 是文件，内容可能损坏/被篡改）
    if (marker && typeof marker.handedOffTo === 'string') {
      return marker.handedOffTo
    }
    // handedOffTo 非字符串：sidecar 损坏，与 sidecar 不存在等价 → fallthrough 尾读兜底。
  } catch { void 0 /* no sidecar or invalid → fallback to legacy JSONL marker */ }

  // fallback：存量旧 session 的 JSONL `handoff_marker` 尾读（W11 前写入的兼容路径）
  const tailEntries = readTailEntries(filePath)
  if (tailEntries !== null) {
    for (let i = tailEntries.length - 1; i >= 0; i--) {
      const entry = tailEntries[i]
      if (typeof entry === 'object' && entry !== null
        && (entry as Record<string, unknown>).type === 'handoff_marker'
        && typeof (entry as Record<string, unknown>).handedOffTo === 'string') {
        return (entry as Record<string, unknown>).handedOffTo as string
      }
    }
  }
  return undefined
}

// [HISTORICAL] patchSessionCwd 已删除（W11，数据源治理——绝对写规则全线生效）。
// 原实现读源 JSONL → 改首行 session header 的 cwd 字段 → atomicWrite 整文件重写源文件
// （restoreSession 在 pi spawn 前调用：session cwd 已被删除时降级 homedir，防 pi
// switch_session 因 cwd 不存在失败）。W11 后 cwd fallback 改在 tmp 拷贝上应用；
// W1（restore-fork-attach-fix）tmp 管线整体删除，fallback 并入 F3 归一化管线：
// stripSessionEndEntries + applyHeaderCwdFallback 的变换产物经下方
// normalizeSessionFileInPlace 原地 rename-over 落回原文件（header cwd 降级值持久化
// 在原文件内；「header 永久保持旧 cwd」的旧声明已被取代，登记表 §4 例外③已更新）。

/**
 * restore-time 会话文件原地归一化（restore-fork-attach-fix W1 F3，登记表 §4 ⑨ 合法形态）。
 *
 * 用途：legacy 会话文件（含 session_end 行 / header cwd 死路径）restore 时的一次性
 * 变换落盘。调用方（restoreSession）已完成纯字符串变换（stripSessionEndEntries /
 * applyHeaderCwdFallback），本 helper 负责把变换产物写同目录临时名
 * `<原名>.tmp-migrate-<时间戳>.jsonl` → `renameSync` 原子覆盖原文件。
 *
 * 为什么必须原地 rename-over 而非写新文件：pi 的 switch_session 永久重绑读写目标
 * （pi-mono session-manager.ts setSessionFile 把传入路径存为永久 sessionFile，_persist
 * 每轮 appendFileSync 该路径），附着目标必须是原路径本身；且路径不变使按路径关联的
 * sidecar 四后缀派生 / fork 血缘 parentSession 指针 / scanner 关联全部无需迁移。
 *
 * 合法边界（登记表 §4 ⑨）：仅 inactive 文件（restoreSession 开头已销毁同 id 会话）；
 * 变换白名单 = strip session_end / header cwd fallback；每文件最多一次（归一化产物
 * 无 session_end 且 cwd 已修活 → 下次 restore 走 F2 直附着零改写，幂等收敛）。
 * 同目录 rename 是 POSIX 原子操作，无中间态可见；rename 前崩溃残留的
 * `.tmp-migrate-*.jsonl` 由 scanPiSessionsFromDisk 按文件名显式排除
 * （isScannableSessionFile——scanner 按内容识别 session 不按文件名，不过滤会产生
 * 同 sessionId 双条目，见该函数注释）；残留清理由三处机制承接（见
 * cleanupMigrateResidues）：rename 失败本函数回滚删除 + 附着前清扫 + delete 链清扫。
 *
 * @param filePath    原 session JSONL 绝对路径（内容被原子覆盖，路径不变）
 * @param transformed 变换后的完整 JSONL 文本
 */
export function normalizeSessionFileInPlace(filePath: string, transformed: string): void {
  // 临时名形态 = basename + '.tmp-migrate-' + 时间戳 + '.jsonl'（登记表 §4 ⑨；
  // R1 检查的豁免锚点 = '.tmp-migrate-' 字面量后缀，经写目标单跳赋值链回溯判定）
  const tmpPath = join(dirname(filePath), basename(filePath) + '.tmp-migrate-' + Date.now() + '.jsonl')
  writeFileSync(tmpPath, transformed, 'utf-8')
  try {
    renameSync(tmpPath, filePath)
  } catch (e) {
    // rename 失败回滚（差距复审 suggestion 6）：删除刚写的临时文件不留孤儿——原文件
    // 未被触碰仍完整，重试归一化即可；回滚删除自身失败（极端：目录权限突变）时仅
    // 残留一个被 scanner 排除的孤儿，附着前清扫 / delete 链清扫兜底。
    try { unlinkSync(tmpPath) } catch { void 0 }
    throw e
  }
}

/**
 * 清扫该 session 文件的 `.tmp-migrate-*.jsonl` 残留（差距复审 suggestion 6）。
 *
 * 残留来源 = normalizeSessionFileInPlace 在 writeFileSync 与 renameSync 之间崩溃
 * （或回滚删除失败的极端场景）。残留不被 scanner 收录（isScannableSessionFile 排除，
 * 不会错位附着），但属永久磁盘垃圾，本函数在两个自然时机将其回收：
 * ① 附着前（normalizeInactiveSessionFileIfNeeded 顶部，restore / 非活跃 rename 共用）
 * ——此刻本会话无归一化在途（restore 已销毁同 id 会话），同 basename 的残留必然 stale；
 * ② delete 链（与 sidecar 四后缀清理同点）——session 已删，残留随之清走。
 *
 * best-effort：目录列举失败 / 单个删除失败静默跳过（不阻塞附着/删除主流程）；
 * 只删「basename 前缀精确匹配 + .jsonl 后缀」的文件，不碰其他 session 的文件。
 */
export function cleanupMigrateResidues(filePath: string): void {
  const dir = dirname(filePath)
  const prefix = basename(filePath) + '.tmp-migrate-'
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith('.jsonl')) {
      try { unlinkSync(join(dir, name)) } catch { void 0 }
    }
  }
}

// ── Session 扫描 ─────────────────────────────────────────────

/** scanPiSessions 返回的单条 session 元信息（持久化会话扫描结果）。 */
export interface ScannedSessionMeta {
  id: string
  filePath: string
  cwd: string
  timestamp: string
  name: string | null
  /** W3 三读合一：outcome 随 meta 一起提取，scannedToSummary 直接取不再独立读文件（消除第 3 次全量读）。 */
  outcome: SessionOutcome | null
  lastModified: number
  size: number
  /** 父 session 血缘键（FR-3，从 header 提取）。 */
  parentSession?: string
  /** fork 锚点 entry id（FR-3，从 header 提取）。 */
  forkEntryId?: string
  /** handoff 目标 session id（FR-5，从 JSONL handoff_marker 尾读）。 */
  handedOffTo?: string
  /**
   * 该 session 启动时绑定的 launch preset id（从 .preset.json sidecar 读，设计文档 §4）。
   * undefined 表示无 sidecar（历史 session / create 时未绑定 preset）。
   */
  launchPresetId?: string
  /**
   * 归属 project id（从 .project.json sidecar 读，D14 语义修正 2026-08-04）。
   * undefined = 未归类（展示层归入默认项目 proj-default 兑底）。
   */
  projectId?: string
}

/**
 * W3 文件级 mtime+size 缓存（INVAR-cache-1 模块级跨两阶段共享）。
 *
 * scanPiSessions（header+name+outcome 三读合一）与 scannedToSummary（取 outcome）共享此缓存。
 * 缓存键含 (path, mtimeMs, size)（INVAR-cache-2 SR4）——同 ms 内并发 append mtimeMs 不变但
 * size 变 → miss，消除竞态。无上限（INVAR-cache-6，每条~几百字节，10k session≈数 MB）。
 * 不跨进程（runtime 重启清空，首次 scan 冷读）。
 *
 * [KNOWN-LIMIT 无界增长] 缓存以 filePath 为键，删除 session 不会主动清条目（deleteSession
 * 走 trash 不回调此模块）。长时间运行的 runtime + 频繁创建/删除 session 时条目累积，
 * 但单条 ~几百字节、且 filePath 含 sessionId 不会重复，实测量级可控（数千条 ≈ 1MB）。
 * 若未来 session 生命周期变长/创建频繁导致内存压力，可在此加 LRU 上限或定期 sweep
 * （按 lastModified 淘汰 stale 条目）。当前 runtime 进程为 session 级常驻，生命周期内
 * session 总数有限，暂不引入淘汰逻辑。
 */
interface CachedSessionMeta {
  mtimeMs: number
  size: number
  meta: ScannedSessionMeta
}
const sessionMetaCache = new Map<string, CachedSessionMeta>()

/** 仅供测试重置缓存用（生产不调）。 */
export function _resetSessionMetaCacheForTest(): void {
  sessionMetaCache.clear()
}

/** 删除 session 时调用，清理 sessionMetaCache 中的 stale 条目（避免无界增长）。 */
export function invalidateSessionMetaCache(filePath: string): void {
  sessionMetaCache.delete(filePath)
}

/**
 * 单个 session 文件的元数据提取（三读合一 + 缓存）。
 *
 * 1. statSync 拿 mtimeMs + size，查缓存 (path, mtimeMs, size)
 * 2. 命中（INVAR-cache-3）→ 返回缓存 meta（零文件读取）
 * 3. miss → parseSessionHeader + extractSessionName + extractSessionOutcome 一次提取全部 → 写缓存
 *
 * 三读合一（FR-three-read-merge）：原 scanPiSessions 调 parseSessionHeader（全量读首行）
 * + extractSessionName（尾读），scannedToSummary 再调 extractSessionOutcome（第 3 次全量读）。
 * 现统一在此一次提取，scannedToSummary 从 meta.outcome 取（INVAR-merge-2）。
 *
 * 文件删除/不可读（INVAR-cache-4）→ 清该 key 返回 null。
 */
function scanSessionMeta(filePath: string): ScannedSessionMeta | null {
  let fstat
  try {
    fstat = statSync(filePath)
  } catch {
    // 文件不存在/不可读：清 stale 缓存条目（INVAR-cache-4），返回 null
    sessionMetaCache.delete(filePath)
    return null
  }

  const cached = sessionMetaCache.get(filePath)
  // INVAR-cache-2: 键含 (mtimeMs, size)，任一变 → miss
  if (cached && cached.mtimeMs === fstat.mtimeMs && cached.size === fstat.size) {
    return cached.meta // INVAR-cache-3: 命中，逐字节一致
  }

  // miss：三读合一提取全部元数据
  const header = parseSessionHeader(filePath)
  if (!header) {
    // 非 session 文件（首行不是 session header）：不缓存（下次仍尝试，开销小）
    return null
  }
  const name = extractSessionName(filePath)
  const outcome = extractSessionOutcome(filePath)
  const handedOffTo = extractHandedOff(filePath)
  // 第四读：preset binding sidecar（设计文档 §4），与 name/outcome/handedOffTo 同批次
  // 提取，结果合并进 meta.launchPresetId，享受 sessionMetaCache 缓存。
  const launchPresetId = readPresetBinding(filePath)
  // 第五读：project binding sidecar（D14 语义修正），同批次提取进 meta.projectId。
  const projectId = readProjectBinding(filePath)
  const meta: ScannedSessionMeta = {
    id: header.id,
    filePath,
    cwd: header.cwd,
    timestamp: header.timestamp,
    name,
    outcome,
    lastModified: fstat.mtimeMs,
    size: fstat.size,
    parentSession: header.parentSession,
    forkEntryId: header.forkEntryId,
    handedOffTo,
    launchPresetId,
    projectId,
  }
  sessionMetaCache.set(filePath, { mtimeMs: fstat.mtimeMs, size: fstat.size, meta })
  return meta
}

/**
 * wave:perf-w26（D9-1）：sessions 目录列举层 TTL 缓存有效期（1s）。
 *
 * 列表构建消费方（SessionScanner.listAll → listPersistedSessions，侧栏列表）在 TTL 窗口内
 * 直接命中缓存快照（零 readdirSync/statSync）。1s 保证 pi 落盘新 session 文件后秒级出现在
 * 列表（pi 延迟写入：首个 assistant 前不落盘，列表本就无法更早发现，TTL 过期即重扫）。
 *
 * 正确性敏感的**单 session 路径解析消费方**（getHistoryFromFile / getFullHistory /
 * getSubagents / getWorkflows / findScannedSession 等）必须传 force 旁路——pi 是外部进程
 * 写文件，不在显式失效覆盖内，若走 TTL 缓存，刚落盘 session 的查找会在窗口内静默返回
 * 空（05-scan-caching D9-1 审查修正，plan M-3）。
 */
const SCAN_DIR_TTL_MS = 1000

/** 目录列举缓存条目。dir 不匹配（XYZ_AGENT_DATA_DIR 切换 / 测试隔离）即整体失效。 */
interface ScanDirCacheEntry {
  dir: string
  entries: ScannedSessionMeta[]
  expiresAt: number
}
let scanDirCache: ScanDirCacheEntry | null = null
/**
 * 上次 scanPiSessions 观测的 Date.now()（时钟回拨检测，终审 suggestion）。
 * now < lastNow = 系统时钟后跳（NTP 校时 / 手动改时）→ TTL 判定基于的墙钟不可信，
 * 缓存视为过期强制重扫，否则 now < expiresAt 在回拨窗口内恒真（列表视图冻结）。
 */
let scanDirLastNow = 0

/** scanPiSessions 的分层选项（wave:perf-w26 D9-1 消费方分层）。 */
export interface ScanSessionsOptions {
  /**
   * 单 session 路径解析消费方传 true：绕过目录 TTL 缓存强制刷新（正确性优先，
   * 刚落盘 session 在 TTL 窗口内也必须解析到）。
   */
  force?: boolean
}

/**
 * 显式失效目录列举 TTL 缓存（wave:perf-w26 D9-1）。
 *
 * session delete / fork / rename（runtime 自写文件的操作）后调用——这些写不经 pi 延迟
 * 落盘，显式失效让下一次列表构建立即可见。create 走 pi 延迟落盘，靠 TTL 自然过期，
 * 不调此函数。亦供测试重置（测试间目录隔离）。
 */
export function invalidateScanDirCache(): void {
  scanDirCache = null
  // 回拨检测基准一并重置：缓存条目与观测基准同生命周期重建（测试间/显式失效后无跨窗口泄漏）
  scanDirLastNow = 0
}

/**
 * 扫描 pi 的 sessions 目录（按 cwd 分组的子目录结构）。
 * 返回扁平化的 session 列表。
 *
 * W3：scanSessionMeta 三读合一 + 缓存。每文件 miss 时 1 次提取 header+name+outcome，
 * hit 时零读取（仅 statSync）。
 *
 * wave:perf-w26（D9-1）：目录列举层 1s TTL 缓存——默认（列表构建消费方）窗口内返回
 * 缓存快照；opts.force=true（路径解析消费方）绕过缓存强制刷新。
 */
export function scanPiSessions(opts?: ScanSessionsOptions): ScannedSessionMeta[] {
  const dir = getSessionsDir()
  const now = Date.now()
  // 时钟回拨防护（终审 suggestion）：now 落到上次观测之前 → 墙钟被回拨，expiresAt 的
  // 单调性假设失效 → 缓存不可信，强制重扫并以回拨后的时钟重建基准（几行代码的轻量防护）
  const clockWentBackwards = now < scanDirLastNow
  scanDirLastNow = now
  if (!opts?.force && !clockWentBackwards && scanDirCache && scanDirCache.dir === dir && now < scanDirCache.expiresAt) {
    // 浅拷贝数组：消费者可安全 sort/splice，不污染缓存本体（meta 元素引用与
    // sessionMetaCache 共享，现状已是只读契约）。
    return [...scanDirCache.entries]
  }
  const results = scanPiSessionsFromDisk(dir)
  // force 刷新同样写缓存：随后 1s 内的列表构建消费方零 IO 读到最新视图。
  scanDirCache = { dir, entries: results, expiresAt: now + SCAN_DIR_TTL_MS }
  return [...results]
}

/**
 * 判断目录项文件名是否为 scan 应收录的 session JSONL。
 *
 * 除 `.jsonl` 后缀外，显式排除 `.tmp-migrate-` 命名（W1 F1 修复）：restore-time 归一化
 * （normalizeSessionFileInPlace）在写临时名与 rename 之间崩溃时会残留
 * `<原名>.tmp-migrate-<ts>.jsonl` 于 sessions 目录。scanner 按内容（首行 session header）
 * 识别 session、不按文件名——残留文件内容是合法 session（同 sessionId），不过滤会产生
 * 同 id 双条目，且残留 mtime 更新、排序在前，findScannedSession 会命中残留路径 →
 * restore 附着错位文件。文件名过滤把「残留无害」从声明变成机制保证。
 */
function isScannableSessionFile(name: string): boolean {
  return name.endsWith('.jsonl') && !name.includes('.tmp-migrate-')
}

function scanPiSessionsFromDisk(sessionsDir: string): ScannedSessionMeta[] {
  if (!existsSync(sessionsDir)) return []

  const results: ScannedSessionMeta[] = []

  let entries: string[]
  try {
    entries = readdirSync(sessionsDir)
  } catch (e) {
    // L8: sessions 目录存在但不可读（权限/IO 故障）时，readdirSync 抛 EACCES 等异常。
    // 原实现未保护会冒泡为进程级未捕获异常，此处降级为返回空数组（scan 容忍失败）。
    console.error(`[session-file-utils] scanPiSessions: failed to read sessions dir: ${sessionsDir}`, e)
    return []
  }

  for (const entry of entries) {
    const entryPath = join(sessionsDir, entry)
    let stat
    try {
      stat = statSync(entryPath)
    } catch {
      continue
    }

    if (stat.isDirectory()) {
      try {
        // 文件名过滤（isScannableSessionFile）：排除 .tmp-migrate- 归一化崩溃残留
        const files = readdirSync(entryPath).filter(isScannableSessionFile)
        for (const file of files) {
          const filePath = join(entryPath, file)
          try {
            const meta = scanSessionMeta(filePath)
            if (meta) results.push(meta)
          // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable session entries
          } catch {
            // skip
          }
        }
      // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable session subdirectory
      } catch {
        // skip unreadable dir
      }
    } else if (isScannableSessionFile(entry)) {
      try {
        const meta = scanSessionMeta(entryPath)
        if (meta) results.push(meta)
      // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable session entry
      } catch {
        // skip
      }
    }
  }

  results.sort((a, b) => b.lastModified - a.lastModified)
  return results
}
