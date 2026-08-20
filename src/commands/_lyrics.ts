import type { JSONValue } from '@strands-agents/sdk'
import { callAgentMcpTool } from '../agent/mcp-runtime.js'

const LRCLIB_ORIGIN = 'https://lrclib.net'
const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 512 * 1024

export interface SpotifyCurrentTrack {
  id: string
  uri: string
  name: string
  artists: string
  album: string
  durationSeconds: number
  progressSeconds: number
  isPlaying: boolean
}

export interface LrcLibTrack {
  id: number
  trackName: string
  artistName: string
  albumName: string | null
  duration: number | null
  instrumental: boolean
  plainLyrics: string | null
  syncedLyrics: string | null
}

export interface CurrentTrackLyrics {
  track: SpotifyCurrentTrack
  match: LrcLibTrack | null
  lyrics: string | null
  synchronized: boolean
}

export class NoSpotifyPlaybackError extends Error {
  constructor() {
    super('No Spotify track is currently playing')
    this.name = 'NoSpotifyPlaybackError'
  }
}

export class SpotifyAuthenticationError extends Error {
  constructor() {
    super('Spotify is not authenticated; authenticate it through `/a` first')
    this.name = 'SpotifyAuthenticationError'
  }
}

function resultText(value: JSONValue): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Spotify returned an invalid playback response')
  }

  const content = value.content
  if (!Array.isArray(content)) throw new Error('Spotify returned an invalid playback response')

  const strings = content.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    return entry.type === 'text' && typeof entry.text === 'string' ? [entry.text] : []
  })
  if (strings.length === 0) throw new Error('Spotify returned an empty playback response')
  if (value.isError === true) throw new Error(strings.join('\n'))
  return strings.join('\n')
}

function parseClock(value: string): number {
  const parts = value.split(':').map(Number)
  if (parts.length !== 2 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error('Spotify returned an invalid playback duration')
  }
  return parts[0]! * 60 + parts[1]!
}

export function parseSpotifyCurrentTrack(value: JSONValue): SpotifyCurrentTrack {
  const output = resultText(value)
  if (output.trim() === 'Nothing is currently playing.') {
    throw new NoSpotifyPlaybackError()
  }

  const lines = output.split(/\r?\n/)
  const nowLine = lines[0] ?? ''
  const status = nowLine.match(/^Now (playing|paused): "/)
  const divider = nowLine.lastIndexOf('" by ')
  const album = lines.find((line) => line.startsWith('Album: '))?.slice('Album: '.length)
  const progress = lines
    .find((line) => line.startsWith('Progress: '))
    ?.match(/^Progress: (\d+:\d{2}) \/ (\d+:\d{2})$/)
  const uri = lines.find((line) => line.startsWith('URI: '))?.slice('URI: '.length)

  if (!status || divider < status[0].length || !album || !progress || !uri) {
    if (uri?.startsWith('spotify:episode:')) {
      throw new Error('The current Spotify item is not a music track')
    }
    throw new Error('Spotify returned an invalid current track')
  }

  const uriMatch = uri.match(/^spotify:track:([A-Za-z0-9]+)$/)
  if (!uriMatch) throw new Error('The current Spotify item is not a music track')

  const titleStart = status[0].length
  const name = nowLine.slice(titleStart, divider)
  const artists = nowLine.slice(divider + '" by '.length)
  if (!name || !artists) throw new Error('Spotify returned incomplete track metadata')

  return {
    id: uriMatch[1]!,
    uri,
    name,
    artists,
    album,
    progressSeconds: parseClock(progress[1]!),
    durationSeconds: parseClock(progress[2]!),
    isPlaying: status[1] === 'playing'
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('LRCLIB returned too much data')
  }
  if (!response.body) throw new Error('LRCLIB returned an empty response')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error('LRCLIB returned too much data')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error('LRCLIB returned invalid JSON')
  }
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === 'string' ? value : undefined
}

function parseLrcLibTrack(value: unknown): LrcLibTrack | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = record.id
  const trackName = nullableString(record.trackName ?? record.name)
  const artistName = nullableString(record.artistName)
  const albumName = nullableString(record.albumName)
  const duration =
    record.duration === null
      ? null
      : typeof record.duration === 'number' && Number.isFinite(record.duration)
        ? record.duration
        : undefined
  const plainLyrics = nullableString(record.plainLyrics)
  const syncedLyrics = nullableString(record.syncedLyrics)

  if (
    !Number.isSafeInteger(id) ||
    typeof trackName !== 'string' ||
    typeof artistName !== 'string' ||
    albumName === undefined ||
    duration === undefined ||
    typeof record.instrumental !== 'boolean' ||
    plainLyrics === undefined ||
    syncedLyrics === undefined
  ) {
    return null
  }

  return {
    id: id as number,
    trackName,
    artistName,
    albumName,
    duration,
    instrumental: record.instrumental,
    plainLyrics,
    syncedLyrics
  }
}

