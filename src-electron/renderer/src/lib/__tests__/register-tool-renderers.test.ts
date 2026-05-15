import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Interface-level tests for register-tool-renderers.ts
 *
 * Tests the registration contract: calling registerBuiltinToolRenderers()
 * populates the tool-renderer-registry with expected component mappings,
 * including the 'subagent' tool name.
 */

// ── Clear module state between tests ──────────────────────────────
// The registry uses a module-level Map, so we need to isolate via vi.resetModules

describe('registerBuiltinToolRenderers — registration interface', () => {
  let registry: typeof import('../tool-renderer-registry')
  let registerBuiltin: () => void

  beforeEach(async () => {
  vi.resetModules()
  registry = await import('../tool-renderer-registry')
  const mod = await import('../register-tool-renderers')
  registerBuiltin = mod.registerBuiltinToolRenderers
  })

  it('should register "subagent" tool name and return SubagentRenderer component', async () => {
  registerBuiltin()

  const renderer = registry.getToolRenderer('subagent')
  expect(renderer, 'subagent tool must be registered after init').toBeDefined()
  })

  it('should register all built-in tool names', async () => {
  registerBuiltin()

  const names = registry.getRegisteredToolNames()
  expect(names, 'should include bash').toContain('bash')
  expect(names, 'should include edit').toContain('edit')
  expect(names, 'should include read').toContain('read')
  expect(names, 'should include write').toContain('write')
  expect(names, 'should include __default__').toContain('__default__')
  expect(names, 'should include subagent').toContain('subagent')
  })

  it('should return undefined for unknown tool name', async () => {
  registerBuiltin()

  const renderer = registry.getToolRenderer('nonexistent-tool')
  expect(renderer, 'unknown tool should return undefined').toBeUndefined()
  })

  it('should return __default__ fallback renderer for __default__ key', async () => {
  registerBuiltin()

  const fallback = registry.getToolRenderer('__default__')
  expect(fallback, '__default__ must always be registered').toBeDefined()
  })

  it('should not duplicate registrations when called twice', async () => {
  registerBuiltin()
  registerBuiltin()

  const names = registry.getRegisteredToolNames()
  // Map.set overwrites existing keys, so no duplicates
  const subagentCount = names.filter(n => n === 'subagent').length
  expect(subagentCount, 'subagent should appear exactly once').toBe(1)
  })

  it('should overwrite if the same tool name is re-registered', async () => {
  registerBuiltin()

  // Manually register a dummy component under 'subagent'
  const dummyComponent = { template: '<div>dummy</div>' }
  registry.registerToolRenderer('subagent', dummyComponent as never)

  const renderer = registry.getToolRenderer('subagent')
  // The last registration wins
  expect(renderer).toBe(dummyComponent)
  })

  it('should return distinct components for different tool names', async () => {
  registerBuiltin()

  const bashRenderer = registry.getToolRenderer('bash')
  const subagentRenderer = registry.getToolRenderer('subagent')
  const defaultRenderer = registry.getToolRenderer('__default__')

  expect(bashRenderer).not.toBe(subagentRenderer)
  expect(bashRenderer).not.toBe(defaultRenderer)
  expect(subagentRenderer).not.toBe(defaultRenderer)
  })
})
