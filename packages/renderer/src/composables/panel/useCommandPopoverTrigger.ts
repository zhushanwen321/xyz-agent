/**
 * Composer 命令浮层触发态机（架构审查 F7，从 Composer.vue 拆出）。
 *
 * 职责（单一变化轴「slash/file 浮层触发 + CommandPopover 联动」）：
 * - slash/file 触发态标记（slashTriggerActive / fileTriggerActive）：区分「输入区 / 或 # 触发」
 *   与「+菜单触发」两条打开浮层路径——仅输入区路径设 true，使后续 trigger:null 能正确关闭浮层。
 * - onSlashTrigger / onFileTrigger：输入区触发事件路由（开/关浮层 + 记 query 透传过滤）。
 * - onAddSelect：+ 菜单打开 slash 浮层（不设触发态，防普通键误关）。
 * - onCmdSelect：选中后插 chip（slash/file），清过滤文本 + 复位触发态。
 * - pendingSlash watch：消费 SearchModal 经 commandStore 注入的 slash 请求。
 * - commandPopoverRef + cmdOpen：键盘路由（⏎/Esc）与 v-model:open 绑定。
 *
 * 不含：发送/steer/abort 编排、模型/思考等级、草稿维护（均留在 Composer.vue / 其他 composable）。
 */
import { ref, watch, type Ref } from 'vue'
import { useCommandStore } from '@/stores/command'
import { pickFile } from '@/lib/ipc'
import type ComposerInput from '@/components/panel/ComposerInput.vue'
import type CommandPopover from '@/components/panel/CommandPopover.vue'

/** + 菜单「附件」项的图片类型过滤扩展名（「图片」入口 pickFile filters 用） */
const IMAGE_FILTER_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']

