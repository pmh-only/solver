import {
  lyricsClient,
  NoSpotifyPlaybackError,
  type CurrentTrackLyrics,
  type SpotifyCurrentTrack
} from './_lyrics.js'
import { deleteStoredValue, getStoredValue, setStoredValue } from '../helpers/kv-store.js'
import { addKoreanPronunciations } from './lyrics-pronunciation.js'

export const SPOTIFY_RESYNC_INTERVAL_MS = 5_000
export const MIN_LYRICS_EDIT_INTERVAL_MS = 1_250
export const EPHEMERAL_LYRICS_SESSION_MS = 14 * 60 * 1_000
export const PUBLIC_LYRICS_SESSION_MS = 6 * 60 * 60 * 1_000
export const MAX_LYRICS_OFFSET_MS = 30_000
export const MAX_DISCORD_EDIT_COMPENSATION_MS = 1_000
export const LYRICS_OFFSETS_KEY = 'lyrics-offsets'

const LYRICS_RETRY_INTERVAL_MS = 30_000
const TIMER_FLOOR_MS = 50
const SPOTIFY_PROGRESS_MIDPOINT_MS = 500
const MAX_STORED_LYRICS_OFFSETS = 500
const MAX_OFFSET_STORE_BYTES = 256 * 1_024

export interface SyncedLyricLine {
  timeMs: number
  text: string
  pronunciation?: string
  pronunciationSource?: string
}

export type LiveLyricsMode = 'lyrics' | 'idle' | 'unavailable' | 'error' | 'stopped'
export type LyricsDisplayMode = 'japanese' | 'korean-pronunciation'

export interface LiveLyricsState {
  mode: LiveLyricsMode
  track: SpotifyCurrentTrack | null
  lines: SyncedLyricLine[]
  detail: string
  anchorProgressMs: number
  anchorTimeMs: number
}

export interface LiveLyricsView extends LiveLyricsState {
  currentIndex: number
  progressMs: number
  spotifyProgressMs: number
  offsetMs: number
  stopped: boolean
  displayMode: LyricsDisplayMode
}

export interface LyricsSessionDependencies {
  now: () => number
  getCurrentTrack: () => Promise<SpotifyCurrentTrack>
  getLyricsForTrack: (track: SpotifyCurrentTrack) => Promise<CurrentTrackLyrics>
  setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  loadOffset: (trackId: string) => number
  saveOffset: (trackId: string, offsetMs: number) => void
}

export interface LiveLyricsSessionOptions {
  token: string
  ownerId: string
  isPublic: boolean
  initialState: LiveLyricsState
  renderedView: LiveLyricsView
  initialOffsetMs?: number
  initialRenderLatencyMs?: number
  startedAt?: number
  render: (view: LiveLyricsView) => Promise<void>
  onClose: () => void
  dependencies?: Partial<LyricsSessionDependencies>
}

interface StoredLyricsOffset {
  offsetMs: number
  updatedAt: number
}

function normalizedOffset(value: number): number {
  if (!Number.isFinite(value)) return 0
  const stepped = Math.round(value / 500) * 500
  return Math.max(-MAX_LYRICS_OFFSET_MS, Math.min(MAX_LYRICS_OFFSET_MS, stepped))
}

function normalizedRenderLatency(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(MAX_DISCORD_EDIT_COMPENSATION_MS, value))
}

function requestMidpoint(startedAt: number, finishedAt: number): number {
  return startedAt + Math.max(0, finishedAt - startedAt) / 2
}

