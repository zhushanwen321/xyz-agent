import { describe, it, expect, vi } from 'vitest'
import { parseArgs, formatProviders, formatDefaultModel } from '../commands.js'

describe('parseArgs', () => {
  it('parses --provider and --model flags', () => {
    const args = parseArgs(['set-default-model', '--provider', 'openai', '--model', 'gpt-4o'])
    expect(args.command).toBe('set-default-model')
    expect(args.flags.provider).toBe('openai')
    expect(args.flags.model).toBe('gpt-4o')
  })

  it('returns list-providers for no args', () => {
    const args = parseArgs(['list-providers'])
    expect(args.command).toBe('list-providers')
  })

  it('detects --json flag', () => {
    const args = parseArgs(['list-providers', '--json'])
    expect(args.flags.json).toBe(true)
  })
})

describe('formatProviders', () => {
  it('formats provider list as human-readable table', () => {
    const providers = [
      { id: 'openai', name: 'OpenAI', apiKeySet: true, models: [{ id: 'gpt-4o' }] }
    ]
    const output = formatProviders(providers)
    expect(output).toContain('openai')
    expect(output).toContain('gpt-4o')
    expect(output).not.toContain('apiKey') // must not expose key
  })

  it('outputs JSON when --json flag', () => {
    const providers = [{ id: 'openai', apiKeySet: true }]
    const output = formatProviders(providers, { json: true })
    expect(JSON.parse(output)).toEqual(providers)
  })
})

describe('formatDefaultModel', () => {
  it('formats as provider/modelId', () => {
    expect(formatDefaultModel('openai', 'gpt-4o')).toBe('openai/gpt-4o')
  })
})
