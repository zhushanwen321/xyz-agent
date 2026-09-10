/**
 * MessageStream 布局常量族（virta 布局 + ActivityStrip 行高 + dev 断言阈值）。
 *
 * [D6 死路径清理 2026-09-09] 原本与常量同住的 useMessageStreamNotices composable
 * （isCompacting / isDispatching / hasWorkingTurn / forkNoticeBaseTop 状态聚合）已随
 * fork notice absolute 定位死路径一并删除：forkNoticeTop 不被模板消费（ForkNotice 为
 * 文档流 block，定位由文档序保证），isCompacting/isDispatching 消费方仅剩该死路径。
 * chat store 的 isCompacting 活跃消费方（ActivityStrip / deriveStatus / composer）不受影响。
 *
 * 从 MessageStream.vue 拆出（vue_rules_checker.py 的 script setup ≤300 行规范拆分惯例，
 * [cw wave w3]）——现仅剩常量导出，文件名保留（历史拆分谱系 + import 面稳定）。
 */

/**
 * compaction notice 占位高度。
 * 强绑定 DOM：ActivityStrip compacting 行（`system-notice content-col flex items-center gap-2 py-1`，
 * 含 `size-3` spinner + `text-[length:var(--text-xs)] leading-snug` 文本 + 两条 `h-px` 分隔线）。
 *   实际高度 = py-1(4px×2) + 内容 max(spinner 12px, text≈16px) ≈ 24px。
 *   [u6a] 行迁入 ActivityStrip（文档流 block，Virtualizer 之后），DOM 结构逐 class 等价 →
 *   高度语义不变；此常量供 ActivityStrip 行渲染消费 + dev 断言（useConstantHeightAssert）监测。
 *   改 padding/字号/icon 必须重测并同步此常量（dev 断言会提醒）。
 */
export const COMPACTING_NOTICE_HEIGHT = 24

/**
 * executing bash 瞬时行占位高度（W4 完整形态）。
 * 强绑定 DOM：ActivityStrip bash 行（与 compacting 行同结构：`system-notice flex items-center
 * gap-2 py-1`，`size-3` spinner + `text-[length:var(--text-xs)] leading-snug` 文本 + 两条
 * `h-px` 分隔线）→ 实际高度同 COMPACTING_NOTICE_HEIGHT ≈ 24px。
 * [u6a] 行 DOM 已迁入 ActivityStrip（文档流 block）——此常量供 dev 断言
 * （useConstantHeightAssert）监测高度漂移。改 padding/字号/icon 必须重测并同步（dev 断言会提醒）。
 */
export const EXECUTING_BASH_NOTICE_HEIGHT = 24

/**
 * 像素常量（design §4.1 附录 A）：itemSize 是 virta 的初始估算 hint（非强制，virta 自动从
 * 实测项重估）。与原手写虚拟滚动的 ESTIMATED_TURN_HEIGHT 一致，平滑迁移期减少首屏估算误差。
 * （[cw wave w3] 自 MessageStream.vue 随 ≤300 行拆分迁入——virta 布局常量族同源聚拢。）
 */
export const ESTIMATED_TURN_HEIGHT = 200

/**
 * load-more 按钮预留高度（B2 强绑 DOM：Button h-8 + py-2 ≈ 48px，取 44 为历史值，避免定位回归）。
 * [cw wave w3] 通过 <Virtualizer :startMargin> 喂入 virta（design §4.11）：virta getItemOffset 已含 startMargin。
 */
export const LOAD_MORE_RESERVED_HEIGHT = 44