function readStoredLyricsOffsets(): Map<string, StoredLyricsOffset> {
  try {
    const raw = getStoredValue(LYRICS_OFFSETS_KEY)
    if (!raw || raw.length > MAX_OFFSET_STORE_BYTES) return new Map()
    const parsed = JSON.parse(raw) as { version?: unknown; tracks?: unknown }
    if (parsed.version !== 1 || !parsed.tracks || typeof parsed.tracks !== 'object') {
      return new Map()
    }

    const offsets = new Map<string, StoredLyricsOffset>()
    for (const [trackId, value] of Object.entries(parsed.tracks)) {
      if (!/^[A-Za-z0-9]+$/.test(trackId) || !value || typeof value !== 'object') continue
      const entry = value as { offsetMs?: unknown; updatedAt?: unknown }
      if (
        typeof entry.offsetMs !== 'number' ||
        !Number.isFinite(entry.offsetMs) ||
        typeof entry.updatedAt !== 'number' ||
        !Number.isFinite(entry.updatedAt)
      ) {
        continue
      }
      const offsetMs = normalizedOffset(entry.offsetMs)
      if (offsetMs !== 0) offsets.set(trackId, { offsetMs, updatedAt: entry.updatedAt })
    }
    return offsets
  } catch {
    return new Map()
  }
}

export function loadLyricsOffset(trackId: string): number {
  if (!/^[A-Za-z0-9]+$/.test(trackId)) return 0
  return readStoredLyricsOffsets().get(trackId)?.offsetMs ?? 0
}

export function saveLyricsOffset(trackId: string, value: number): void {
  if (!/^[A-Za-z0-9]+$/.test(trackId)) return
  try {
    const offsets = readStoredLyricsOffsets()
    const offsetMs = normalizedOffset(value)
    if (offsetMs === 0) offsets.delete(trackId)
    else offsets.set(trackId, { offsetMs, updatedAt: Date.now() })

    const tracks = Object.fromEntries(
      [...offsets]
        .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_STORED_LYRICS_OFFSETS)
    )
    if (Object.keys(tracks).length === 0) deleteStoredValue(LYRICS_OFFSETS_KEY)
    else setStoredValue(LYRICS_OFFSETS_KEY, JSON.stringify({ version: 1, tracks }))
  } catch {
    // Keep the live session usable if persistent storage is temporarily unavailable.
  }
}

const defaultDependencies: LyricsSessionDependencies = {
  now: () => Date.now(),
  getCurrentTrack: () => lyricsClient.getCurrentTrack(),
  getLyricsForTrack: (track) => lyricsClient.getLyricsForTrack(track),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer),
  loadOffset: loadLyricsOffset,
  saveOffset: saveLyricsOffset
}

function fractionMilliseconds(value: string | undefined): number {
  if (!value) return 0
  return Number(value.padEnd(3, '0').slice(0, 3))
}

export function parseSyncedLyrics(value: string | null | undefined): SyncedLyricLine[] {
  if (!value) return []

  const offsetMatch = value.match(/^\[offset:([+-]?\d+)\]\s*$/im)
  const offsetMs = offsetMatch ? Number(offsetMatch[1]) : 0
  const byTimestamp = new Map<number, SyncedLyricLine>()
  for (const rawLine of value.split(/\r?\n/)) {
    const timestamps = [...rawLine.matchAll(/\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g)]
    if (timestamps.length === 0) continue

    const finalTimestamp = timestamps.at(-1)!
    const text = rawLine
      .slice((finalTimestamp.index ?? 0) + finalTimestamp[0].length)
      .replace(/<\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?>/g, '')
      .trim()

    for (const timestamp of timestamps) {
      const minutes = Number(timestamp[1])
      const seconds = Number(timestamp[2])
      const timeMs = Math.max(
        0,
        minutes * 60_000 + seconds * 1_000 + fractionMilliseconds(timestamp[3]) + offsetMs
      )
      byTimestamp.set(timeMs, { timeMs, text })
    }
  }

  return [...byTimestamp.values()].sort((left, right) => left.timeMs - right.timeMs)
}

