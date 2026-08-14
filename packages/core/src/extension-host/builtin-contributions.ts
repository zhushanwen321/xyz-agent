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
    // tasks 的 slashCommands 仍静态声明（W3 CommandRegistry 收编需要）；其 views（todo/goal）
    // 不再硬编码——由通用 widget bridge 动态承接：extension:widget 推送 widgetKey='todo'/'goal'
    // 时，ViewHostStore.getViewIds 自动发现，sidebar L2TabBar 暴露对应 view tab。
    // 任何支持 GUI 协议的 extension 都经此通道自动渲染，无需 xyz-agent 侧适配。
    pluginId: 'tasks',
    contributes: {
      slashCommands: [
        { name: 'goal', description: '创建目标' },
        { name: 'todo', description: '创建任务' },
      ],
    },
  },
]
