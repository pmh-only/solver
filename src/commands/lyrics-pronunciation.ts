import { createRequire } from 'node:module'

import type { SpotifyCurrentTrack } from './_lyrics.js'
import type { SyncedLyricLine } from './lyrics-session.js'
import { findVocaloidLyricsPronunciations } from './vocaloid-lyrics-wiki.js'

const JAPANESE_TEXT = /[\u3040-\u30ff\u3400-\u9fff]/
const LATIN_TEXT = /[A-Za-z]/
const HANGUL_BASE = 0xac00
const HANGUL_END = 0xd7a3

interface JapaneseToken {
  surface_form: string
  reading?: string
  pronunciation?: string
}

interface JapaneseAnalyzer {
  init(): Promise<void>
  parse(value: string): Promise<JapaneseToken[]>
}

const require = createRequire(import.meta.url)
const KuromojiAnalyzer = require('kuroshiro-analyzer-kuromoji') as new () => JapaneseAnalyzer

const KANA_TO_HANGUL: Record<string, string> = {
  あ: '아',
  い: '이',
  う: '우',
  え: '에',
  お: '오',
  か: '카',
  き: '키',
  く: '쿠',
  け: '케',
  こ: '코',
  が: '가',
  ぎ: '기',
  ぐ: '구',
  げ: '게',
  ご: '고',
  さ: '사',
  し: '시',
  す: '스',
  せ: '세',
  そ: '소',
  ざ: '자',
  じ: '지',
  ず: '즈',
  ぜ: '제',
  ぞ: '조',
  た: '타',
  ち: '치',
  つ: '츠',
  て: '테',
  と: '토',
  だ: '다',
  ぢ: '지',
  づ: '즈',
  で: '데',
  ど: '도',
  な: '나',
  に: '니',
  ぬ: '누',
  ね: '네',
  の: '노',
  は: '하',
  ひ: '히',
  ふ: '후',
  へ: '헤',
  ほ: '호',
  ば: '바',
  び: '비',
  ぶ: '부',
  べ: '베',
  ぼ: '보',
  ぱ: '파',
  ぴ: '피',
  ぷ: '푸',
  ぺ: '페',
  ぽ: '포',
  ま: '마',
  み: '미',
  む: '무',
  め: '메',
  も: '모',
  や: '야',
  ゆ: '유',
  よ: '요',
  ら: '라',
  り: '리',
  る: '루',
  れ: '레',
  ろ: '로',
  わ: '와',
  を: '오',
  ゔ: '부',
  きゃ: '캬',
  きゅ: '큐',
  きょ: '쿄',
  ぎゃ: '갸',
  ぎゅ: '규',
  ぎょ: '교',
  しゃ: '샤',
  しゅ: '슈',
  しょ: '쇼',
  じゃ: '자',
  じゅ: '주',
  じょ: '조',
  ちゃ: '차',
  ちゅ: '추',
  ちょ: '초',
  にゃ: '냐',
  にゅ: '뉴',
  にょ: '뇨',
  ひゃ: '햐',
  ひゅ: '휴',
  ひょ: '효',
  びゃ: '뱌',
  びゅ: '뷰',
  びょ: '뵤',
  ぴゃ: '퍄',
  ぴゅ: '퓨',
  ぴょ: '표',
  みゃ: '먀',
  みゅ: '뮤',
  みょ: '묘',
  りゃ: '랴',
  りゅ: '류',
  りょ: '료',
  しぇ: '셰',
  じぇ: '제',
  ちぇ: '체',
  てぃ: '티',
  でぃ: '디',
  ふぁ: '파',
  ふぃ: '피',
  ふぇ: '페',
  ふぉ: '포',
  うぃ: '위',
  うぇ: '웨',
  うぉ: '워',
  ゔぁ: '바',
  ゔぃ: '비',
  ゔぇ: '베',
  ゔぉ: '보'
}

