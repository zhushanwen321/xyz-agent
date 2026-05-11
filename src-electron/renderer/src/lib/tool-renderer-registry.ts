import { type Component } from 'vue'

const registry = new Map<string, Component>()

export function registerToolRenderer(name: string, component: Component): void {
  registry.set(name, component)
}

export function getToolRenderer(name: string): Component | undefined {
  return registry.get(name)
}

export function getRegisteredToolNames(): string[] {
  return Array.from(registry.keys())
}

// Register default renderers (added as components are built)
export function initDefaultToolRenderers(): void {
  // Default renderer for any tool without a specific renderer
  registerToolRenderer('__default__', {
    template: '<div class="tool-default"><pre>{{ output }}</pre></div>',
    props: ['output'],
  })
}
