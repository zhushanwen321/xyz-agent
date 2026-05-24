import { registerToolRenderer } from './tool-renderer-registry'
import type { Component } from 'vue'
import BashToolRenderer from '../components/chat/ToolRenderers/BashToolRenderer.vue'
import EditToolRenderer from '../components/chat/ToolRenderers/EditToolRenderer.vue'
import ReadToolRenderer from '../components/chat/ToolRenderers/ReadToolRenderer.vue'
import DefaultToolRenderer from '../components/chat/ToolRenderers/DefaultToolRenderer.vue'
import WriteToolRenderer from '../components/chat/ToolRenderers/WriteToolRenderer.vue'
import SubagentRenderer from '../components/chat/ToolRenderers/SubagentRenderer.vue'
import RenderDescriptor from '../components/chat/ToolRenderers/RenderDescriptor.vue'

export function registerBuiltinToolRenderers(): void {
  registerToolRenderer('bash', BashToolRenderer as unknown as Component)
  registerToolRenderer('edit', EditToolRenderer as unknown as Component)
  registerToolRenderer('read', ReadToolRenderer as unknown as Component)
  registerToolRenderer('write', WriteToolRenderer as unknown as Component)
  registerToolRenderer('__default__', DefaultToolRenderer as unknown as Component)
  registerToolRenderer('subagent', SubagentRenderer as unknown as Component)
  registerToolRenderer('goal_manager', RenderDescriptor as unknown as Component)
  registerToolRenderer('todo', RenderDescriptor as unknown as Component)
}
