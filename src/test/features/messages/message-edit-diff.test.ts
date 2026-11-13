import { describe, expect, it } from 'vitest'
import {
  formatMessageEditDiff,
  formatMessageEditHistory,
  hasMessageEditDeletion
} from '../../../features/messages/edit-diff.js'

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
    ['a😀c', 'a🥲c', 'a~~😀~~🥲c'],
    ['hello\nworld', '', '~~hello world~~']
  ])('%s → %s', (before, after, expected) => {
    expect(formatMessageEditDiff(before, after)).toBe(expected)
  })
  it('escapes user markdown without escaping generated strikethrough', () => {
    expect(formatMessageEditDiff('a*b', 'a*c')).toBe('a\\*~~b~~c')
    expect(formatMessageEditDiff('a*b', 'ab')).toBe('a~~\\*~~b')
    expect(formatMessageEditDiff('~~', '')).toBe('~~\\~\\~~~')
  })
  it('merges consecutive edits into one sentence rather than listing versions', () => {
    expect(
      formatMessageEditHistory([{ content: 'ab' }, { content: 'ac' }, { content: 'ad' }])
    ).toBe('a~~bc~~d')
  })
  it('handles unknown originals and empty text', () => {
    expect(formatMessageEditHistory([{ content: 'known' }])).toBe('')
    expect(formatMessageEditHistory([{ content: '' }])).toBe('')
    expect(
      formatMessageEditHistory([{ content: 'a' }, { content: 'ab' }, { content: 'abc' }])
    ).toBe('')
  })
  it('merges emoji replacements without splitting code points', () => {
    expect(
      formatMessageEditHistory([{ content: 'a😀c' }, { content: 'a🥲c' }, { content: 'a🙃c' }])
    ).toBe('a~~😀🥲~~🙃c')
  })
  it('keeps the live text identical to the latest version after several edits', () => {
    const sequences = [
      ['abc', 'ac', 'xac', 'xyac', 'xyc'],
      ['abc', '', 'xy', 'zxy', 'zy'],
      ['ababa', 'aba', 'baba', 'bbba', 'ba'],
      ['hello world', 'hello friend', 'hey friend', 'hey']
    ]
    for (const sequence of sequences) {
      const result = formatMessageEditHistory(sequence.map((content) => ({ content })))
      expect(result.replace(/~~.*?~~/g, '')).toBe(sequence.at(-1))
    }
  })
  it('preserves additions and previous deletions in one sentence', () => {
    expect(
      formatMessageEditHistory([
        { content: 'ab' },
        { content: 'abc' },
        { content: 'ac' },
        { content: 'acd' }
      ])
    ).toBe('a~~b~~cd')
  })
  it('keeps unchanged context and separate deletions in their original positions', () => {
    expect(
      formatMessageEditHistory([{ content: 'abcde' }, { content: 'aXcdY' }, { content: 'aXcY!' }])
    ).toBe('a~~b~~Xc~~de~~Y!')
  })
  it('keeps previous deletions when text is reintroduced or the message becomes empty', () => {
    expect(formatMessageEditHistory([{ content: 'a' }, { content: 'b' }, { content: 'a' }])).toBe(
      '~~ab~~a'
    )
    expect(formatMessageEditHistory([{ content: 'abc' }, { content: 'ac' }, { content: '' }])).toBe(
      '~~abc~~'
    )
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
    expect(output).not.toContain(' ')
  })
})
