/**
 * flow —— 新建任务流程编排器（core 域迁移版，IF5）。
 *
 * [归位] 迁自 renderer composables/features/useNewTaskFlow.ts（471 行），语义逐条等价。
 * C-NT-2 裁决的跨域接线：session 生命周期经注入的 SessionFlowPort（契约对齐
 * domain/session/createSessionFlow IF5）、chat 经 ChatSendPort、panel/navigation/workspace
 * 经 NavigationPanelPort、toast 经 ToastPort、fileTree 经 FileTreePort、i18n 经 TranslatePort、
 * retry image 迁移经 ImageMigratePort。useNewTaskFlow(deps) 参数注入（IF5），core 零跨包 import。
 *
 * 职责（编排，非状态机实现）：NewTaskFlow 横切编排骨架——compose 状态机 + 分支 + 选目录三子模块，
 * 自身仅保留跨子模块的编排动作：
 * - startFlow：进 landing（销毁重建终态 / in-flight 守卫 / presetCwd / 不变量强制清 activeId）。
 * - submitFirstMessage：landing 态首发提交（create session + apply 模型/思考等级 / 载入 panel + 发送）。
 * - presetCwd / setPendingModel / setPendingPreset：landing 态回灌选定值（create session 后 apply）。
 * - closeOverlay / cancelFlow / reenterFlow / completeFlow：薄转换封装。
 * - computed 视图（currentSessionId/currentCwd/currentModel/gitInfo/isInflight/isOverlay/isActive）。
 *
 * 状态机实现见 flow-state；git 分支见 branch；选目录见 dir-select。
 */
import { computed, ref } from 'vue'
import type { ComputedRef } from 'vue'
import type { Segment } from '@xyz-agent/shared'
import type { CreateSessionFlowInput } from '../session/create-session-flow'
import {
  useNewTaskFlowState,
  useNewTaskFlowController,
  transition,
  openOverlay,
  OVERLAY_STATES,
  ACTIVE_STATES,
  type GitInfo,
} from './flow-state'
import { useNewTaskBranch, type NewTaskBranchController } from './branch'
import { useNewTaskDirSelect } from './dir-select'
import type {
  NewTaskFlowDeps,
  ImageMigratePort,
} from './ports'

/**
 * 把 landing 态落 tmpdir 的图片 move 到 <dataDir>/attachments/<sessionId>/（持久化）。
 *
 * 单文件失败不阻断（OS 可能已清理 tmpdir），用 Promise.allSettled 收集结果，
 * 失败项 console.warn 后跳过。返回成功迁移的 Map<oldPath, newPath>，供调用方更新 segments.path。
 *
 * 边界（C-W5-2）：创建分支的迁移已下沉 core createSessionFlow（返回 migratedSegments），
 * 本函数仅保留给 retry/预建分支（session 已存在，不调 createSessionFlow）的 tmpdir image 迁移。
 *
 * migrateSessionImage 在 web/mock 环境返回 undefined（非 reject），不进 migrated；调用方据此保留原 path。
 */
async function migrateTmpdirImages(
  images: Array<Extract<Segment, { type: 'image' }>>,
  sessionId: string,
  migrateImage: ImageMigratePort['migrateImage'],
): Promise<Map<string, string>> {
  const migrated = new Map<string, string>()
  const results = await Promise.allSettled(
    images.map(async (img) => {
      const result = await migrateImage({
        fromPath: img.path,
        sessionId,
        fileName: img.fileName,
      })
      if (result?.path) {
        migrated.set(img.path, result.path)
      }
    }),
  )
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`[useNewTaskFlow] image migrate failed: ${images[i].path}`, r.reason)
    }
  })
  return migrated
}

/**
 * 新建任务流程编排器（IF5）。
 *
 * @param deps 全部跨域依赖经注入端口（NewTaskFlowDeps——ports 七端口 + gitApi/directoryPicker/
 *   workspaceApi/workspaceState 四端口；壳层 w5 适配 renderer api/stores/composables 注入）
 */
