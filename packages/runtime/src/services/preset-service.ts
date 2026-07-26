/**
 * PresetService — Pi 启动参数预设的存储 + CRUD 服务。
 *
 * 设计文档：docs/design/pi-launch-presets.md（§1.4 存储 / §3.4 builtin 可编辑边界 / §8.1 API）。
 *
 * 与 ConfigService 对称（独立 service，非 SessionService 内部字段）：
 *   - 构造函数注入 IConfigStore（推导 pi-presets.json 路径）+ IExtensionService（resolve 用，本 wave 不调用）
 *   - 文件 IO 范式参考 config-service.ts L216-248（load 容错 / save atomicWrite + uniqueTmpSuffix）
 *
 * 本 wave 只实现存储 + CRUD（getAllPresets/getPreset/savePreset/deletePreset/defaultPresetId）。
 * resolve(preset, cwd) 留给 wave2（依赖 ExtensionService.getBuiltinExtensionPaths 提取）。
 *
 * 组合根（packages/runtime/src/index.ts）构造，SessionService 加 setPresetService setter
 * （参考 setConfigService session-service.ts L187-189）。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BUILTIN_PRESET_IDS,
  DEFAULT_PRESETS,
  type PiLaunchPreset,
  type PiPresetsFile,
} from '@xyz-agent/shared'
import type { IConfigStore } from './ports/config.js'
import type { IExtensionService } from '../interfaces.js'
import { atomicWrite } from '../utils/fs-utils.js'

/** JSON 序列化缩进（与 config-service.ts 共用约定）。 */
const JSON_INDENT = 2

/**
 * 生成 atomicWrite 的唯一 tmp 后缀（时间戳 + 随机串），避免并发写入撞固定 .tmp 文件。
 * 复刻 config-service.ts L68-71 模式。
 */