const ROMAJI_TO_HIRAGANA: Record<string, string> = {
  a: 'あ',
  i: 'い',
  u: 'う',
  e: 'え',
  o: 'お',
  ka: 'か',
  ki: 'き',
  ku: 'く',
  ke: 'け',
  ko: 'こ',
  ga: 'が',
  gi: 'ぎ',
  gu: 'ぐ',
  ge: 'げ',
  go: 'ご',
  sa: 'さ',
  shi: 'し',
  si: 'し',
  su: 'す',
  se: 'せ',
  so: 'そ',
  za: 'ざ',
  ji: 'じ',
  zi: 'じ',
  zu: 'ず',
  ze: 'ぜ',
  zo: 'ぞ',
  ta: 'た',
  chi: 'ち',
  ti: 'ち',
  tsu: 'つ',
  tu: 'つ',
  te: 'て',
  to: 'と',
  da: 'だ',
  di: 'ぢ',
  du: 'づ',
  de: 'で',
  do: 'ど',
  na: 'な',
  ni: 'に',
  nu: 'ぬ',
  ne: 'ね',
  no: 'の',
  ha: 'は',
  hi: 'ひ',
  fu: 'ふ',
  hu: 'ふ',
  he: 'へ',
  ho: 'ほ',
  ba: 'ば',
  bi: 'び',
  bu: 'ぶ',
  be: 'べ',
  bo: 'ぼ',
  pa: 'ぱ',
  pi: 'ぴ',
  pu: 'ぷ',
  pe: 'ぺ',
  po: 'ぽ',
  ma: 'ま',
  mi: 'み',
  mu: 'む',
  me: 'め',
  mo: 'も',
  ya: 'や',
  yu: 'ゆ',
  yo: 'よ',
  ra: 'ら',
  ri: 'り',
  ru: 'る',
  re: 'れ',
  ro: 'ろ',
  wa: 'わ',
  wo: 'を',
  kya: 'きゃ',
  kyu: 'きゅ',
  kyo: 'きょ',
  gya: 'ぎゃ',
  gyu: 'ぎゅ',
  gyo: 'ぎょ',
  sha: 'しゃ',
  shu: 'しゅ',
  sho: 'しょ',
  sya: 'しゃ',
  syu: 'しゅ',
  syo: 'しょ',
  ja: 'じゃ',
  ju: 'じゅ',
  jo: 'じょ',
  jya: 'じゃ',
  jyu: 'じゅ',
  jyo: 'じょ',
  cha: 'ちゃ',
  chu: 'ちゅ',
  cho: 'ちょ',
  tya: 'ちゃ',
  tyu: 'ちゅ',
  tyo: 'ちょ',
  nya: 'にゃ',
  nyu: 'にゅ',
  nyo: 'にょ',
  hya: 'ひゃ',
  hyu: 'ひゅ',
  hyo: 'ひょ',
  bya: 'びゃ',
  byu: 'びゅ',
  byo: 'びょ',
  pya: 'ぴゃ',
  pyu: 'ぴゅ',
  pyo: 'ぴょ',
  mya: 'みゃ',
  myu: 'みゅ',
  myo: 'みょ',
  rya: 'りゃ',
  ryu: 'りゅ',
  ryo: 'りょ',
  she: 'しぇ',
  je: 'じぇ',
  che: 'ちぇ',
  fa: 'ふぁ',
  fi: 'ふぃ',
  fe: 'ふぇ',
  fo: 'ふぉ',
  wi: 'うぃ',
  we: 'うぇ',
  va: 'ゔぁ',
  vi: 'ゔぃ',
  vu: 'ゔ',
  ve: 'ゔぇ',
  vo: 'ゔぉ'
}

let analyzerPromise: Promise<JapaneseAnalyzer> | undefined

async function getAnalyzer(): Promise<JapaneseAnalyzer> {
  if (!analyzerPromise) {
    analyzerPromise = (async () => {
      const analyzer = new KuromojiAnalyzer()
      await analyzer.init()
      return analyzer
    })()
  }
  return analyzerPromise
}

function appendFinalConsonant(value: string, finalIndex: number): string {
  const characters = [...value]
  const last = characters.at(-1)
  if (!last) return value
  const codePoint = last.codePointAt(0)!
  if (codePoint < HANGUL_BASE || codePoint > HANGUL_END || (codePoint - HANGUL_BASE) % 28) {
    return value
  }
  characters[characters.length - 1] = String.fromCodePoint(codePoint + finalIndex)
  return characters.join('')
}

function sokuonFinal(nextKana: string): number {
  if (/^[かきくけこがぎぐげご]/.test(nextKana)) return 1
  if (/^[はひふへほばびぶべぼぱぴぷぺぽまみむめも]/.test(nextKana)) return 17
  return 19
}

