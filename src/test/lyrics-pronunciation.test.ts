import { describe, expect, it } from 'vitest'

import { addKoreanPronunciations, hiraganaToKorean } from '../commands/lyrics-pronunciation.js'

describe('Japanese lyrics pronunciation', () => {
  it('maps hiragana, combined kana, long vowels, and final consonants to Hangul', () => {
    expect(hiraganaToKorean('きゃくせん')).toBe('캬쿠센')
    expect(hiraganaToKorean('がっこう')).toBe('각코우')
    expect(hiraganaToKorean('きぼー')).toBe('키보오')
  })

  it('uses Japanese token pronunciation for kanji and particles', async () => {
    await expect(addKoreanPronunciations([{ timeMs: 0, text: '君の名は希望' }])).resolves.toEqual([
      { timeMs: 0, text: '君の名は希望', pronunciation: '키미노나와키보오' }
    ])
  })

  it('leaves non-Japanese lyrics unchanged', async () => {
    const lines = [{ timeMs: 0, text: 'Never gonna give you up' }]
    await expect(addKoreanPronunciations(lines)).resolves.toBe(lines)
  })
})
