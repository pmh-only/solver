import { describe, expect, it } from 'vitest'
import {
  compileArchiveQuery,
  matchArchiveQuery,
  messageSearchParts,
  parseArchiveQuery,
  prepareArchiveSearch
} from '../archive-search-query.js'

function matches(query: string, content: string, extra = {}) {
  return (
    matchArchiveQuery(parseArchiveQuery(query), messageSearchParts({ content, ...extra })) !== null
  )
}
describe('deterministic full-text query language', () => {
  it.each([
    ['cat dog', 'cat and dog', true],
    ['cat dog', 'cat only', false],
    ['cat OR dog AND bird', 'cat', true],
    ['cat OR dog AND bird', 'dog', false],
    ['(cat OR dog) AND bird', 'cat', false],
    ['(cat OR dog) AND bird', 'dog bird', true],
    ['cat && !dog', 'cat', true],
    ['cat -dog', 'cat dog', false],
    ['cat NOT dog', 'cat', true],
    ['cat and dog', 'CAT DOG', true],
    ['cat || dog', 'dog', true],
    ['NOT NOT cat', 'cat', true],
    ['cat OR +dog', 'cat', false],
    ['cat OR +dog', 'dog', true],
    ['cat OR "must have"', 'cat', false],
    ['cat OR "must have"', 'must have', true],
    ['"foo bar"', 'foo other bar', false],
    ['"foo bar"', 'FOO BAR', true],
    ['cat -"bad dog"', 'cat good dog', true],
    ['cat -"bad dog"', 'cat bad dog', false],
    ['"say \\"hi\\""', 'say "hi"', true],
    ['고양*', '고양이', true],
    ['고양?', '고양이', true],
    ['고양?', '고양이들', false],
    ['*cat*', 'bobcat', true],
    ['=cat', 'bobcat', false],
    ['=cat', 'cat', true],
    ['바나냐~', '바나나', true],
    ['bananna~1', 'banana', true],
    ['kitten~1', 'sitting', false],
    ['kitten~2', 'sitten', true],
    ['"바나냐~1"', '바나나', false],
    ['"a*b"', 'a*b', true],
    ['"OR"', 'or', true],
    ['\\OR', 'or', true],
    ['100%_', '100%_literal', true]
  ])('%s against %s => %s', (query, content, expected) => {
    expect(matches(query, content)).toBe(expected)
  })

  it('searches values across content, embeds, authors, filenames, components and forwarded messages', () => {
    const parts = messageSearchParts({
      content: 'cat',
      embeds: [{ title: 'dog' }],
      author: { username: 'alice' },
      attachments: [{ filename: 'report.pdf' }],
      components: [{ label: 'button' }],
      message_snapshots: [{ message: { content: 'forwarded' } }],
      token: 'secret'
    })
    expect(
      matchArchiveQuery(
        parseArchiveQuery('cat AND dog AND alice AND report.pdf AND button AND forwarded'),
        parts
      )
    ).not.toBeNull()
    expect(matchArchiveQuery(parseArchiveQuery('secret'), parts)).toBeNull()
    expect(matchArchiveQuery(parseArchiveQuery('username'), parts)).toBeNull()
    expect(matchArchiveQuery(parseArchiveQuery('"cat dog"'), parts)).toBeNull()
  })
  it.each([
    '',
    '""',
    '"unclosed',
    'cat OR',
    'AND cat',
    'cat AND OR dog',
    '()',
    '(cat',
    'cat)',
    'NOT cat',
    '-cat',
    '*',
    'a?',
    'cat~3',
    'a~1',
    'cat~99',
    '+(cat)',
    '"bad\\q"',
    '('.repeat(10) + 'cat' + ')'.repeat(10),
    Array(25).fill('cat').join(' '),
    'x'.repeat(4001)
  ])('rejects malformed or resource-excessive query %s', (query) => {
    expect(() => parseArchiveQuery(query)).toThrow()
  })
  it('only emits controlled SQL and puts all untrusted values in parameters', () => {
    const source = '"\' OR true --" OR banana~1'
    const compiled = compileArchiveQuery(parseArchiveQuery(source))
    expect(compiled.columns).not.toContain("' OR true --")
    expect(compiled.params).toContain("' or true --")
    expect(compiled.predicate).toContain('AND q0')
  })
  it('prepares all-field queries without OpenAI or changing their meaning', async () => {
    expect(await prepareArchiveSearch('cat OR "dog"')).toEqual({
      keyword: 'cat OR "dog"',
      scope: 'all'
    })
  })
  it('keeps bounded fuzzy evaluation equivalent to character-based edit distance', () => {
    expect(matches(`${'𝔘'.repeat(32)}~2`, '𝔘'.repeat(34))).toBe(true)
    const words = [
      'aa',
      'ab',
      'abc',
      'abcde',
      '가나',
      '가나다',
      '나다',
      '바나나',
      '바나냐',
      'bananna',
      'banana'
    ]
    for (const a of words)
      for (const b of words)
        for (const distance of [1, 2]) {
          const x = [...a],
            y = [...b]
          const rows = Array.from({ length: x.length + 1 }, (_, i) =>
            Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
          )
          for (let i = 1; i <= x.length; i++)
            for (let j = 1; j <= y.length; j++)
              rows[i]![j] = Math.min(
                rows[i - 1]![j]! + 1,
                rows[i]![j - 1]! + 1,
                rows[i - 1]![j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1)
              )
          expect(matches(`${a}~${distance}`, b)).toBe(rows[x.length]![y.length]! <= distance)
        }
  })
})
