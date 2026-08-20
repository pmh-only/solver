import { createRequire } from 'node:module'

import type { SyncedLyricLine } from './lyrics-session.js'

const JAPANESE_KANA = /[\u3040-\u30ff]/
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

export async function addKoreanPronunciations(
  lines: SyncedLyricLine[]
): Promise<SyncedLyricLine[]> {
  if (!lines.some((line) => JAPANESE_KANA.test(line.text))) return lines

  try {
    const analyzer = await getAnalyzer()
    return await Promise.all(
      lines.map(async (line) => {
        if (!/[\u3040-\u30ff\u3400-\u9fff]/.test(line.text)) return line
        const tokens = await analyzer.parse(line.text)
        const hiragana = katakanaToHiragana(
          tokens.map((token) => token.pronunciation ?? token.reading ?? token.surface_form).join('')
        )
        const pronunciation = hiraganaToKorean(hiragana)
        return pronunciation ? { ...line, pronunciation } : line
      })
    )
  } catch {
    return lines
  }
}
