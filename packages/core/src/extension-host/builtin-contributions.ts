/**
 * builtin-contributions.ts —— builtin 双插件静态 manifest（DM5）。
 *
 * builtin plugin 的 contributes 静态声明（不经 runtime，feature D1「builtin 免审批先行」）。
 * 形状按 core 版 PluginContributes v2（types.ts，对齐 s1 schema v2）。
 *
 * - statusline（与 runtime 侧 statusline plugin 同名对齐）：
 *   statusBarItems 文本为空串——实际内容由 runtime plugin:statusBarUpdate 广播填充
 * - tasks（goal/todo，s5 落地 plugin 实体）：
 *   slashCommands 声明（goal/todo，name 不含前导 /，对齐 s1 schema v2 形状），执行仍由 pi extension 承担（§8 边界）
 *
 * 与 packages/core/src/extension-host/builtin/tasks/manifest.ts（s5 W3 的插件实体级 manifest）
 * 语义层级不同（本文件是 ContributionRegistry 的扁平贡献源），两者允许共存——
 * s2 消费侧以本文件扁平结构为消费真相（s5 manifest 注释已声明此关系）。
 */
import type { BuiltinContribution } from './types'

export const builtinContributions: BuiltinContribution[] = [
  {
    pluginId: 'statusline',
    contributes: {
      statusBarItems: [
        { id: 'statusline', text: '', priority: 0 },
      ],
    },
  },
  {
    pluginId: 'tasks',
    contributes: {
      views: [
        { id: 'todo', title: '任务', placement: 'sidebar.tab', initialVisibility: 'visible' },
        { id: 'goal', title: '目标', placement: 'sidebar.tab', initialVisibility: 'visible' },
      ],
      slashCommands: [
        { name: 'goal', description: '创建目标' },
        { name: 'todo', description: '创建任务' },
      ],
    },
  },
]