export function groupRapidSyncedLyrics(
  lines: SyncedLyricLine[],
  minimumSpacingMs = MIN_LYRICS_EDIT_INTERVAL_MS
): SyncedLyricLine[] {
  if (lines.length < 2 || minimumSpacingMs <= 0) return lines

  const grouped: SyncedLyricLine[] = []
  for (const line of lines) {
    const current = grouped.at(-1)
    if (current && line.timeMs - current.timeMs < minimumSpacingMs) {
      current.text = `${current.text}\n${line.text}`
      if (current.pronunciation || line.pronunciation) {
        current.pronunciation = `${current.pronunciation ?? ''}\n${line.pronunciation ?? ''}`
      }
      current.pronunciationSource ??= line.pronunciationSource
    } else {
      grouped.push({ ...line })
    }
  }
  return grouped
}

export function currentSyncedLineIndex(lines: SyncedLyricLine[], progressMs: number): number {
  let low = 0
  let high = lines.length - 1
  let result = -1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (lines[middle]!.timeMs <= progressMs) {
      result = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return result
}

export function displayedLyricText(line: SyncedLyricLine, displayMode: LyricsDisplayMode): string {
  if (displayMode !== 'korean-pronunciation') return line.text
  const pronunciation = line.pronunciation?.split('\n') ?? []
  return line.text
    .split('\n')
    .map((text, index) => pronunciation[index] || text)
    .join('\n')
}

function lyricWordCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length
}

export function currentSyncedWordCount(
  lines: SyncedLyricLine[],
  currentIndex: number,
  progressMs: number,
  durationMs: number,
  displayMode: LyricsDisplayMode
): number {
  const line = lines[currentIndex]
  if (!line) return 0

  const words = Math.max(1, lyricWordCount(displayedLyricText(line, displayMode)))
  const endMs = lines[currentIndex + 1]?.timeMs ?? durationMs
  const lineDurationMs = Math.max(1, endMs - line.timeMs)
  const elapsedMs = Math.max(0, Math.min(lineDurationMs, progressMs - line.timeMs))
  return Math.min(words, Math.floor((elapsedMs / lineDurationMs) * words) + 1)
}

function nextSyncedWordProgressMs(
  lines: SyncedLyricLine[],
  currentIndex: number,
  progressMs: number,
  durationMs: number,
  displayMode: LyricsDisplayMode
): number | null {
  const line = lines[currentIndex]
  if (!line) return null

  const words = Math.max(1, lyricWordCount(displayedLyricText(line, displayMode)))
  const completedWords = currentSyncedWordCount(
    lines,
    currentIndex,
    progressMs,
    durationMs,
    displayMode
  )
  if (completedWords >= words) return null

  const endMs = lines[currentIndex + 1]?.timeMs ?? durationMs
  return line.timeMs + ((endMs - line.timeMs) * completedWords) / words
}

export function syncedLyricsWindow(
  lines: SyncedLyricLine[],
  currentIndex: number,
  radius = 2
): Array<{ index: number; line: SyncedLyricLine; current: boolean }> {
  if (lines.length === 0) return []
  const anchor = currentIndex < 0 ? 0 : currentIndex
  const start = Math.max(0, anchor - radius)
  const end = Math.min(lines.length, anchor + radius + 1)
  return lines.slice(start, end).map((line, offset) => {
    const index = start + offset
    return { index, line, current: index === currentIndex }
  })
}

function progressAnchor(track: SpotifyCurrentTrack): number {
  const midpoint = track.progressSeconds * 1_000 + SPOTIFY_PROGRESS_MIDPOINT_MS
  return Math.min(midpoint, track.durationSeconds * 1_000)
}

async function stateFromLyrics(result: CurrentTrackLyrics, now: number): Promise<LiveLyricsState> {
  const base = {
    track: result.track,
    anchorProgressMs: progressAnchor(result.track),
    anchorTimeMs: now
  }
  if (result.match?.instrumental) {
    return { ...base, mode: 'unavailable', lines: [], detail: 'Instrumental track' }
  }

  const lines = groupRapidSyncedLyrics(
    await addKoreanPronunciations(parseSyncedLyrics(result.match?.syncedLyrics), result.track)
  )
  if (lines.length === 0) {
    return {
      ...base,
      mode: 'unavailable',
      lines: [],
      detail: result.match ? 'No synchronized lyrics for this track' : 'Lyrics not found'
    }
  }
  return { ...base, mode: 'lyrics', lines, detail: '' }
}