export function useNewTaskFlow(deps: NewTaskFlowDeps) {
  const { ports, gitApi, directoryPicker, workspaceApi, workspaceState } = deps

  const {
    state,
    currentSession,
    pendingCwd,
    pendingModel,
    createInFlight,
  } = useNewTaskFlowState()

  /**
   * Landing 态用户选定的预设 id（session.create 透传用）。
   * 对齐 pendingCwd/pendingModel 范式：landing 态记录选定值，submitFirstMessage 时透传。
   * startFlow 时重置为 null。PresetSelectChip 通过 setPendingPreset 写入。
   * 实例局部 ref（源语义，非模块级）。
   */
  const pendingPreset = ref<string | null>(null)

  // 受控写入口 controller（父编排器独占）：setter 不再模块级 export，杜绝子模块 /
  // 组件越权 import 调用。本编排器独占后，按需把具体 setter 作为参数下发给子模块。
  const controller = useNewTaskFlowController()

  /** 当前 flow 绑定 session 的 id（统一延迟 create 后，landing 态恒为 null） */
  const currentSessionId: ComputedRef<string | null> = computed(
    () => currentSession.value?.id ?? null,
  )
  /** 当前 flow 工作的 cwd（chip 回灌）：session 已建用 session.cwd，否则用 landing 选定的 pendingCwd */
  const currentCwd: ComputedRef<string | null> = computed(
    () => currentSession.value?.cwd ?? pendingCwd.value,
  )
  /**
   * 当前 flow 选定模型（Composer 显示用）：session 已建用 session.modelId，
   * 否则用 landing 选定的 pendingModel。两者均空时 Composer 自行回退全局 defaultModel。
   */
  const currentModel: ComputedRef<string | null> = computed(
    () => currentSession.value?.modelId ?? pendingModel.value,
  )

  // 选目录子模块（需在 gitInfo 前创建：gitInfo landing 态 fallback 读 dirSelect.mode/worktreeItems）
  const dirSelect = useNewTaskDirSelect(
    { directoryPicker, workspaceApi, workspaceState },
    () => currentCwd.value,
  )

  /**
   * gitInfo（UC-7 chip 可见性 + openBranchPopover 守卫派生）。
   * 数据源优先级：
   * 1. session 态（已建 session）：currentSession.gitBranch / isBareWorkspace
   * 2. landing 态（无 session，延迟 create）：dirSelect 的 mode + worktreeItems HEAD 项
   *    —— landing 态无 session，旧实现只从 session 派生导致恒 null，branch chip 永不显示、
   *       openBranchPopover 守卫必抛错。改为合并 landing 态数据源。
   */
  const gitInfo: ComputedRef<GitInfo | null> = computed(() => {
    const s = currentSession.value
    if (s?.gitBranch) {
      return { branch: s.gitBranch, isRepo: true, isBare: s.isBareWorkspace ?? false }
    }
    // landing 态 fallback：从 dirSelect 的 pendingCwd 驱动数据派生
    if (dirSelect.mode.value !== 'not-repo') {
      const head = dirSelect.worktreeItems.value?.find((w) => w.HEAD)
      return { branch: head?.branch ?? '', isRepo: true, isBare: dirSelect.isBare.value }
    }
    return null
  })

  /**
   * startFlow —— 触发新建（§4.1 主流程，统一延迟 create）。
   *
   * 需求修正：点「新建任务」后**不立即 create session**，只进 landing 空 chip 态。
   * 首次/非首次一致（推翻原「触发即创建」+ G1.1「非首次沿用上次 cwd」）。
   * session 由首发提交 submitFirstMessage 创建；选目录只记 pendingCwd 不建 session。
   * - completed 终态再触发→先销毁重建 idle（AC-3.12）再进 landing
   * - createInFlight 守卫：submitFirstMessage 飞行中再触发→忽略（防并发重复建 session）
   * - presetCwd：可选，进 landing 时预设 chip 的 cwd（initApp 用最近 session 目录预填）。
   *   未传→空 chip 态（默认）；传值→chip 所见即所得（G1.1「沿用目录做新任务」）。
   *
   * 不变量强制（根治 new-task 渲染撕裂）：flow 进 landing 时，编排层主动清空
   * activeId + active panel 的 leaf.sessionId。此前该不变量只写在注释（ACTIVE_STATES
   * 注释「flow 活跃期间 activeId 恒 null」），从未被代码执行——会话中点新建时旧
   * sessionId 残留，Panel.vue 第一条 v-if 用旧 sessionId 命中 MessageStream，导致
   * 「页面不跳转、只 composer 消失」。此处清空后 sessionId=null → Landing 正确渲染。
   */
  async function startFlow(presetCwd?: string): Promise<void> {
    // 终态重建（AC-3.12）：completed 后 ⌘N 销毁重建。completed→idle 不在 ALLOWED 表（completed 无出口），
    // 必须用 transitionUnchecked（@internal 终态重建语义），随后 idle→landing 走正常 transition。
    if (state.value === 'completed') {
      controller.transitionUnchecked('idle')
      controller.bindCurrentSession(null)
    }
    if (createInFlight.value) return // submitFirstMessage 飞行中，忽略重复触发
    // 幂等：已 landing 态再 startFlow（initApp 重试 / 多次 ⌘N）→ 不翻 state（landing→landing
    // 非法），只刷新 cwd + 不变量。避免 loadSessions 失败后 initApp 重试时 transition 抛错。
    if (state.value !== 'landing') {
      transition('landing') // idle→landing
    }
    // 进 landing：预设 cwd（有则 chip 所见即所得，无则空 chip 态）
    pendingCwd.value = presetCwd ?? null
    pendingModel.value = null
    pendingPreset.value = null
    controller.bindCurrentSession(null)
    // 强制不变量：landing 态无 session 绑定。清 activeId + active panel leaf.sessionId，
    // 让 Panel 的 sessionId prop 变 null → 渲染落到 Landing（而非旧会话 MessageStream）。
    ports.navigation.clearActiveSession()
    ports.navigation.loadPanel(ports.navigation.activePanelId(), null)
  }

  /**
   * submitFirstMessage —— landing 态首发提交：载入 panel + 发消息。
   *
   * 预创建后 session 已在选目录时建立，这里只负责载入 panel + 发送。
   * - 无绑定 session（未选目录直接输入发送，用 workspaceStore.defaultCwd 兑底 create）→ create 后发送
   * - 已绑定 session（选过目录预建 / 重试场景）→ 直接载入 + 发送，不重复 create
   *
   * bash 首发（composer-bash-execute）：landing 态输入 !/!! 前缀时，Composer 提取 bashCommand
   * 传入，session 创建 + panel 载入流程不变，仅发送阶段改调 chat.sendBash（不走 LLM turn，
   * 不经 segments 提取）。segments 仍作为 session label 来源 + 非空校验。
   *
   * segments 来自 Composer DOM 快照（getSegments），含 text / skill / file / mention / image 段。
   * landing 态可能纯图（含 image 但无 text），用户只贴图不写字也允许发送——入参校验只要求 segments
   * 非空，不强制 text 段存在。session label 从首段 text 段取（无 text 段时 deriveSessionLabel('')
   * 兜底为「无提示词」）。
   *
   * tmpdir 迁移：landing 态图片可能落 tmpdir（writeSessionImage 在 sessionId 为空时降级 tmpdir）。
   * session.create 成功后，扫描 segments 把 needsMigrate=true 的 image move 到 attachments/<sessionId>/。
   * 迁移判断用 segment.needsMigrate 字段（M1 修复），不猜路径——+菜单选的用户磁盘文件 needsMigrate
   * 不设（false），不会被误迁移（避免 renameSync 把用户原文件移走——数据丢失）。
   * 迁移后再 chat.send——appendUser 用迁移后的 path，segmentsToText 也产出迁移后的 path，不需要额外的 store update。
   * 降级：单文件迁移失败（OS 已清理 tmpdir）不阻断发送，console.warn + toast 提示，path 保留 tmpdir
   * （路径进 prompt 文本，LLM 调 read 工具时文件不存在会自然报错——但路径本身仍发，非硬错误）。
   *
   * thinkingLevel：landing 态 Composer 传入用户选定（或切模型自动重置）的思考等级，
   * create session 后 apply（session.setThinkingLevel）。undefined 表示用户未操作，
   * 用 runtime 默认。apply 经 SessionFlowPort.setThinkingLevel（C-W4-3 留壳步）。
   *
   * @param segments 结构化 segments（含 text/image/skill/file/mention 段）
   * @param thinkingLevel 可选思考等级（landing 态 Composer 选定值）
   * @param bashCommand [S10] bash 命令参数。仅当 extractBashCommand.type === 'command' 时传入，
   *   undefined = 非 bash 走普通 send。调用方控制流保证此契约（Composer.vue 按 type 分支）。
   *
   * presetId（preset 透传）：landing 态用户在 PresetSelectChip 选定的预设。
   * 透传链路（B6 修复）：PresetSelectChip emit select → Landing.vue onPresetSelect →
   * flow.setPendingPreset 写 pendingPreset；这里 submitFirstMessage create session 时读
   * pendingPreset.value 透传 sessionApi.create。Composer onSend 不再直接读 store.selectedPresetId，
   * 统一走 flow 单一真源（与 pendingCwd/pendingModel 范式一致）。
   */
  async function submitFirstMessage(
    segments: Segment[],
    thinkingLevel?: string,
    bashCommand?: { command: string; excludeFromContext: boolean },
  ): Promise<void> {
    // segments 不能为空；含 text 段时提取首段文本作 session label
    const firstTextSeg = segments.find((s): s is Extract<Segment, { type: 'text' }> => s.type === 'text')
    const trimmed = firstTextSeg?.text?.trim() ?? ''
    // 含图片/文件/skill 等非 text 段但无文本也允许发送（用户可能只贴图不写字）
    const hasOnlyNonText = segments.some((s) => s.type !== 'text')
    if (!trimmed && !hasOnlyNonText) return
    if (state.value !== 'landing') {
      throw new Error('NewTaskFlow: 非 landing 态不可首发提交')
    }
    if (createInFlight.value) return
    controller.setCreateInFlight(true)
    try {
      let finalSegments = segments
      // 未选目录直接发送（用默认 cwd 兑底 create），或重试场景已绑定
      if (!currentSession.value) {
        // C-NT-2：session 创建部分改调注入的 createSessionFlow 端口（SessionFlowPort，
        // 契约对齐 domain/session/createSessionFlow IF5）。壳把 createSessionFlow(ctx, input)
        // 包成端口实现（ctx 的 store/api/defaultCwd/onCwdFallback/applyModel 由壳组装）。
        // createSessionFlow 内部做：guard→cwd 兑底→label 派生→create→INV-7 降级→appendSession→
        // applyModel→migrateImages，返回 {session, migratedSegments} | null（null=空 content guard）。
        // 壳只补 thinkingLevel apply（C-W4-3 留壳，经本端口 setThinkingLevel）+ 后续 panel/send。
        const input: CreateSessionFlowInput = {
          cwd: pendingCwd.value,
          presetId: pendingPreset.value,
          pendingModel: pendingModel.value,
          segments,
          bashCommand: bashCommand ?? null,
        }
        const result = await ports.createSessionFlow.createSession(input)
        // 空 content guard 命中（createSessionFlow 返回 null）→ abort send（不 send，session 未创建）
        if (!result) return
        controller.bindCurrentSession(result.session)
        // C-W4-3：thinkingLevel apply 留壳（createSessionFlow 不做，只做 model apply）
        if (thinkingLevel) {
          await ports.createSessionFlow.setThinkingLevel(result.session.id, thinkingLevel)
        }
        // createSessionFlow 已迁移 needsMigrate image 段（path 更新 + needsMigrate 重置），
        // 壳直接用 result.migratedSegments 做 send（不重复迁移）。
        finalSegments = result.migratedSegments
      } else {
        // retry/预建分支：session 已存在，不调 createSessionFlow。landing 态 tmpdir image 段
        // （用户重试时新贴的图）需侧迁移（createSessionFlow 未跑，migration 未发生）。
        const needsMigrateImages = segments.filter(
          (s): s is Extract<Segment, { type: 'image' }> =>
            s.type === 'image' && s.needsMigrate === true,
        )
        if (needsMigrateImages.length > 0) {
          const migrated = await migrateTmpdirImages(
            needsMigrateImages,
            currentSession.value!.id,
            ports.migrateImage.migrateImage,
          )
          finalSegments = segments.map((s) => {
            if (s.type === 'image' && migrated.has(s.path)) {
              // 迁移成功：更新 path + 重置 needsMigrate=false（避免后续重发误迁移）。
              return { ...s, path: migrated.get(s.path)!, needsMigrate: false }
            }
            return s
          })
          if (migrated.size < needsMigrateImages.length) {
            // 部分迁移失败：toast 提示（不阻断发送）
            ports.toast.warning(
              ports.t('composable.imageMigratePartialFailed', {
                count: needsMigrateImages.length - migrated.size,
              }),
            )
          }
        }
      }
      // 载入 panel + 设 activeId（预建或刚建统一处理）
      const newSid = currentSession.value!.id
      ports.navigation.setActiveSession(newSid)
      ports.navigation.loadPanel(ports.navigation.activePanelId(), newSid)
      ports.navigation.pushChat(newSid)
      // 文件树预加载：新建 session 后侧栏「文件」tab 计数（fileCount 读 store.getTree）立即更新。
      // fire-and-forget：失败不阻断首发发送（文件树缺失仅致 tab 计数为 0）。
      void ports.fileTree.loadTree(newSid)
      // per-session sid：显式传 newSid，不依赖全局 activeId（双 panel 隔离）
      // tmpdir 迁移已在上方分支完成（create 分支=createSessionFlow.migratedSegments，
      // retry 分支=migrateTmpdirImages），finalSegments 即迁移后的段。bashCommand 无图片段，无副作用。
      // 发送阶段：bash 首发（landing 态 !/!! 前缀）走 sendBash，否则普通 send
      // bash 不经 segments（原始 shell 文本透传 pi bash RPC），finalSegments 仅用于 tmpdir 迁移流程（bash 无图片段，无副作用）
      if (bashCommand) {
        await ports.chat.sendBash(newSid, bashCommand.command, bashCommand.excludeFromContext)
      } else {
        await ports.chat.send(newSid, finalSegments)
      }
      transition('completed') // landing→completed（首发成功，终态）
    } finally {
      controller.setCreateInFlight(false)
    }
  }

  /**
   * presetCwd —— landing 态回灌预设 cwd（启动编排用，G1.1「沿用最近 session 目录」）。
   *
   * 与 startFlow(presetCwd) 同语义（写 pendingCwd → chip 所见即所得），但用于 startFlow
   * 已先进 landing、cwd 还需异步加载后才确定的场景：
   * initApp 必须在 await loadSessions() **之前**同步 startFlow() 进 landing，否则
   * 「连接成功→AppShell 渲染 Landing」与 startFlow 之间会有 flow.state=idle 的启动窗口，
   * 此时点 directory chip 触发 idle→dir-popover 非法转换抛错。故顺序定为先 startFlow（空 chip）
   * → loadSessions → presetCwd 回灌。
   *
   * 守卫：仅 landing 态生效（其他态 noop，避免污染 overlay/终态流程）。
   */
  function presetCwd(cwd: string): void {
    if (state.value !== 'landing') return
    pendingCwd.value = cwd
  }

  /**
   * setPendingModel —— landing 态记录用户选定但尚未 apply 的模型。
   *
   * landing 态 session 尚未 create，无法调 model.switch RPC。记 pendingModel 供 Composer
   * 显示所选模型（currentModel computed），首发提交 submitFirstMessage create session 后 apply。
   * 守卫：仅 landing 态生效（其他态 noop，避免污染 overlay/终态流程）。
   * payload 为 "provider/modelId" 复合串（ModelSelectPopover emit 的格式约定）。
   */
  function setPendingModel(model: string): void {
    if (state.value !== 'landing') return
    pendingModel.value = model
  }

  /**
   * setPendingPreset —— landing 态记录用户选定但尚未透传的预设 id。
   *
   * 对齐 pendingCwd/pendingModel 范式。PresetSelectChip emit select 时调用，
   * submitFirstMessage create session 时透传给 sessionApi.create。
   * 守卫：仅 landing 态生效。
   */
  function setPendingPreset(presetId: string): void {
    if (state.value !== 'landing') return
    pendingPreset.value = presetId
  }

  // ── compose 子模块（分支 + 选目录）── 传 computed 值的 getter，解耦于父内部 ──
  // branch 子模块需要飞行标记 setter + 守卫失败回 idle 的 transitionUnchecked，
  // 由父编排器从独占 controller 中按需注入（setter 不再模块级 export，无法被子模块直接 import）。
  const branch = useNewTaskBranch(
    gitApi,
    () => currentSessionId.value,
    () => gitInfo.value,
    () => currentCwd.value,
    {
      setBranchCreateInFlight: controller.setBranchCreateInFlight,
      transitionUnchecked: controller.transitionUnchecked,
    } satisfies NewTaskBranchController,
  )
  /**
   * 任意 overlay→landing（Esc/点外）。同一时刻只一层（AC-3.9）。幂等：仅当前处于 overlay 态
   * 才转换，否则 noop——避免重复调用导致 landing→landing 非法转换（state 被打回 idle）。
   *
   * [HISTORICAL] 重复调用来源：worktree/branch 成功回调先 selectWorkspace（已 transition('landing')）
   * 再 closeOverlay，加上 modal @close 又触发一次 closeOverlay，叠加成 landing→landing 非法转换
   * → transition 非法分支置 state='idle' → 用户在 landing 页提交时撞 submitFirstMessage 的
   * `state !== 'landing'` guard 报「非 landing 态不可首发提交」。渲染判定（Panel isLandingView
   * 看 sessionId prop）与提交 guard（看 flow.state）真源不一致，导致「明明在 landing 页却报非 landing」
   * 的诡异现象。幂等化根因修复，所有正常调用点（来源态均 overlay）行为不变。
   */
  function closeOverlay(): void {
    if (!OVERLAY_STATES.has(state.value)) return // 幂等：非 overlay 态 noop（已 landing/idle 等）
    transition('landing') // dir-popover/branch-popover/dir-dialog/branch-modal/worktree-modal → landing
  }

  /** landing/overlay→cancelled（overlay 打开时切 session，AC-3.10）。 */
  function cancelFlow(): void {
    transition('cancelled')
  }

  /** cancelled→landing（重选空 session 复活，AC-3.3）。 */
  function reenterFlow(): void {
    transition('landing')
  }

  /** landing→completed（首条消息成功，终态）。completed 后实例销毁，⌘N 再触发重建（AC-3.6/3.12）。 */
  function completeFlow(): void {
    transition('completed')
  }

  /**
   * openPresetPopover —— 点 PresetSelectChip 打开 preset popover（landing→preset-popover）。
   *
   * overlay 互斥由 openOverlay 统一处理（已开任意 overlay 时先归 landing 再开 preset-popover）。
   * preset 不涉及 git 守卫（任何 landing 态均可开），故内联在主 controller 而非拆独立模块。
   */
  function openPresetPopover(): void {
    openOverlay('preset-popover')
  }

  return {
    state,
    currentSession,
    currentSessionId,
    currentCwd,
    currentModel,
    gitInfo,
    isInflight: createInFlight,
    isBranchCreating: branch.isBranchCreating,
    isOverlay: computed(() => OVERLAY_STATES.has(state.value)),
    isActive: computed(() => ACTIVE_STATES.has(state.value)),
    startFlow,
    submitFirstMessage,
    presetCwd,
    setPendingModel,
    setPendingPreset,
    openDirPopover: dirSelect.openDirPopover,
    openBranchPopover: branch.openBranchPopover,
    openPresetPopover,
    selectWorkspace: dirSelect.selectWorkspace,
    openDirDialog: dirSelect.openDirDialog,
    selectBranch: branch.selectBranch,
    confirmDirtySwitch: branch.confirmDirtySwitch,
    openBranchModal: branch.openBranchModal,
    submitCreateBranch: branch.submitCreateBranch,
    openCreateWorktree: dirSelect.openWorktreeModal,
    isBare: dirSelect.isBare,
    mode: dirSelect.mode,
    worktreeItems: dirSelect.worktreeItems,

    closeOverlay,
    cancelFlow,
    reenterFlow,
    completeFlow,
  }
}
