import type { SpotifyCurrentTrack } from './_lyrics.js'
import type { SyncedLyricLine } from './lyrics-session.js'

const API_URL = 'https://vocaloidlyrics.miraheze.org/w/api.php'
const WIKI_URL = 'https://vocaloidlyrics.miraheze.org/wiki/'
const REQUEST_TIMEOUT_MS = 3_000
const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_SEARCH_RESULTS = 5

interface SearchResult {
  pageid: number
  title: string
}

interface LyricsRow {
  japanese: string
  romaji: string
}

export interface VocaloidLyricsMatch {
  pronunciations: Map<number, string>
  sourceUrl: string
}

function plainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>|<ref\b[^>]*\/>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1')
    .replace(/'{2,}/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .trim()
}

function normalizedLyrics(value: string): string {
  return plainText(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}\s]/gu, '')
}

function normalizedTitle(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\b(?:feat|ft)\.?\s+.*$/i, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/[\p{P}\p{S}\s]/gu, '')
}

function titleAliases(value: string): string[] {
  return [
    value,
    value.replace(/\s*\([^)]*\)\s*$/, ''),
    ...[...value.matchAll(/\(([^)]+)\)/g)].map((match) => match[1]!)
  ]
    .map(normalizedTitle)
    .filter(Boolean)
}

function selectSearchResult(
  results: SearchResult[],
  track: SpotifyCurrentTrack
): SearchResult | null {
  const trackAliases = new Set(titleAliases(track.name))
  const artist = normalizedTitle(track.artists)
  const candidates = results.flatMap((result, index) => {
    const aliases = titleAliases(result.title)
    if (!aliases.some((alias) => trackAliases.has(alias))) return []
    const artistBonus = artist && normalizedTitle(result.title).includes(artist) ? 10 : 0
    return [{ result, score: 100 + artistBonus - index }]
  })
  return candidates.sort((left, right) => right.score - left.score)[0]?.result ?? null
}

function tableCells(row: string): string[] {
  const lines = row.split(/\r?\n/)
  const cells: string[] = []
  for (const line of lines) {
    if (!line.startsWith('|') || line.startsWith('|}') || line.startsWith('|-')) continue
    const value = line.slice(1)
    cells.push(...value.split('||').map((cell) => cell.trim()))
  }
  return cells
}

export function parseVocaloidLyricsRows(wikitext: string): LyricsRow[] {
  const heading = wikitext.match(/^==\s*Lyrics\s*==\s*$/im)
  if (heading?.index === undefined) return []
  const afterHeading = wikitext.slice(heading.index + heading[0].length)
  const lyricsSection = afterHeading.split(/^==[^=].*==\s*$/m, 1)[0] ?? ''

  const toggle = lyricsSection.match(/\{\{lyrics toggle\|([^}]+)\}\}/i)?.[1]
  if (!toggle) return []
  const columns = toggle.split('|').map((column) => column.split(':', 1)[0]!.trim().toLowerCase())
  const japaneseIndex = columns.indexOf('jp')
  const romajiIndex = columns.indexOf('rom')
  if (japaneseIndex < 0 || romajiIndex < 0) return []

  return lyricsSection.split(/^\|-.*$/m).flatMap((row) => {
    const cells = tableCells(row)
    const japanese = plainText(cells[japaneseIndex] ?? '')
    const romaji = plainText(cells[romajiIndex] ?? '')
    return japanese && romaji && japanese !== '<br />' ? [{ japanese, romaji }] : []
  })
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('Vocaloid Lyrics Wiki returned too much data')
  }
  if (!response.body) throw new Error('Vocaloid Lyrics Wiki returned an empty response')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error('Vocaloid Lyrics Wiki returned too much data')
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

async function request(params: Record<string, string>, fetcher: typeof fetch): Promise<unknown> {
  const url = new URL(API_URL)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  url.searchParams.set('format', 'json')
  url.searchParams.set('formatversion', '2')

  const response = await fetcher(url, {
    headers: { 'User-Agent': 'solver/1.0.0' },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`Vocaloid Lyrics Wiki request failed (${response.status})`)
  return readBoundedJson(response)
}

function parseSearchResults(value: unknown): SearchResult[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const search = (value as { query?: { search?: unknown } }).query?.search
  if (!Array.isArray(search)) return []
  return search.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const { pageid, title } = entry as { pageid?: unknown; title?: unknown }
    return Number.isSafeInteger(pageid) && typeof title === 'string'
      ? [{ pageid: pageid as number, title }]
      : []
  })
}

function parsePageWikitext(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const wikitext = (value as { parse?: { wikitext?: unknown } }).parse?.wikitext
  return typeof wikitext === 'string' ? wikitext : null
}

export async function findVocaloidLyricsPronunciations(
  track: SpotifyCurrentTrack,
  lines: SyncedLyricLine[],
  toKorean: (romaji: string) => string,
  fetcher: typeof fetch = fetch
): Promise<VocaloidLyricsMatch | null> {
  const searchResults = parseSearchResults(
    await request(
      {
        action: 'query',
        list: 'search',
        srsearch: track.name,
        srnamespace: '0',
        srlimit: String(MAX_SEARCH_RESULTS)
      },
      fetcher
    )
  )
  const page = selectSearchResult(searchResults, track)
  if (!page) return null

  const wikitext = parsePageWikitext(
    await request({ action: 'parse', pageid: String(page.pageid), prop: 'wikitext' }, fetcher)
  )
  if (!wikitext) return null

  const readings = new Map(
    parseVocaloidLyricsRows(wikitext).map(({ japanese, romaji }) => [
      normalizedLyrics(japanese),
      romaji
    ])
  )
  const pronunciations = new Map<number, string>()
  lines.forEach((line, index) => {
    const romaji = readings.get(normalizedLyrics(line.text))
    if (!romaji) return
    const pronunciation = toKorean(romaji)
    if (pronunciation) pronunciations.set(index, pronunciation)
  })
  if (pronunciations.size === 0) return null

  return {
    pronunciations,
    sourceUrl: `${WIKI_URL}${encodeURIComponent(page.title.replaceAll(' ', '_'))}`
  }
}