export async function loadInitialLiveLyricsState(
  dependencies: Pick<
    LyricsSessionDependencies,
    'now' | 'getCurrentTrack' | 'getLyricsForTrack'
  > = defaultDependencies
): Promise<LiveLyricsState> {
  const requestStartedAt = dependencies.now()
  let track: SpotifyCurrentTrack
  try {
    track = await dependencies.getCurrentTrack()
  } catch (error) {
    if (error instanceof NoSpotifyPlaybackError) {
      return {
        mode: 'idle',
        track: null,
        lines: [],
        detail: 'Waiting for Spotify playback',
        anchorProgressMs: 0,
        anchorTimeMs: dependencies.now()
      }
    }
    throw error
  }
  const sampledAt = requestMidpoint(requestStartedAt, dependencies.now())

  try {
    return await stateFromLyrics(await dependencies.getLyricsForTrack(track), sampledAt)
  } catch {
    return {
      mode: 'error',
      track,
      lines: [],
      detail: 'Could not load synchronized lyrics; retrying',
      anchorProgressMs: progressAnchor(track),
      anchorTimeMs: sampledAt
    }
  }
}

function viewKey(view: LiveLyricsView): string {
  const durationMs = (view.track?.durationSeconds ?? 0) * 1_000
  return [
    view.mode,
    view.track?.uri ?? '',
    view.track?.isPlaying ? 'playing' : 'paused',
    view.currentIndex,
    currentSyncedWordCount(
      view.lines,
      view.currentIndex,
      view.progressMs,
      durationMs,
      view.displayMode
    ),
    view.offsetMs,
    view.displayMode,
    view.detail
  ].join('|')
}

export function liveLyricsView(
  state: LiveLyricsState,
  now = Date.now(),
  stopped = false,
  offsetMs = 0,
  displayMode: LyricsDisplayMode = 'japanese'
): LiveLyricsView {
  const durationMs = (state.track?.durationSeconds ?? 0) * 1_000
  const elapsed = state.track?.isPlaying && !stopped ? Math.max(0, now - state.anchorTimeMs) : 0
  const spotifyProgressMs = Math.min(Math.max(0, state.anchorProgressMs + elapsed), durationMs)
  const progressMs = Math.min(Math.max(0, spotifyProgressMs + offsetMs), durationMs)
  return {
    ...state,
    currentIndex: state.mode === 'lyrics' ? currentSyncedLineIndex(state.lines, progressMs) : -1,
    progressMs,
    spotifyProgressMs,
    offsetMs,
    stopped,
    displayMode
  }
}

export class LiveLyricsSession {
  readonly token: string
  readonly ownerId: string
  readonly isPublic: boolean
  readonly startedAt: number

  private readonly dependencies: LyricsSessionDependencies
  private readonly renderView: (view: LiveLyricsView) => Promise<void>
  private readonly onClose: () => void
  private state: LiveLyricsState
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private active = true
  private nextSyncAt: number
  private nextLyricsRetryAt = 0
  private lastEditAt: number
  private lastRenderedKey: string
  private renderPending = false
  private offsetMs = 0
  private displayMode: LyricsDisplayMode = 'japanese'
  private renderLatencyMs: number

