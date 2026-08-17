/**
 * tasks builtin plugin 静态 manifest（s5 W3 骨架）。
 *
 * 职责：声明 builtin tasks plugin 的实体级 manifest（id / builtin 身份 / activationEvents /
 * contributes），供 s2 的 contribution-registry / command-registry 消费（builtin 白名单免审批、
 * 免 sandbox 硬锁）。本 wave 只产声明结构 + 类型，不接入 ExtensionHost runtime（ES2 降级：
 * 真实激活/注册待 s2 就绪）。
 *
 * ── 声明与执行分离（D1 双轨收编）──────────────────────────────
 * contributes.slashCommands / commands 只提供显示元数据（CommandPopover 统一显示、快捷键绑定），
 * /goal /todo 的实际执行仍由 pi-goal / pi-todo extension（pi 子进程内）承担，
 * xyz-agent runtime 不接管执行（§8「pi extension 消费通道不动 runtime 边界」）。
 *
 * ── 与 s2 builtin-contributions.ts 的关系（TODO 待 s2/s5 对接统一）────────────────
 * 本文件是 plugin 实体级声明（id/builtin/activationEvents/contributes 全量）；
 * s2 的 builtin-contributions.ts 是 ContributionRegistry 的扁平贡献源（ContributionRecord 消费侧）。
 * 两者语义层级不同，允许共存；s2 消费侧应优先从本 manifest 提取 contributes 而非手写重复，
 * 若 s2 先行交付则以其扁平结构为消费真相，本 manifest 保持类型一致。
 *
 * ── 与 s1 contribution schema v2 的对齐（TODO 待 s1 定稿）────────────────────────
 * 本文件类型按 s5 slice plan DM1 骨架定义（slashCommands.name 含前导 /）。
 * s1 schema v2 的 PluginContributes.slashCommands 形状是 { name, description }（不含前导 /），
 * s1 定稿后按 s1 字段形状对齐（含 name 归一规则）。
 */

/**
 * slash 命令声明（DM1 骨架）。
 *
 * name 含前导 /（如 '/goal'）——TODO 对齐 s1：s1 schema v2 的 slashCommands 形状为
 * { name, description }（不含前导），s1 定稿后按 s1 字段对齐。
 */
export interface PluginSlashCommandDeclaration {
  name: string // 含前导 /，如 '/goal'
  title: string
  category?: string
  icon?: string // icon key（lucide 图标名）
  keybinding?: string
  when?: string // 上下文条件
}

/** 命令面板声明（DM1 骨架，对齐 s1 DM3 PluginContributesCommand 形状）。 */
export interface PluginCommandDeclaration {
  command: string
  title: string
  category?: string
  keybinding?: string
  icon?: string
  when?: string
}

/** builtin plugin 激活事件枚举（DM1 骨架，与 s2 activation-manager 的懒激活事件对齐）。 */
export type BuiltinActivationEvent =
  | 'onStartupFinished'
  | 'onView'
  | 'onCommand'
  | 'onSlashCommand'
  | 'onSessionCreate'

/**
 * builtin plugin 实体级 manifest（DM1 骨架）。
 *
 * builtin 字段是字面量 true 类型——强制 builtin 身份不可伪造（activation-manager
 * 白名单消费的免审批/免 sandbox 锁标记，s7 硬锁依赖此字段）。
 */
export interface BuiltinPluginManifest {
  id: string
  builtin: true
  activationEvents: BuiltinActivationEvent[]
  contributes: {
    slashCommands?: PluginSlashCommandDeclaration[]
    commands?: PluginCommandDeclaration[]
  }
}

/**
 * tasks plugin 静态 manifest（IF1）。
 *
 * - id 全局唯一：'xyz-agent.tasks' 命名空间
 * - builtin: true：免审批 / 免 sandbox 锁的身份标记（activation-manager 白名单消费）
 * - activationEvents: ['onStartupFinished']：随 ExtensionHost 启动即激活
 * - contributes.slashCommands：/goal /todo 显示元数据（执行由 pi extension 承担）
 * - contributes.commands：命令面板项（command 带命名空间前缀保证全局唯一）
 */
export const tasksPluginManifest: BuiltinPluginManifest = {
  id: 'xyz-agent.tasks',
  builtin: true,
  activationEvents: ['onStartupFinished'],
  contributes: {
    slashCommands: [
      {
        name: '/goal',
        title: '创建目标',
        category: 'Tasks',
        icon: 'target',
      },
      {
        name: '/todo',
        title: '创建任务',
        category: 'Tasks',
        icon: 'list-todo',
      },
    ],
    commands: [
      {
        command: 'xyz-agent.tasks.createGoal',
        title: '创建目标',
        category: 'Tasks',
        icon: 'target',
      },
      {
        command: 'xyz-agent.tasks.createTodo',
        title: '创建任务',
        category: 'Tasks',
        icon: 'list-todo',
      },
    ],
  },
}
