import { describe, expect, it } from 'vitest'
import { streamedJsonContent } from '../agent/streaming-json.js'

describe('streamed JSON content', () => {
  it('reads an unfinished Components V2 text display', () => {
    expect(streamedJsonContent('{"components":[{"type":10,"content":"Hello, streaming wor')).toBe(
      'Hello, streaming wor'
    )
  })

  it('combines text displays nested in component containers', () => {
    expect(
      streamedJsonContent(
        '{"components":[{"type":17,"components":[{"type":10,"content":"First\\nline"},{"type":9,"components":[{"content":"Second \\"quoted\\" line","type":10}]}]}],"flags":32768}'
      )
    ).toBe('First\nline\n\nSecond "quoted" line')
  })

  it('keeps legacy top-level content and ignores unrelated nested content', () => {
    expect(streamedJsonContent('{"content":"Legacy ans')).toBe('Legacy ans')
    expect(
      streamedJsonContent(
        '{"allowed_mentions":{"content":"not visible"},"components":[{"type":2,"label":"Continue"}]}'
      )
    ).toBe('')
  })
})