  constructor(options: LiveLyricsSessionOptions) {
    this.token = options.token
    this.ownerId = options.ownerId
    this.isPublic = options.isPublic
    this.state = options.initialState
    this.renderView = options.render
    this.onClose = options.onClose
    this.dependencies = { ...defaultDependencies, ...options.dependencies }
    this.displayMode = options.renderedView.displayMode
    this.renderLatencyMs = normalizedRenderLatency(options.initialRenderLatencyMs ?? 0)
    this.offsetMs = normalizedOffset(
      options.initialOffsetMs ??
        (options.initialState.track
          ? this.dependencies.loadOffset(options.initialState.track.id)
          : 0)
    )
    this.startedAt = options.startedAt ?? this.dependencies.now()
    this.nextSyncAt = this.startedAt + SPOTIFY_RESYNC_INTERVAL_MS
    this.lastEditAt = this.dependencies.now()
    this.lastRenderedKey = viewKey(options.renderedView)
  }

  get isActive(): boolean {
    return this.active
  }

  view(now = this.dependencies.now()): LiveLyricsView {
    return liveLyricsView(this.state, now, !this.active, this.offsetMs, this.displayMode)
  }

  private viewForRender(now = this.dependencies.now()): LiveLyricsView {
    return this.view(now + this.renderLatencyMs)
  }

  private async render(view: LiveLyricsView): Promise<void> {
    const startedAt = this.dependencies.now()
    await this.renderView(view)
    const elapsed = this.dependencies.now() - startedAt
    if (elapsed <= 0) return
    const measured = normalizedRenderLatency(elapsed)
    this.renderLatencyMs =
      this.renderLatencyMs === 0 ? measured : (this.renderLatencyMs * 3 + measured) / 4
  }

  start(): void {
    if (!this.active) return
    this.schedule()
  }

  async stop(reason = 'Stopped by requester', render = true): Promise<LiveLyricsView> {
    if (!this.active) return this.view()

    this.active = false
    if (this.timer) {
      this.dependencies.clearTimer(this.timer)
      this.timer = null
    }
    const running = this.inFlight
    if (running) await running.catch(() => {})

    this.state = {
      ...this.state,
      mode: 'stopped',
      detail: reason,
      anchorProgressMs: this.estimatedSpotifyProgress(this.dependencies.now()),
      anchorTimeMs: this.dependencies.now()
    }
    const finalView = this.view()
    if (render) await this.renderView(finalView).catch(() => {})
    this.onClose()
    return finalView
  }

  async adjustOffset(deltaMs: number): Promise<LiveLyricsView> {
    if (!this.active || !Number.isFinite(deltaMs)) return this.view()
    const nextOffset = Math.max(
      -MAX_LYRICS_OFFSET_MS,
      Math.min(MAX_LYRICS_OFFSET_MS, this.offsetMs + Math.trunc(deltaMs))
    )
    if (nextOffset === this.offsetMs) return this.view()

    this.offsetMs = nextOffset
    if (this.state.track) this.dependencies.saveOffset(this.state.track.id, nextOffset)
    return this.renderControlUpdate()
  }

  async setDisplayMode(displayMode: LyricsDisplayMode): Promise<LiveLyricsView> {
    if (!this.active || displayMode === this.displayMode) return this.view()
    if (
      displayMode === 'korean-pronunciation' &&
      !this.state.lines.some((line) => line.pronunciation)
    ) {
      return this.view()
    }
    this.displayMode = displayMode
    return this.renderControlUpdate()
  }

  private async renderControlUpdate(): Promise<LiveLyricsView> {
    if (this.timer) {
      this.dependencies.clearTimer(this.timer)
      this.timer = null
    }
    const running = this.inFlight
    if (running) await running.catch(() => {})
    if (!this.active) return this.view()
    if (this.timer) {
      this.dependencies.clearTimer(this.timer)
      this.timer = null
    }

    const view = this.viewForRender()
    try {
      await this.render(view)
    } catch {
      this.finishWithoutRender()
      return this.view()
    }
    if (!this.active) return this.view()
    this.lastRenderedKey = viewKey(view)
    this.lastEditAt = this.dependencies.now()
    this.renderPending = false
    this.schedule()
    return view
  }

