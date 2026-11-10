import { describe, expect, it } from 'vitest'
import { formatMessageEditDiff, formatMessageEditHistory } from '../message-edit-diff.js'

describe('inline edit diffs', () => {
  it.each([
    ['ab', 'ac', 'a~~b~~c'],
    ['abc', 'ac', 'a~~b~~c'],
    ['ac', 'abc', 'abc'],
    ['수정 전', '수정 후', '수정 ~~전~~후'],
    ['abcde', 'aXcdY', 'a~~b~~Xcd~~e~~Y'],
    ['hello', '', '~~hello~~'],
    ['', 'hello', 'hello'],
    ['same', 'same', 'same'],
    ['a😀c', 'a🥲c', 'a~~😀~~🥲c']
  ])('%s → %s', (before, after, expected) => {
    expect(formatMessageEditDiff(before, after)).toBe(expected)
  })
  it('escapes user markdown without escaping generated strikethrough', () => {
    expect(formatMessageEditDiff('a*b', 'a*c')).toBe('a\\*~~b~~c')
    expect(formatMessageEditDiff('~~', '')).toBe('~~\\~\\~~~')
  })
  it('shows consecutive edits without titles, dates or explanations', () => {
    expect(
      formatMessageEditHistory([{ content: 'ab' }, { content: 'ac' }, { content: 'ad' }])
    ).toBe('a~~b~~c\n\na~~c~~d')
  })
  it('handles unknown originals and empty text', () => {
    expect(formatMessageEditHistory([{ content: 'known' }])).toBe('known')
    expect(formatMessageEditHistory([{ content: '' }])).toBe('\u200b')
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
    expect(output.split('\n\n')).toHaveLength(9)
  })
})