function normalized(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US')
}

function matchScore(candidate: LrcLibTrack, track: SpotifyCurrentTrack): number {
  let score = 0
  if (normalized(candidate.trackName) === normalized(track.name)) score += 100
  if (normalized(candidate.artistName) === normalized(track.artists)) score += 60
  if (candidate.albumName && normalized(candidate.albumName) === normalized(track.album))
    score += 20
  if (candidate.duration !== null) {
    const durationDifference = Math.abs(candidate.duration - track.durationSeconds)
    if (durationDifference <= 2) score += 30
    else if (durationDifference <= 10) score += 10
  }
  return score
}

async function lrclibRequest(url: URL): Promise<{ status: number; data?: unknown }> {
  const response = await fetch(url, {
    headers: { 'Lrclib-Client': 'solver/1.0.0' },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (response.status === 404) return { status: response.status }
  if (!response.ok) throw new Error(`LRCLIB request failed (${response.status})`)
  return { status: response.status, data: await readBoundedJson(response) }
}

async function findLyrics(track: SpotifyCurrentTrack): Promise<LrcLibTrack | null> {
  const exactUrl = new URL('/api/get', LRCLIB_ORIGIN)
  exactUrl.searchParams.set('track_name', track.name)
  exactUrl.searchParams.set('artist_name', track.artists)
  exactUrl.searchParams.set('album_name', track.album)
  if (track.durationSeconds >= 1 && track.durationSeconds <= 3600) {
    exactUrl.searchParams.set('duration', String(track.durationSeconds))
  }

  const exact = await lrclibRequest(exactUrl)
  if (exact.data !== undefined) {
    const parsed = parseLrcLibTrack(exact.data)
    if (!parsed) throw new Error('LRCLIB returned invalid track data')
    return parsed
  }

  const searchUrl = new URL('/api/search', LRCLIB_ORIGIN)
  searchUrl.searchParams.set('track_name', track.name)
  searchUrl.searchParams.set('artist_name', track.artists)
  searchUrl.searchParams.set('album_name', track.album)
  const search = await lrclibRequest(searchUrl)
  if (!Array.isArray(search.data)) throw new Error('LRCLIB returned invalid search data')

  const matches = search.data.flatMap((entry) => {
    const parsed = parseLrcLibTrack(entry)
    return parsed ? [parsed] : []
  })
  return (
    matches.sort((left, right) => matchScore(right, track) - matchScore(left, track))[0] ?? null
  )
}

function plainFromSynced(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[[^\]]+\]\s?/, ''))
    .join('\n')
    .trim()
}

async function getCurrentTrack(): Promise<SpotifyCurrentTrack> {
  try {
    return parseSpotifyCurrentTrack(
      await callAgentMcpTool(
        'spotify',
        'get_now_playing',
        {},
        AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      )
    )
  } catch (error) {
    if (error instanceof NoSpotifyPlaybackError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (
      /spotify MCP (?:is not configured|is unavailable)|not authenticated|token refresh failed|SPOTIFY_CLIENT_ID environment variable is not set/i.test(
        message
      )
    ) {
      throw new SpotifyAuthenticationError()
    }
    throw error
  }
}

async function getLyricsForTrack(track: SpotifyCurrentTrack): Promise<CurrentTrackLyrics> {
  const match = await findLyrics(track)
  if (!match) {
    return { track, match: null, lyrics: null, synchronized: false }
  }

  const plainLyrics = match.plainLyrics?.trim()
  const syncedLyrics = match.syncedLyrics?.trim()
  return {
    track,
    match,
    lyrics: plainLyrics || (syncedLyrics ? plainFromSynced(syncedLyrics) : null),
    synchronized: Boolean(syncedLyrics)
  }
}

async function getCurrentTrackLyrics(): Promise<CurrentTrackLyrics> {
  return getLyricsForTrack(await getCurrentTrack())
}

export const lyricsClient = {
  getCurrentTrack,
  getCurrentTrackLyrics,
  getLyricsForTrack
}
