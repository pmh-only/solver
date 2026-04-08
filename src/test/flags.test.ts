import { describe, expect, it } from 'vitest'
import { buildAliasMap, parseFlags, resolveAliases } from '../flags.js'

describe('parseFlags', () => {
  it('returns empty flags and bare input when no flags present', () => {
    const result = parseFlags('ping 1.1.1.1')
    expect(result.bare).toBe('ping 1.1.1.1')
    expect(result.flags.size).toBe(0)
  })

  it('parses a boolean --flag', () => {
    const result = parseFlags('ping --pub')
    expect(result.bare).toBe('ping')
    expect(result.flags.get('pub')).toBe(true)
  })

  it('parses a value --flag value', () => {
    const result = parseFlags('ping --type http')
    expect(result.bare).toBe('ping')
    expect(result.flags.get('type')).toBe('http')
  })

  it('does not consume next word as value when it starts with -', () => {
    const result = parseFlags('ping --pub --type http')
    expect(result.flags.get('pub')).toBe(true)
    expect(result.flags.get('type')).toBe('http')
    expect(result.bare).toBe('ping')
  })

  it('handles multiple flags mixed with bare args', () => {
    const result = parseFlags('ping 1.1.1.1 --pub --count 5')
    expect(result.bare).toBe('ping 1.1.1.1')
    expect(result.flags.get('pub')).toBe(true)
    expect(result.flags.get('count')).toBe('5')
  })

  it('expands short -abc flags into individual booleans', () => {
    const result = parseFlags('ping -abc')
    expect(result.bare).toBe('ping')
    expect(result.flags.get('a')).toBe(true)
    expect(result.flags.get('b')).toBe(true)
    expect(result.flags.get('c')).toBe(true)
  })

  it('does not treat negative numbers as flags', () => {
    const result = parseFlags('math -1 + 2')
    expect(result.bare).toBe('math -1 + 2')
    expect(result.flags.size).toBe(0)
  })

  it('handles empty input', () => {
    const result = parseFlags('')
    expect(result.bare).toBe('')
    expect(result.flags.size).toBe(0)
  })

  it('handles flags-only input', () => {
    const result = parseFlags('--pub --verbose')
    expect(result.bare).toBe('')
    expect(result.flags.get('pub')).toBe(true)
    expect(result.flags.get('verbose')).toBe(true)
  })
})

describe('buildAliasMap', () => {
  it('maps alias char to full flag name', () => {
    const map = buildAliasMap({ count: { alias: 'c', description: 'count' } })
    expect(map.get('c')).toBe('count')
  })

  it('ignores entries without alias', () => {
    const map = buildAliasMap({ pub: { description: 'publish' } })
    expect(map.size).toBe(0)
  })

  it('handles multiple aliases', () => {
    const map = buildAliasMap({
      count: { alias: 'c', description: 'count' },
      interval: { alias: 'i', description: 'interval' }
    })
    expect(map.get('c')).toBe('count')
    expect(map.get('i')).toBe('interval')
    expect(map.size).toBe(2)
  })
})

describe('resolveAliases', () => {
  it('replaces alias keys with their full names', () => {
    const aliasMap = new Map([['c', 'count']])
    const flags = new Map<string, string | true>([
      ['c', '5'],
      ['pub', true]
    ])
    const resolved = resolveAliases(flags, aliasMap)
    expect(resolved.get('count')).toBe('5')
    expect(resolved.get('pub')).toBe(true)
    expect(resolved.has('c')).toBe(false)
  })

  it('passes through keys with no alias mapping unchanged', () => {
    const aliasMap = new Map<string, string>()
    const flags = new Map<string, string | true>([['pub', true]])
    const resolved = resolveAliases(flags, aliasMap)
    expect(resolved.get('pub')).toBe(true)
    expect(resolved.size).toBe(1)
  })
})
