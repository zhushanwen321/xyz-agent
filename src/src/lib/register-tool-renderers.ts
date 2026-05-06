import { registerToolRenderer } from './tool-renderer-registry'
import type { Component } from 'vue'
import BashToolRenderer from '../components/chat/ToolRenderers/BashToolRenderer.vue'
import EditToolRenderer from '../components/chat/ToolRenderers/EditToolRenderer.vue'
import ReadToolRenderer from '../components/chat/ToolRenderers/ReadToolRenderer.vue'
import DefaultToolRenderer from '../components/chat/ToolRenderers/DefaultToolRenderer.vue'

export function registerBuiltinToolRenderers(): void {
  registerToolRenderer('bash', BashToolRenderer as unknown as Component)
  registerToolRenderer('edit', EditToolRenderer as unknown as Component)
  registerToolRenderer('read', ReadToolRenderer as unknown as Component)
  registerToolRenderer('write', DefaultToolRenderer as unknown as Component)
  registerToolRenderer('__default__', DefaultToolRenderer as unknown as Component)
}
