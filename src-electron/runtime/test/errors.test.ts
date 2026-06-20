import { describe, it, expect } from 'vitest'
import { toErrorMessage, isEnoent } from '../src/utils/errors.js'

describe('toErrorMessage', () => {
  it('extracts .message from an Error', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('stringifies a non-Error thrown value', () => {
    expect(toErrorMessage('plain string')).toBe('plain string')
    expect(toErrorMessage(42)).toBe('42')
    expect(toErrorMessage(null)).toBe('null')
    expect(toErrorMessage(undefined)).toBe('undefined')
  })

  it('stringifies an object (no [object Object] ambiguity for arrays)', () => {
    expect(toErrorMessage([1, 2])).toBe('1,2')
  })

  it('handles subclass of Error', () => {
    class MyError extends Error {
      constructor(msg: string) { super(msg); this.name = 'MyError' }
    }
    expect(toErrorMessage(new MyError('sub'))).toBe('sub')
  })

  it('returns the message even when .message is empty', () => {
    expect(toErrorMessage(new Error(''))).toBe('')
  })
})

describe('isEnoent', () => {
  it('returns true for an error with code ENOENT', () => {
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' })
    expect(isEnoent(err)).toBe(true)
  })

  it('returns false for an error with a different code', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    expect(isEnoent(err)).toBe(false)
  })

  it('returns false for a plain Error without a code', () => {
    expect(isEnoent(new Error('no code'))).toBe(false)
  })

  it('returns false for non-object values', () => {
    expect(isEnoent(null)).toBe(false)
    expect(isEnoent(undefined)).toBe(false)
    expect(isEnoent('ENOENT')).toBe(false)
    expect(isEnoent(42)).toBe(false)
  })

  it('returns false for an object without a code property', () => {
    expect(isEnoent({ message: 'x' })).toBe(false)
  })

  it('returns false for an object whose code is a non-matching string', () => {
    expect(isEnoent({ code: 'ENOTDIR' })).toBe(false)
  })

  it('returns true for a plain object with code ENOENT (duck-typed)', () => {
    // NodeJS.ErrnoException is structural — a plain object with code works
    expect(isEnoent({ code: 'ENOENT' })).toBe(true)
  })
})