function uniqueTmpSuffix(): string {
  // eslint-disable-next-line no-magic-numbers -- base36 radix + slice 掉 "0." 前缀
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`
}

/**
 * 内置预设保护错误。
 *
 * 触发场景（设计文档 §3.4）：
 *   - savePreset 传入 builtin id 但 builtin:false（试图降级逃逸保护）
 *   - deletePreset 内置 preset（builtin 不可删）
 */
export class PresetGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PresetGuardError'
  }
}

/**
 * resolve(preset, cwd) 的返回形状（设计文档 §8.1）。
 *
 * 本 wave 只声明类型（供 wave2 实现 + wave3 session-lifecycle 消费），不实现 resolve。
 */
export interface PresetResolution {
  /** builtin 永远前置 + extensionMode 过滤的用户 extension 路径（设计 §2.3/§2.4） */
  extensionPaths: string[]
  /** noSkills=true 时空数组，否则现有 getSkillPaths(cwd) 结果（设计 §2.2） */
  skillPaths: string[]
  /** 工具相关 args（all/allowlist/denylist/none 四模式，设计 §2.5） */
  toolArgs: { tools?: string[]; excludeTools?: string[]; noTools?: boolean }
  /** 其他 args（noSkills 映射 --no-skills，noContextFiles 映射 --no-context-files） */
  flags: { noSkills: boolean; noContextFiles: boolean }
  /** 覆盖模型（受 Landing Chip 覆盖，设计 §5.2） */
  modelOverride?: string
  /** 覆盖思考级别（受 Landing Chip 覆盖，设计 §5.2） */
  thinkingLevel?: string
}

/**
 * PresetService — Pi 启动参数预设的存储 + CRUD + resolve 服务。
 *
 * 设计文档 §8.1 API。本 wave 实现 CRUD，resolve 留给 wave2。
 */
export class PresetService {
  constructor(
    private readonly configStore: IConfigStore,
    // extensionService 本 wave 不用，但 wave2 的 resolve 依赖它（getBuiltinExtensionPaths/scanExtensions）。
    // 提前对齐双参构造，避免 wave2 改构造签名 → 破坏 wave3 组合根 + 所有测试构造点。
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 见上注释（wave2 启用）
    private readonly extensionService: IExtensionService,
  ) {}

  // ── 文件 IO（参考 config-service.ts L216-248 范式）──

  /**
   * pi-presets.json 路径：getDataDir 根（与 config.json/system-prompt.json 同级）。
   * 用 configStore.getConfigDir() port 动态推导（设计文档 §1.4 + 架构约定 #2 禁硬编码）。
   */
  private piPresetsPath(): string {
    return join(this.configStore.getConfigDir(), 'pi-presets.json')
  }

  /**
   * 加载 pi-presets.json（容错）。
   *
   * 容错策略（与 config-service.loadAppConfig L216-232 对齐）：
   *   - 文件不存在 → 空骨架兜底（presets: []）
   *   - JSON 畸形 → 空骨架兜底 + console.warn（不抛错）
   *   - 顶层非对象/presets 非数组 → 空骨架兜底 + console.warn
   */
  private loadPresetsFile(): PiPresetsFile {
    const path = this.piPresetsPath()
    if (!existsSync(path)) {
      return { presets: [], version: 1 }
    }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8'))
    } catch (e) {
      console.warn(`[preset-service] pi-presets.json is not valid JSON, ignoring: ${String(e)}`)
      return { presets: [], version: 1 }
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      console.warn('[preset-service] pi-presets.json top-level is not an object, ignoring')
      return { presets: [], version: 1 }
    }
    const obj = raw as Record<string, unknown>
    const presets = Array.isArray(obj['presets']) ? obj['presets'] as unknown[] : []
    // 逐项类型守卫：只接受形似 PiLaunchPreset 的对象，丢弃畸形项（防御性，不抛错）。
    const validPresets: PiLaunchPreset[] = []
    for (const p of presets) {
      const typed = coercePreset(p)
      if (typed) validPresets.push(typed)
    }
    const defaultPresetId = typeof obj['defaultPresetId'] === 'string' ? obj['defaultPresetId'] as string : undefined
    return {
      presets: validPresets,
      defaultPresetId,
      version: 1,
    }
  }

  /**
   * 保存 pi-presets.json（atomicWrite + 唯一 tmp 后缀，与 config-service.saveAppConfig 同模式）。
   */
  private savePresetsFile(file: PiPresetsFile): void {
    const cd = this.configStore.getConfigDir()
    if (!existsSync(cd)) mkdirSync(cd, { recursive: true })
    atomicWrite(
      this.piPresetsPath(),
      JSON.stringify(file, null, JSON_INDENT),
      uniqueTmpSuffix(),
    )
  }

  // ── 合并逻辑（参考 mergeSystemPromptConfig L573-596 字段级合并范式）──

  /**
   * 合并 DEFAULT_PRESETS 与 user presets（设计文档 §1.4）。
   *
   * 合并规则：
   *   - 以 DEFAULT_PRESETS 为基底
   *   - user presets 中 builtin:true 项按 id 命中 DEFAULT → 字段级合并（user 字段覆盖，缺失字段从 DEFAULT 兜底）
   *   - user presets 中 builtin:false 项追加（自定义预设）
   *   - 按 (order, id) 复合键升序排序（保证全序确定，规避 sort 稳定性依赖）
   *
   * 保护判定：用「id 命中 DEFAULT_PRESETS.id 集合」而非前缀匹配（防用户自定义 'builtin:foo' 误判，r2）。
   */
  private mergePresets(userPresets: PiLaunchPreset[]): PiLaunchPreset[] {
    const defaultById = new Map<string, PiLaunchPreset>(DEFAULT_PRESETS.map(p => [p.id, p]))
    const result: PiLaunchPreset[] = []

    // 1. 合并 DEFAULT（user 中命中 id 的覆盖字段，否则用 DEFAULT 原值）
    for (const def of DEFAULT_PRESETS) {
      const userOverride = userPresets.find(p => p.id === def.id && p.builtin === true)
      if (userOverride) {
        result.push({ ...def, ...userOverride, id: def.id, builtin: true, order: def.order })
      } else {
        result.push({ ...def })
      }
    }

    // 2. 追加 user 自定义（builtin:false，且 id 不与 DEFAULT 冲突）
    for (const u of userPresets) {
      if (defaultById.has(u.id)) continue // 已在 step1 处理（含 builtin:false 的同 id 项也跳过，防 id 冲突）
      if (u.builtin === true) continue // 非 DEFAULT id 的 builtin:true 是脏数据，忽略
      result.push({ ...u })
    }

    // 3. 排序：(order, id) 复合键，规避 sort 稳定性依赖（r1）
    return result.sort((a, b) =>
      a.order !== b.order ? a.order - b.order : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
  }

  // ── 公开 API（设计文档 §8.1）──

  /** 加载所有预设：内置默认 + 用户自定义（含对内置的覆盖合并）。 */
  getAllPresets(): PiLaunchPreset[] {
    return this.mergePresets(this.loadPresetsFile().presets)
  }

  /** 获取单个预设。找不到返回 undefined（builtin:full 总能找到，由 DEFAULT 兜底）。 */
  getPreset(presetId: string): PiLaunchPreset | undefined {
    return this.getAllPresets().find(p => p.id === presetId)
  }

  /**
   * 获取默认预设 ID（pi-presets.json 的 defaultPresetId，缺省 BUILTIN_PRESET_IDS.FULL）。
   */
  getDefaultPresetId(): string {
    return this.loadPresetsFile().defaultPresetId ?? BUILTIN_PRESET_IDS.FULL
  }

  /** 设为默认（写 defaultPresetId 字段）。 */
  setDefaultPresetId(presetId: string): void {
    const file = this.loadPresetsFile()
    file.defaultPresetId = presetId
    this.savePresetsFile(file)
  }

  /**
   * 保存预设（新增或更新）。
   *
   * 内置预设（id 命中 DEFAULT_PRESETS.id 集合）的「不可改」字段保护（设计文档 §3.4）：
   *   - 强制保留 id / builtin / order / name 四字段（用 DEFAULT 的值，忽略传入值）
   *   - 传入 builtin:false 但 id 命中 builtin → 抛 PresetGuardError（防降级逃逸保护）
   *   - 其余字段按传入值覆盖
   *
   * 自定义预设（id 不在 DEFAULT）：
   *   - 强制 builtin:false（防止用户传 builtin:true 伪造内置预设）
   */
  savePreset(preset: PiLaunchPreset): void {
    const file = this.loadPresetsFile()
    const isBuiltinId = DEFAULT_PRESETS.some(p => p.id === preset.id)

    if (isBuiltinId) {
      // 防降级逃逸：builtin id 但传入 builtin:false
      if (preset.builtin !== true) {
        throw new PresetGuardError(
          `cannot change builtin flag of builtin preset '${preset.id}' to false`,
        )
      }
      // 字段保护：id/builtin/order/name 来自 DEFAULT，忽略传入
      const def = DEFAULT_PRESETS.find(p => p.id === preset.id)!
      const protectedPreset: PiLaunchPreset = {
        ...preset,
        id: def.id,
        builtin: true,
        order: def.order,
        name: def.name,
      }
      upsertById(file.presets, protectedPreset)
    } else {
      // 新自定义：强制 builtin:false（防伪造）
      const customPreset: PiLaunchPreset = { ...preset, builtin: false }
      upsertById(file.presets, customPreset)
    }
    this.savePresetsFile(file)
  }

  /**
   * 删除预设。内置 preset 抛 PresetGuardError（设计文档 §3.4 不可删）。
   * 自定义 preset 不存在时 no-op（不抛错）。
   */
  deletePreset(presetId: string): void {
    if (DEFAULT_PRESETS.some(p => p.id === presetId)) {
      throw new PresetGuardError(`cannot delete builtin preset '${presetId}'`)
    }
    const file = this.loadPresetsFile()
    const before = file.presets.length
    file.presets = file.presets.filter(p => p.id !== presetId)
    // 无变更也允许 save（no-op 语义，保持简单）—— 仅当确实有删除时才写盘
    if (file.presets.length !== before) {
      this.savePresetsFile(file)
    }
  }

  // ── resolve（设计文档 §8.1，wave2 实现）──

  /**
   * 根据 preset + cwd 解析为 RpcClientOptions 的扩展字段。
   *
   * 设计文档 §8.1：返回值供 session-lifecycle 覆盖现有 getExtensionPaths/getSkillPaths 结果。
   * - extensionPaths：builtin 永远前置 + extensionMode 过滤的用户 extension（§2.3/§2.4）
   * - skillPaths：noSkills=true 时空数组；否则空数组（wave3 session-lifecycle 用 flags.noSkills
   *   决定是否用现有 getSkillPaths 兜底——PresetService 不跨域依赖 ConfigService，见 wave2 设计 t1）
   * - toolArgs：toolMode 4 模式映射（§2.5）
   * - flags：noSkills/noContextFiles 透传
   * - modelOverride/thinkingLevel：透传（受 Landing Chip 覆盖，§5.2 由 wave3 处理）
   */
  async resolve(preset: PiLaunchPreset, cwd: string): Promise<PresetResolution> {
    const extensionPaths = await this.resolveExtensionPaths(preset, cwd)
    return {
      extensionPaths,
      skillPaths: this.resolveSkillPaths(preset),
      toolArgs: this.resolveToolArgs(preset),
      flags: {
        noSkills: preset.noSkills ?? false,
        noContextFiles: preset.noContextFiles ?? false,
      },
      modelOverride: preset.modelOverride,
      thinkingLevel: preset.thinkingLevel,
    }
  }

  /**
   * 解析 extensionPaths（设计文档 §2.3/§2.4）。
   *
   * builtin 永远前置（不受 extensionMode 影响），用户 extension 按 mode 过滤：
   *   - all: 全部 enabled
   *   - allowlist: enabled && name in preset.allowedExtensions
   *   - denylist: enabled && name not in preset.deniedExtensions（pi 无原生 denylist → runtime 端过滤）
   *   - none: 空（builtin 仍前置）
   */
  private async resolveExtensionPaths(preset: PiLaunchPreset, cwd: string): Promise<string[]> {
    void cwd // 当前实现未用 cwd（scanExtensions 不带 cwd）；保留参数对齐设计 §8.1 签名
    const builtinPaths = this.extensionService.getBuiltinExtensionPaths()
    const userExts = await this.extensionService.scanExtensions()

    let selected: string[]
    switch (preset.extensionMode) {
      case 'all':
        selected = userExts.filter(e => e.enabled).map(e => e.path)
        break
      case 'allowlist': {
        const allowed = preset.allowedExtensions ?? []
        selected = userExts
          .filter(e => e.enabled && allowed.includes(e.name))
          .map(e => e.path)
        break
      }
      case 'denylist': {
        const denied = preset.deniedExtensions ?? []
        selected = userExts
          .filter(e => e.enabled && !denied.includes(e.name))
          .map(e => e.path)
        break
      }
      case 'none':
        selected = []
        break
    }
    return [...builtinPaths, ...selected]
  }

  /**
   * 解析 skillPaths（设计文档 §2.2）。
   *
   * noSkills=true 返 []（清空）；noSkills=false 也返 []（含义「不覆盖」，
   * wave3 session-lifecycle 看 flags.noSkills=false 时用现有 getSkillPaths 兜底）。
   */
  private resolveSkillPaths(preset: PiLaunchPreset): string[] {
    return preset.noSkills === true ? [] : []
  }

  /**
   * 解析 toolArgs（设计文档 §2.5）。
   *
   *   - all: {}（不传工具 flag，用 pi 默认）
   *   - allowlist: { tools: allowedTools }（替换语义 --tools）
   *   - denylist: { excludeTools: deniedTools }（叠加语义 --exclude-tools）
   *   - none: { noTools: true }（--no-tools）
   */
  private resolveToolArgs(preset: PiLaunchPreset): PresetResolution['toolArgs'] {
    switch (preset.toolMode) {
      case 'all':
        return {}
      case 'allowlist':
        return { tools: preset.allowedTools ?? [] }
      case 'denylist':
        return { excludeTools: preset.deniedTools ?? [] }
      case 'none':
        return { noTools: true }
    }
  }
}

// ── 内部 helpers ──────────────────────────────────────────────────

/**
 * 把磁盘读到的 raw（unknown）尝试 coerce 成 PiLaunchPreset。
 * 不通过返回 undefined（loadPresetsFile 会丢弃）。
 *
 * 必须有 id(string) + name(string) + builtin(boolean) + order(number) + toolMode + extensionMode。
 */
function coercePreset(raw: unknown): PiLaunchPreset | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (
    typeof r['id'] !== 'string' ||
    typeof r['name'] !== 'string' ||
    typeof r['builtin'] !== 'boolean' ||
    typeof r['order'] !== 'number' ||
    typeof r['toolMode'] !== 'string' ||
    typeof r['extensionMode'] !== 'string'
  ) {
    return undefined
  }
  // 必填字段已验证，其余字段直接透传（PiLaunchPreset 的可选字段保持 unknown→具体类型由调用方信任）
  // 双重断言：先 unknown 再 PiLaunchPreset（r 是 Record<string, unknown>，直接断言 TS 报不重叠）。
  return { ...(r as unknown as PiLaunchPreset) }
}

/** 按 id upsert（存在则替换，不存在则追加）。就地修改 presets 数组。 */
function upsertById(presets: PiLaunchPreset[], preset: PiLaunchPreset): void {
  const idx = presets.findIndex(p => p.id === preset.id)
  if (idx >= 0) {
    presets[idx] = preset
  } else {
    presets.push(preset)
  }
}