function longVowel(value: string): string {
  const last = [...value].at(-1)
  if (!last) return ''
  const codePoint = last.codePointAt(0)!
  if (codePoint < HANGUL_BASE || codePoint > HANGUL_END) return ''
  const medial = Math.floor(((codePoint - HANGUL_BASE) % 588) / 28)
  if ([0, 1, 2, 3].includes(medial)) return '아'
  if ([4, 5, 6, 7].includes(medial)) return '에'
  if ([8, 9, 10, 11, 12].includes(medial)) return '오'
  if ([13, 14, 15, 16, 17].includes(medial)) return '우'
  if (medial === 18) return '으'
  return '이'
}

function katakanaToHiragana(value: string): string {
  return value.replace(/[ァ-ヶ]/g, (character) =>
    String.fromCodePoint(character.codePointAt(0)! - 0x60)
  )
}

export function hiraganaToKorean(value: string): string {
  let result = ''
  for (let index = 0; index < value.length;) {
    const pair = value.slice(index, index + 2)
    const pairReading = KANA_TO_HANGUL[pair]
    if (pairReading) {
      result += pairReading
      index += 2
      continue
    }

    const kana = value[index]!
    if (kana === 'ん') {
      const withFinal = appendFinalConsonant(result, 4)
      result = withFinal === result ? `${result}ㄴ` : withFinal
    } else if (kana === 'っ') {
      result = appendFinalConsonant(result, sokuonFinal(value[index + 1] ?? ''))
    } else if (kana === 'ー') {
      result += longVowel(result)
    } else {
      result += KANA_TO_HANGUL[kana] ?? kana
    }
    index++
  }
  return result.replace(/\s+/g, ' ').trim()
}

export function romajiToHiragana(value: string): string {
  const input = value.normalize('NFKC').toLocaleLowerCase('en-US')
  let result = ''
  for (let index = 0; index < input.length;) {
    const current = input[index]!
    const next = input[index + 1] ?? ''
    if (/[^a-z]/.test(current)) {
      result += current
      index++
      continue
    }
    if (current !== 'n' && current === next && /[bcdfghjklmpqrstvwxyz]/.test(current)) {
      result += 'っ'
      index++
      continue
    }
    if (current === 'n' && (next === "'" || !next || !/[aeiouy]/.test(next))) {
      result += 'ん'
      index += next === "'" ? 2 : 1
      continue
    }

    let matched = false
    for (const length of [3, 2, 1]) {
      const kana = ROMAJI_TO_HIRAGANA[input.slice(index, index + length)]
      if (!kana) continue
      result += kana
      index += length
      matched = true
      break
    }
    if (!matched) {
      result += current
      index++
    }
  }
  return result
}

async function japaneseToHiragana(value: string): Promise<string> {
  if (!value) return ''
  const analyzer = await getAnalyzer()
  const tokens = await analyzer.parse(value)
  return katakanaToHiragana(
    tokens.map((token) => token.pronunciation ?? token.reading ?? token.surface_form).join('')
  )
}

export async function addKoreanPronunciations(
  lines: SyncedLyricLine[],
  track?: SpotifyCurrentTrack,
  fetcher: typeof fetch = fetch
): Promise<SyncedLyricLine[]> {
  if (!lines.some((line) => JAPANESE_TEXT.test(line.text))) return lines

  let wikiMatch = null
  if (track) {
    try {
      wikiMatch = await findVocaloidLyricsPronunciations(
        track,
        lines,
        { romajiToHiragana, hiraganaToKorean, japaneseToHiragana },
        fetcher
      )
    } catch {
      // Network and wiki format failures fall back to local analysis.
    }
  }

  const sourcedLines = lines.map((line, index) => {
    const pronunciation =
      JAPANESE_TEXT.test(line.text) && !LATIN_TEXT.test(line.text)
        ? wikiMatch?.pronunciations.get(index)
        : undefined
    return pronunciation && wikiMatch
      ? { ...line, pronunciation, pronunciationSource: wikiMatch.sourceUrl }
      : line
  })
  if (sourcedLines.every((line) => line.pronunciation || !JAPANESE_TEXT.test(line.text))) {
    return sourcedLines
  }

  try {
    return await Promise.all(
      sourcedLines.map(async (line) => {
        if (line.pronunciation) return line
        if (!/[\u3040-\u30ff\u3400-\u9fff]/.test(line.text)) return line
        const hiragana = await japaneseToHiragana(line.text)
        const pronunciation = hiraganaToKorean(hiragana)
        return pronunciation ? { ...line, pronunciation } : line
      })
    )
  } catch {
    return sourcedLines
  }
}
