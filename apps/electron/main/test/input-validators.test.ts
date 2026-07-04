import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { isValidExternalUrl, isPathInAllowedPrefixes } from '../gateway/input-validators.js'

describe('isValidExternalUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isValidExternalUrl('http://example.com')).toBe(true)
    expect(isValidExternalUrl('https://example.com/path?q=1')).toBe(true)
  })

  it('accepts mixed-case protocol (case-insensitive)', () => {
    expect(isValidExternalUrl('HTTPS://example.com')).toBe(true)
    expect(isValidExternalUrl('HtTp://example.com')).toBe(true)
  })

  it('rejects dangerous protocols', () => {
    expect(isValidExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isValidExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isValidExternalUrl('data:text/html,<script>1</script>')).toBe(false)
  })

  it('rejects protocol-relative and bare strings', () => {
    expect(isValidExternalUrl('//example.com')).toBe(false)
    expect(isValidExternalUrl('example.com')).toBe(false)
    expect(isValidExternalUrl('')).toBe(false)
  })
})

describe('isPathInAllowedPrefixes', () => {
  // 按文档契约：allowedPrefixes 须带 trailing path.sep
  const allowed = [path.join('/tmp', 'allowed') + path.sep]
  const base = path.join('/tmp', 'allowed')

  it('allows file inside allowed dir', () => {
    expect(isPathInAllowedPrefixes(path.join(base, 'foo.txt'), allowed)).toBe(true)
    expect(isPathInAllowedPrefixes(path.join(base, 'sub', 'bar.txt'), allowed)).toBe(true)
  })

  it('allows the allowed dir itself (exact dir match)', () => {
    // resolved === '/tmp/allowed' → resolved + sep === '/tmp/allowed/'
    expect(isPathInAllowedPrefixes(base, allowed)).toBe(true)
  })

  it('rejects sibling dir outside allowed', () => {
    expect(isPathInAllowedPrefixes(path.join('/tmp', 'other', 'x.txt'), allowed)).toBe(false)
    expect(isPathInAllowedPrefixes('/tmp/secret', allowed)).toBe(false)
  })

  it('neutralizes ../ directory traversal via path.resolve', () => {
    // /tmp/allowed/../secret → resolve → /tmp/secret → not under allowed
    expect(isPathInAllowedPrefixes(path.join(base, '..', 'secret'), allowed)).toBe(false)
    expect(isPathInAllowedPrefixes(`${base}/../../../../etc/passwd`, allowed)).toBe(false)
  })

  it('prevents trailing-sep prefix false match (foo vs foobar)', () => {
    // /tmp/allowed-sibling must NOT match prefix /tmp/allowed/
    expect(isPathInAllowedPrefixes(path.join('/tmp', 'allowedbar', 'x'), allowed)).toBe(false)
    expect(isPathInAllowedPrefixes('/tmp/allowed-extension', allowed)).toBe(false)
  })

  it('returns false when no prefixes provided', () => {
    expect(isPathInAllowedPrefixes('/tmp/allowed/foo.txt', [])).toBe(false)
  })

  it('matches against any of multiple prefixes', () => {
    const multi = [
      path.join('/tmp', 'a') + path.sep,
      path.join('/tmp', 'b') + path.sep,
    ]
    expect(isPathInAllowedPrefixes(path.join('/tmp', 'b', 'x'), multi)).toBe(true)
    expect(isPathInAllowedPrefixes(path.join('/tmp', 'c', 'x'), multi)).toBe(false)
  })
})