  private estimatedSpotifyProgress(now: number): number {
    const durationMs = (this.state.track?.durationSeconds ?? 0) * 1_000
    const elapsed = this.state.track?.isPlaying ? Math.max(0, now - this.state.anchorTimeMs) : 0
    return Math.min(Math.max(0, this.state.anchorProgressMs + elapsed), durationMs)
  }

  private setTrackAnchor(track: SpotifyCurrentTrack, now: number): void {
    this.state.track = track
    this.state.anchorProgressMs = progressAnchor(track)
    this.state.anchorTimeMs = now
  }

  private async synchronize(): Promise<void> {
    const requestStartedAt = this.dependencies.now()
    let track: SpotifyCurrentTrack
    try {
      track = await this.dependencies.getCurrentTrack()
    } catch (error) {
      if (error instanceof NoSpotifyPlaybackError) {
        this.offsetMs = 0
        this.displayMode = 'japanese'
        this.state = {
          mode: 'idle',
          track: null,
          lines: [],
          detail: 'Waiting for Spotify playback',
          anchorProgressMs: 0,
          anchorTimeMs: this.dependencies.now()
        }
      } else if (!this.state.track) {
        this.state = {
          mode: 'error',
          track: null,
          lines: [],
          detail: 'Spotify timing check failed; retrying',
          anchorProgressMs: 0,
          anchorTimeMs: this.dependencies.now()
        }
      }
      return
    }

    if (!this.active) return
    const sampledAt = requestMidpoint(requestStartedAt, this.dependencies.now())
    const changedTrack = this.state.track?.uri !== track.uri
    if (changedTrack) this.offsetMs = normalizedOffset(this.dependencies.loadOffset(track.id))
    this.setTrackAnchor(track, sampledAt)

    const shouldRetryLyrics =
      this.state.mode === 'error' && this.dependencies.now() >= this.nextLyricsRetryAt
    if (!changedTrack && !shouldRetryLyrics) return

    try {
      this.state = await stateFromLyrics(
        await this.dependencies.getLyricsForTrack(track),
        sampledAt
      )
      if (!this.state.lines.some((line) => line.pronunciation)) this.displayMode = 'japanese'
      this.nextLyricsRetryAt = 0
    } catch {
      this.state = {
        mode: 'error',
        track,
        lines: [],
        detail: 'Could not load synchronized lyrics; retrying',
        anchorProgressMs: progressAnchor(track),
        anchorTimeMs: this.dependencies.now()
      }
      this.nextLyricsRetryAt = this.dependencies.now() + LYRICS_RETRY_INTERVAL_MS
    }
  }

  private async maybeRender(): Promise<void> {
    if (!this.active) return
    const now = this.dependencies.now()
    const view = this.viewForRender(now)
    const key = viewKey(view)
    if (key === this.lastRenderedKey) {
      this.renderPending = false
      return
    }
    if (now - this.lastEditAt < MIN_LYRICS_EDIT_INTERVAL_MS) {
      this.renderPending = true
      return
    }

    try {
      await this.render(view)
    } catch {
      this.finishWithoutRender()
      return
    }
    if (!this.active) return
    this.lastRenderedKey = key
    this.lastEditAt = this.dependencies.now()
    this.renderPending = false
  }

  private async tick(): Promise<void> {
    if (!this.active) return
    const now = this.dependencies.now()
    const maximumDuration = this.isPublic ? PUBLIC_LYRICS_SESSION_MS : EPHEMERAL_LYRICS_SESSION_MS
    if (now - this.startedAt >= maximumDuration) {
      await this.finishWithRender(
        this.isPublic
          ? 'Session reached the six-hour safety limit'
          : 'Interaction session expired; use `lyrics --pub` in a bot-accessible channel for a longer session'
      )
      return
    }

    if (now >= this.nextSyncAt) {
      await this.synchronize()
      this.nextSyncAt = this.dependencies.now() + SPOTIFY_RESYNC_INTERVAL_MS
    }
    if (!this.active) return
    await this.maybeRender()
    if (this.active) this.schedule()
  }

