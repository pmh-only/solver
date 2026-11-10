import { describe, expect, it } from 'vitest'
import {
  formatMessageEditDiff,
  formatMessageEditHistory,
  hasMessageEditDeletion
} from '../message-edit-diff.js'

describe('deleted text detection', () => {
  it.each([
    ['ac', 'abcd', false],
    ['abc', 'prefix abc suffix', false],
    ['', 'new', false],
    ['same', 'same', false],
    ['a😀c', 'a😀bc', false],
    ['abc', 'ac', true],
    ['ab', 'ac', true],
    ['abc', '', true],
    ['abc', 'bac', true],
    ['a😀c', 'a🥲c', true],
    ['a'.repeat(4000), 'a'.repeat(3999), true]
  ])('%s → %s: %s', (before, after, expected) => {
    expect(hasMessageEditDeletion(before, after)).toBe(expected)
  })
})

describe('deleted-only edit diffs', () => {
  it.each([
    ['ab', 'ac', '~~b~~'],
    ['abc', 'ac', '~~b~~'],
    ['ac', 'abc', ''],
    ['수정 전', '수정 후', '~~전~~'],
    ['abcde', 'aXcdY', '~~b~~ ~~e~~'],
    ['hello', '', '~~hello~~'],
    ['', 'hello', ''],
    ['same', 'same', ''],
    ['a😀c', 'a🥲c', '~~😀~~'],
    ['hello\nworld', '', '~~hello world~~']
  ])('%s → %s', (before, after, expected) => {
    expect(formatMessageEditDiff(before, after)).toBe(expected)
  })
  it('escapes user markdown without escaping generated strikethrough', () => {
    expect(formatMessageEditDiff('a*b', 'a*c')).toBe('~~b~~')
    expect(formatMessageEditDiff('a*b', 'ab')).toBe('~~\\*~~')
    expect(formatMessageEditDiff('~~', '')).toBe('~~\\~\\~~~')
  })
  it('shows only removed text from consecutive edits on one line', () => {
    expect(
      formatMessageEditHistory([{ content: 'ab' }, { content: 'ac' }, { content: 'ad' }])
    ).toBe('~~b~~ ~~c~~')
  })
  it('handles unknown originals and empty text', () => {
    expect(formatMessageEditHistory([{ content: 'known' }])).toBe('')
    expect(formatMessageEditHistory([{ content: '' }])).toBe('')
  })
  it('omits insertion-only transitions without leaving extra separators', () => {
    expect(
      formatMessageEditHistory([
        { content: 'ab' },
        { content: 'abc' },
        { content: 'ac' },
        { content: 'acd' }
      ])
    ).toBe('~~b~~')
  })
  it('bounds large rewrites and closes truncated strikethrough', () => {
    const output = formatMessageEditDiff('a'.repeat(4000), 'b'.repeat(4000), 100)
    expect(output).toHaveLength(100)
    expect(output).toBe(`~~${'a'.repeat(95)}~~…`)
  })
  it('keeps all retained transitions within the Discord text limit', () => {
    const output = formatMessageEditHistory(
      Array.from({ length: 10 }, (_, i) => ({ content: String(i).repeat(4000) }))
    )
    expect(output.length).toBeLessThanOrEqual(3900)
    expect(output).not.toContain('\n')
    expect(output.split(' ')).toHaveLength(9)
  })
})