export function useCommandPopoverTrigger(
  inputRef: Ref<InstanceType<typeof ComposerInput> | null>,
  sessionId: Ref<string | null>,
): {
  cmdOpen: Ref<boolean>
  cmdType: Ref<'file' | 'slash'>
  slashQuery: Ref<string>
  fileQuery: Ref<string>
  commandPopoverRef: Ref<InstanceType<typeof CommandPopover> | null>
  onSlashTrigger: (payload: { query: string } | null) => void
  onFileTrigger: (payload: { query: string } | null) => void
  onAddSelect: (type: 'attach' | 'image' | 'slash') => Promise<void>
  onCmdSelect: (payload: { type: 'file' | 'slash'; name: string; icon?: string; description?: string }) => void
} {
  const commandStore = useCommandStore()
  /** 命令浮层状态（§2d #//） */
  const cmdOpen = ref(false)
  const cmdType = ref<'file' | 'slash'>('file')
  /**
   * slash 触发态标记：区分「输入区 / 触发」与「+菜单触发」两条打开浮层路径。
   * 仅输入区 / 触发打开时为 true，使后续 slash-trigger:null 能正确关闭；
   * +菜单路径（onAddSelect）不设 true，避免用户敲普通键误关 +菜单浮层。
   */
  const slashTriggerActive = ref(false)
  /** slash 命令过滤 query（输入区 / 后内容），透传给 CommandPopover 过滤 */
  const slashQuery = ref('')
  /** # 文件触发态标记：同 slashTriggerActive 语义，区分输入区 # 触发与 +菜单触发两条路径 */
  const fileTriggerActive = ref(false)
  /** # 文件过滤 query（输入区 # 后内容），透传给 CommandPopover 过滤 */
  const fileQuery = ref('')
  const commandPopoverRef = ref<InstanceType<typeof CommandPopover> | null>(null)

  /**
   * 消费搜索浮层的 slash 注入请求（store 驱动模式，替代断链的 injectSlash 回调）。
   * SearchModal → useSearchJump.confirmCommand → commandStore.requestSlashInjection 写入 pendingSlash，
   * 本 watch 按 sessionId 过滤消费，命中则调 insertSlashChip 注入 chip 并 clearPendingSlash。
   *
   * 非 immediate：防 Composer 后挂载时读到旧 pendingSlash 残留值误注入（挂载时 store 可能已有
   * 给前一个 Composer 的请求，immediate 会立即误触发）。仅响应挂载后的新写入。
   * sessionId 匹配：含双方 null（landing 态）。不匹配分支不 clear（防误清留给其他 Composer 的请求）。
   * 注入顺序：先 insertSlashChip 后 clearPendingSlash（防先清后注入读到 null）。
   */
  watch(
    () => commandStore.pendingSlash,
    (req) => {
      if (!req) return
      if (req.sessionId !== sessionId.value) return // 仅消费目标 session 的请求
      inputRef.value?.insertSlashChip(req.command, req.icon)
      commandStore.clearPendingSlash()
    },
  )

  /** 输入区 slash-trigger 事件路由：
   *  - payload 非 null（/ 在最左且无 chip）→ 打开 slash 浮层，记录 query 透传过滤，标记 slashTriggerActive
   *  - payload 为 null 且 slashTriggerActive → 关闭浮层（仅输入区触发路径；+菜单路径 slashTriggerActive=false 不受影响） */
  function onSlashTrigger(payload: { query: string } | null): void {
    if (payload) {
      slashTriggerActive.value = true
      slashQuery.value = payload.query
      cmdType.value = 'slash'
      cmdOpen.value = true
    } else if (slashTriggerActive.value) {
      cmdOpen.value = false
      slashTriggerActive.value = false
    }
  }

  /** 输入区 file-trigger 事件路由（同 onSlashTrigger 语义，对应 # 文件浮层）：
   *  - payload 非 null（光标前有「空格/行首 + # + 非空白」）→ 打开 file 浮层，记录 query 透传过滤
   *  - payload 为 null 且 fileTriggerActive → 关闭浮层（# 后遇空格等终止场景） */
  function onFileTrigger(payload: { query: string } | null): void {
    if (payload) {
      fileTriggerActive.value = true
      fileQuery.value = payload.query
      cmdType.value = 'file'
      cmdOpen.value = true
    } else if (fileTriggerActive.value) {
      cmdOpen.value = false
      fileTriggerActive.value = false
    }
  }

  /** + 菜单选择：
   *  - attach（任意文件）：调 pickFile IPC（无 filters），选中后插文本路径到输入区。canceled 静默 return。
   *  - image（图片）：调 pickFile IPC（带 image filters），选中后以磁盘 path 插 image chip。
   *  - slash：打开命令浮层（slashTriggerActive 不设 true——+菜单路径的浮层不受后续 slash-trigger:null 影响）。
   *
   *  pickFile 降级（web/mock 无 preload）→ {canceled:true, path:null}，onAddSelect 视同取消 return（不 throw）。
   *  pickFile 异常（reject）→ try/catch 降级：记 warn 后 return（取消已是预期路径，不 toast / 不重抛）。
   *  file 入口已移除（# 改走 inline 触发）。 */
  async function onAddSelect(type: 'attach' | 'image' | 'slash'): Promise<void> {
    if (type === 'attach' || type === 'image') {
      inputRef.value?.focus()
      try {
        const result =
          type === 'image'
            ? await pickFile({ filters: [{ name: 'Images', extensions: IMAGE_FILTER_EXTENSIONS }] })
            : await pickFile()
        if (result.canceled || !result.path) return
        if (type === 'image') {
          // image：文件已在磁盘，直接以原 path 建 image chip（不走 writeTmpImage，避免复制 + path 漂移）
          const name = result.path.split(/[\\/]/).pop() || result.path
          inputRef.value?.insertImageBadge(result.path, name)
        } else {
          // attach：任意文件，文本路径插入（与 Ctrl+V 路径文本通路一致，轻量）
          inputRef.value?.insertTextAtCursor(result.path)
        }
      } catch (e) {
        // pickFile reject（IPC 异常 / 主进程崩溃）→ best-effort 降级：取消已是预期路径，
        // 不 toast、不重抛（用户点 + 菜单选文件失败不应阻断 composer 其他操作）。仅记 warn 便于排查。
        console.warn('[onAddSelect] pickFile IPC failed', e)
      }
      return
    }
    // slash
    inputRef.value?.saveSelection()
    inputRef.value?.focus()
    cmdType.value = 'slash'
    cmdOpen.value = true
  }

  /** 命令浮层选中：插 slash chip / file chip。slash 分支先清掉 /query 过滤文本再插 chip；
   *  file 分支先清掉 #query 过滤文本（任意位置，只删 # 到光标这段）再插 mention chip。
   *  icon 按 source 透传给 chip（extension→terminal / skill→star / 默认 wrench），与选择框图标一致。 */
  function onCmdSelect(payload: {
    type: 'file' | 'slash'
    name: string
    icon?: string
    description?: string
  }): void {
    cmdOpen.value = false
    slashTriggerActive.value = false // 复位触发态标记
    fileTriggerActive.value = false // 复位 # 触发态标记
    inputRef.value?.focus()
    if (payload.type === 'slash') {
      inputRef.value?.clearSlashQueryText()
      inputRef.value?.insertSlashChip(payload.name, payload.icon)
    } else {
      inputRef.value?.clearHashQueryText()
      inputRef.value?.insertMentionChip('#', payload.name)
    }
  }

  return {
    cmdOpen,
    cmdType,
    slashQuery,
    fileQuery,
    commandPopoverRef,
    onSlashTrigger,
    onFileTrigger,
    onAddSelect,
    onCmdSelect,
  }
}
