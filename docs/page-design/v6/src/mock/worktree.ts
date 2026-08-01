/** Mock 数据层 — 工作区设置页（WorktreePage）静态数据与文案 */

export interface WorktreeConfig {
  worktreeRootDir: string
  setupScript: string
  bareSetupScript: string
  timeout: number
  defaultBaseBranch: string
}

/** 表单草案（timeout 用字符串态，保存时转 number 校验；字段对齐真实 WorktreePage.vue） */
export type WorktreeDraft = Omit<WorktreeConfig, 'timeout'> & { timeout: string }

/** 初值（模拟 runtime 拉取结果；首屏快照 = 初值 → clean） */
export const INITIAL_DRAFT: WorktreeDraft = {
  worktreeRootDir: '~/Code/xyz-agent-workspace',
  setupScript: 'pnpm install',
  bareSetupScript: 'pnpm install && bash .bare/custom-hooks/setup-worktree.sh',
  timeout: '60',
  defaultBaseBranch: 'origin/main',
}

/** 浏览（mock 目录选择）候选列表 */
export interface CandidateDir {
  path: string
  kind: string
}
export const CANDIDATE_DIRS: CandidateDir[] = [
  { path: '~/Code/xyz-agent-workspace', kind: 'bare-workspace' },
  { path: '~/Code/dag-executor-workspace', kind: 'bare-workspace' },
  { path: '~/Code/stock-portfolio-service-workspace', kind: 'bare-workspace' },
  { path: '~/Code/chat_project', kind: '普通仓库' },
]

export const LOAD_DELAY = 350
export const SAVE_DELAY = 500
export const SAVED_NOTE_DURATION = 1500

/** 页面文案（业务术语对齐真实组件 i18n keys） */
export const TEXT = {
  pageDesc: 'worktree 目录配置：普通 git 仓库 / bare-workspace / 通用设置。',
  groupPlainRepo: '普通 git 仓库',
  groupPlainRepoDesc: 'git worktree 创建与初始化的配置',
  groupBare: 'bare-workspace',
  groupBareDesc: 'bare repo + 多 worktree 工作区结构的配置',
  groupGeneral: '通用',
  groupGeneralDesc: '其他通用设置',
  worktreeRootDir: 'worktree 根目录',
  worktreeRootDirHint: '创建 worktree 时使用的根目录（git-cwt 默认位置）',
  worktreeRootDirPlaceholder: '~/Code/xyz-agent-workspace',
  setupScript: '初始化脚本',
  setupScriptHint: '创建 worktree 后自动执行的初始化脚本',
  setupScriptPlaceholder: '如：pnpm install',
  bareSetupScript: '初始化脚本',
  bareSetupScriptHint: 'bare-workspace 创建后的自动初始化脚本',
  bareSetupScriptPlaceholder: '如：pnpm install',
  timeout: '创建超时',
  timeoutHint: 'worktree 创建超时（秒），默认 60',
  timeoutPlaceholder: '60',
  defaultBaseBranch: '默认基分支',
  defaultBaseBranchHint: '新 worktree 的默认基分支，默认 origin/main',
  defaultBaseBranchPlaceholder: 'origin/main',
  saved: '已保存',
  saving: '保存中…',
  unsaved: '未保存',
  save: '保存',
  cancel: '取消',
  continueEdit: '继续编辑',
  discard: '放弃改动',
  errTimeout: '创建超时必须是不小于 1 的整数',
  errSaveFailed: '保存失败：worktree 根目录包含非法字符 *，请修改后重试',
  leaveTitle: '放弃未保存的改动？',
  leaveDesc: '工作区设置有未保存的改动，离开设置将丢弃这些改动。',
  browse: '浏览',
  browseTitle: '选择 worktree 根目录',
  browseDesc: '本机目录（mock 候选列表，点击即填入）',
}
