import { describe, expect, it, vi } from 'vitest'

import {
  addKoreanPronunciations,
  hiraganaToKorean,
  romajiToHiragana
} from '../commands/lyrics-pronunciation.js'
import { parseVocaloidLyricsRows } from '../commands/vocaloid-lyrics-wiki.js'

const track = {
  id: 'track1',
  uri: 'spotify:track:track1',
  name: '知らないジュース',
  artists: 'Amami Ruri',
  album: 'Test Album',
  durationSeconds: 180,
  progressSeconds: 0,
  isPlaying: true
}

function wikiFetcher(wikitext: string, title = '知らないジュース (Shiranai Juice)'): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.searchParams.get('action') === 'query') {
      return new Response(
        JSON.stringify({
          query: {
            search: [{ pageid: 42, title }]
          }
        })
      )
    }
    return new Response(JSON.stringify({ parse: { wikitext } }))
  }) as typeof fetch
}

describe('Japanese lyrics pronunciation', () => {
  it('maps hiragana, combined kana, long vowels, and final consonants to Hangul', () => {
    expect(hiraganaToKorean('きゃくせん')).toBe('캬쿠센')
    expect(hiraganaToKorean('がっこう')).toBe('각코우')
    expect(hiraganaToKorean('きぼー')).toBe('키보오')
  })

  it('converts modified Hepburn romaji to hiragana', () => {
    expect(romajiToHiragana("gakkou de shin'you shite")).toBe('がっこう で しんよう して')
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

  it('parses Japanese and romaji columns from wiki lyrics tables', () => {
    expect(
      parseVocaloidLyricsRows(`
==Lyrics==
{{lyrics toggle|jp:Japanese|rom:Romaji|eng:English}}
{| {{lyrics table class}}
|-
|休み時間に一人
|yasumi jikan ni hitori
|Alone during break
|-
|名前も知らないジュースを
|namae mo shiranai juusu o
|A juice whose name I don't know
|}
==External Links==`)
    ).toEqual([
      { japanese: '休み時間に一人', romaji: 'yasumi jikan ni hitori' },
      { japanese: '名前も知らないジュースを', romaji: 'namae mo shiranai juusu o' }
    ])
  })

  it('prefers matched wiki romaji and locally analyzes unmatched lines', async () => {
    const source = `
==Lyrics==
{{lyrics toggle|jp:Japanese|rom:Romaji}}
{| {{lyrics table class}}
|-
|休み時間に一人
|yasumi jikan ni hitori
|}
==External Links==`

    await expect(
      addKoreanPronunciations(
        [
          { timeMs: 0, text: '休み時間に一人' },
          { timeMs: 2_000, text: '君の名は希望' }
        ],
        track,
        wikiFetcher(source)
      )
    ).resolves.toEqual([
      {
        timeMs: 0,
        text: '休み時間に一人',
        pronunciation: '야스미 지칸 니 히토리',
        pronunciationSource:
          'https://vocaloidlyrics.miraheze.org/wiki/%E7%9F%A5%E3%82%89%E3%81%AA%E3%81%84%E3%82%B8%E3%83%A5%E3%83%BC%E3%82%B9_(Shiranai_Juice)'
      },
      { timeMs: 2_000, text: '君の名は希望', pronunciation: '키미노나와키보오' }
    ])
  })

  it('extracts a reviewed reading when LRCLIB splits part of a larger wiki row', async () => {
    const source = `
==Lyrics==
{{lyrics toggle|jp:Japanese|rom:Romaji}}
{| {{lyrics table class}}
|-
|一人きり　路地裏は決して急がないで
|hitorikiri rojiura wa kesshite isoganaide
|}
==External Links==`
    const lagtrain = { ...track, name: 'ラグトレイン', artists: 'inabakumori' }

    await expect(
      addKoreanPronunciations(
        [{ timeMs: 0, text: '一人きり' }],
        lagtrain,
        wikiFetcher(source, 'ラグトレイン (Lagtrain)')
      )
    ).resolves.toEqual([
      {
        timeMs: 0,
        text: '一人きり',
        pronunciation: '히토리키리',
        pronunciationSource:
          'https://vocaloidlyrics.miraheze.org/wiki/%E3%83%A9%E3%82%B0%E3%83%88%E3%83%AC%E3%82%A4%E3%83%B3_(Lagtrain)'
      }
    ])
  })

  it('falls back to local analysis when the wiki is unavailable', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch
    await expect(
      addKoreanPronunciations([{ timeMs: 0, text: '君の名は希望' }], track, fetcher)
    ).resolves.toEqual([{ timeMs: 0, text: '君の名は希望', pronunciation: '키미노나와키보오' }])
  })
})