  private schedule(): void {
    if (!this.active || this.timer) return
    const now = this.dependencies.now()
    let delay = Math.max(TIMER_FLOOR_MS, this.nextSyncAt - now)

    if (viewKey(this.viewForRender(now)) !== this.lastRenderedKey) {
      delay = Math.min(
        delay,
        Math.max(TIMER_FLOOR_MS, this.lastEditAt + MIN_LYRICS_EDIT_INTERVAL_MS - now)
      )
    }

    if (this.state.mode === 'lyrics' && this.state.track?.isPlaying) {
      const progressMs = this.view(now).progressMs
      const currentIndex = currentSyncedLineIndex(this.state.lines, progressMs)
      const durationMs = this.state.track.durationSeconds * 1_000
      const nextWordProgressMs = nextSyncedWordProgressMs(
        this.state.lines,
        currentIndex,
        progressMs,
        durationMs,
        this.displayMode
      )
      if (nextWordProgressMs !== null) {
        delay = Math.min(
          delay,
          Math.max(TIMER_FLOOR_MS, nextWordProgressMs - progressMs - this.renderLatencyMs + 25)
        )
      }
      const nextLine = this.state.lines[currentIndex + 1]
      if (nextLine) {
        delay = Math.min(
          delay,
          Math.max(TIMER_FLOOR_MS, nextLine.timeMs - progressMs - this.renderLatencyMs + 25)
        )
      }
    }
    if (this.renderPending) {
      delay = Math.min(
        delay,
        Math.max(TIMER_FLOOR_MS, this.lastEditAt + MIN_LYRICS_EDIT_INTERVAL_MS - now)
      )
    }

    const maximumDuration = this.isPublic ? PUBLIC_LYRICS_SESSION_MS : EPHEMERAL_LYRICS_SESSION_MS
    delay = Math.min(delay, Math.max(TIMER_FLOOR_MS, this.startedAt + maximumDuration - now))

    this.timer = this.dependencies.setTimer(() => {
      this.timer = null
      const running = this.tick().catch(() => this.finishWithoutRender())
      this.inFlight = running
      void running.finally(() => {
        if (this.inFlight === running) this.inFlight = null
      })
    }, delay)
    this.timer.unref?.()
  }

  private finishWithoutRender(): void {
    if (!this.active) return
    this.active = false
    if (this.timer) this.dependencies.clearTimer(this.timer)
    this.timer = null
    this.onClose()
  }

  private async finishWithRender(reason: string): Promise<void> {
    if (!this.active) return
    this.active = false
    this.state = {
      ...this.state,
      mode: 'stopped',
      detail: reason,
      anchorProgressMs: this.estimatedSpotifyProgress(this.dependencies.now()),
      anchorTimeMs: this.dependencies.now()
    }
    await this.renderView(this.view()).catch(() => {})
    this.onClose()
  }
}

const sessions = new Map<string, LiveLyricsSession>()
const ownerSessions = new Map<string, string>()

export function getLyricsSession(token: string): LiveLyricsSession | undefined {
  return sessions.get(token)
}

export function unregisterLyricsSession(token: string): void {
  const session = sessions.get(token)
  if (!session) return
  sessions.delete(token)
  if (ownerSessions.get(session.ownerId) === token) ownerSessions.delete(session.ownerId)
}

export async function registerLyricsSession(session: LiveLyricsSession): Promise<void> {
  for (const current of sessions.values()) {
    await current.stop('Replaced by a new lyrics session')
  }

  sessions.set(session.token, session)
  ownerSessions.set(session.ownerId, session.token)
}

export async function stopActiveLyricsSessions(
  reason = 'Replaced by a new lyrics session',
  render = true
): Promise<void> {
  for (const session of sessions.values()) {
    await session.stop(reason, render)
  }
}

export async function clearLyricsSessions(): Promise<void> {
  await stopActiveLyricsSessions('Session cleared', false)
  sessions.clear()
  ownerSessions.clear()
}
