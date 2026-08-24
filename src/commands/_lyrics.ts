import type { JSONValue } from '@strands-agents/sdk'
import { callAgentMcpTool } from '../agent/mcp-runtime.js'

const LRCLIB_ORIGIN = 'https://lrclib.net'
const SYNCLRC_ORIGIN = 'https://api.synclrc.dev'
const LRCAPI_ORIGIN = 'https://api.lrc.cx'
const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 512 * 1024

export type LyricsSource = 'LRCLIB' | 'SyncLRC' | 'LrcApi'

export interface SpotifyCurrentTrack {
  id: string
  uri: string
  name: string
  artists: string
  album: string
  durationSeconds: number
  progressSeconds: number
  isPlaying: boolean
  imageUrl?: string
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
  source?: LyricsSource
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

function spotifyImageUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 2_048) return undefined
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.hostname !== 'i.scdn.co' && !url.hostname.endsWith('.scdn.co'))
    ) {
      return undefined
    }
    return url.href
  } catch {
    return undefined
  }
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
  const imageUrl = spotifyImageUrl(
    lines.find((line) => line.startsWith('Art: '))?.slice('Art: '.length)
  )
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
    isPlaying: status[1] === 'playing',
    ...(imageUrl ? { imageUrl } : {})
  }
}

async function readBoundedBytes(response: Response, provider: LyricsSource): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error(`${provider} returned too much data`)
  }
  if (!response.body) throw new Error(`${provider} returned an empty response`)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error(`${provider} returned too much data`)
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

  return bytes
}

async function readBoundedJson(response: Response, provider: LyricsSource): Promise<unknown> {
  const bytes = await readBoundedBytes(response, provider)
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error(`${provider} returned invalid JSON`)
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

function identity(value: string): string {
  return normalized(value).replace(/[\p{P}\p{S}\s]+/gu, '')
}

function exactMetadataMatch(
  track: SpotifyCurrentTrack,
  candidate: { track: unknown; artist: unknown; album: unknown; duration?: unknown },
  requireDuration: boolean
): boolean {
  if (
    typeof candidate.track !== 'string' ||
    typeof candidate.artist !== 'string' ||
    typeof candidate.album !== 'string' ||
    identity(candidate.track) !== identity(track.name) ||
    identity(candidate.artist) !== identity(track.artists) ||
    identity(candidate.album) !== identity(track.album)
  ) {
    return false
  }
  if (!requireDuration) return true
  return (
    typeof candidate.duration === 'number' &&
    Number.isFinite(candidate.duration) &&
    Math.abs(candidate.duration - track.durationSeconds) <= 3
  )
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
  return { status: response.status, data: await readBoundedJson(response, 'LRCLIB') }
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

function fallbackMatch(
  track: SpotifyCurrentTrack,
  syncedLyrics: string | null,
  source: Exclude<LyricsSource, 'LRCLIB'>,
  instrumental = false
): LrcLibTrack {
  return {
    id: 0,
    trackName: track.name,
    artistName: track.artists,
    albumName: track.album,
    duration: track.durationSeconds,
    instrumental,
    plainLyrics: syncedLyrics ? plainFromSynced(syncedLyrics) : null,
    syncedLyrics,
    source
  }
}

async function findSyncLrcLyrics(track: SpotifyCurrentTrack): Promise<LrcLibTrack | null> {
  const url = new URL('/lyrics', SYNCLRC_ORIGIN)
  url.searchParams.set('track', track.name)
  url.searchParams.set('artist', track.artists)
  url.searchParams.set('album', track.album)
  url.searchParams.set('duration', String(track.durationSeconds))
  url.searchParams.set('type', 'synced')
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'solver/1.0.0' },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`SyncLRC request failed (${response.status})`)

  const data = await readBoundedJson(response, 'SyncLRC')
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('SyncLRC returned invalid lyrics data')
  }
  const record = data as Record<string, unknown>
  if (
    !exactMetadataMatch(
      track,
      {
        track: record.track,
        artist: record.artist,
        album: record.album,
        duration: record.duration
      },
      true
    )
  ) {
    return null
  }
  if (record.instrumental === true) return fallbackMatch(track, null, 'SyncLRC', true)
  const syncedLyrics = typeof record.lyrics === 'string' ? record.lyrics.trim() : ''
  if (!syncedLyrics || !/^\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\]/m.test(syncedLyrics)) {
    throw new Error('SyncLRC returned invalid synchronized lyrics')
  }
  return fallbackMatch(track, syncedLyrics, 'SyncLRC')
}

async function findLrcApiLyrics(track: SpotifyCurrentTrack): Promise<LrcLibTrack | null> {
  const url = new URL('/jsonapi', LRCAPI_ORIGIN)
  url.searchParams.set('title', track.name)
  url.searchParams.set('artist', track.artists)
  url.searchParams.set('album', track.album)
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'solver/1.0.0' },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`LrcApi request failed (${response.status})`)

  const data = await readBoundedJson(response, 'LrcApi')
  if (!Array.isArray(data)) throw new Error('LrcApi returned invalid lyrics data')
  for (const value of data) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    if (
      !exactMetadataMatch(
        track,
        { track: record.title, artist: record.artist, album: record.album },
        false
      )
    ) {
      continue
    }
    const syncedLyrics = typeof record.lyrics === 'string' ? record.lyrics.trim() : ''
    if (/^\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\]/m.test(syncedLyrics)) {
      return fallbackMatch(track, syncedLyrics, 'LrcApi')
    }
  }
  return null
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
  let primaryError: unknown
  let match: LrcLibTrack | null = null
  try {
    match = await findLyrics(track)
    if (match) match.source = 'LRCLIB'
  } catch (error) {
    primaryError = error
  }

  if (!match?.instrumental && !match?.syncedLyrics?.trim()) {
    for (const fallback of [findSyncLrcLyrics, findLrcApiLyrics]) {
      try {
        const fallbackMatch = await fallback(track)
        if (fallbackMatch) {
          match = fallbackMatch
          break
        }
      } catch {
        // Continue through independent providers before surfacing the primary failure.
      }
    }
  }

  if (!match && primaryError) throw primaryError
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
