import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LiveLyricsSession,
  LYRICS_OFFSETS_KEY,
  MAX_LYRICS_OFFSET_MS,
  MIN_LYRICS_EDIT_INTERVAL_MS,
  SPOTIFY_RESYNC_INTERVAL_MS,
  clearLyricsSessions,
  currentSyncedLineIndex,
  getLyricsSession,
  groupRapidSyncedLyrics,
  liveLyricsView,
  loadInitialLiveLyricsState,
  loadLyricsOffset,
  parseSyncedLyrics,
  registerLyricsSession,
  saveLyricsOffset,
  syncedLyricsWindow,
  unregisterLyricsSession,
  type LiveLyricsState,
  type LiveLyricsView
} from '../commands/lyrics-session.js'
import {
  NoSpotifyPlaybackError,
  type CurrentTrackLyrics,
  type SpotifyCurrentTrack
} from '../commands/_lyrics.js'
import { deleteStoredValue, getStoredValue, setStoredValue } from '../helpers/kv-store.js'

function track(id = 'one', progressSeconds = 0): SpotifyCurrentTrack {
  return {
    id,
    uri: `spotify:track:${id}`,
    name: `Song ${id}`,
    artists: 'Test Artist',
    album: 'Test Album',
    durationSeconds: 240,
    progressSeconds,
    isPlaying: true
  }
}

function lyricsFor(
  currentTrack: SpotifyCurrentTrack,
  syncedLyrics = '[00:00.00] Zero\n[00:01.00] One\n[00:02.00] Two'
): CurrentTrackLyrics {
  return {
    track: currentTrack,
    match: {
      id: 1,
      trackName: currentTrack.name,
      artistName: currentTrack.artists,
      albumName: currentTrack.album,
      duration: currentTrack.durationSeconds,
      instrumental: false,
      plainLyrics: null,
      syncedLyrics
    },
    lyrics: null,
    synchronized: true
  }
}

function stateFor(
  currentTrack = track(),
  syncedLyrics = '[00:00.00] Zero\n[00:01.00] One\n[00:02.00] Two'
): LiveLyricsState {
  return {
    mode: 'lyrics',
    track: currentTrack,
    lines: parseSyncedLyrics(syncedLyrics),
    detail: '',
    anchorProgressMs: currentTrack.progressSeconds * 1_000,
    anchorTimeMs: Date.now()
  }
}

function initialView(state: LiveLyricsState): LiveLyricsView {
  return liveLyricsView(state, Date.now())
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  deleteStoredValue(LYRICS_OFFSETS_KEY)
})

afterEach(async () => {
  await clearLyricsSessions()
  deleteStoredValue(LYRICS_OFFSETS_KEY)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('synchronized lyrics parsing', () => {
  it('parses fractional and repeated LRC timestamps in chronological order', () => {
    expect(
      parseSyncedLyrics(
        '[offset:+5]\n[00:02.5] Later\n[00:01.25][00:03.250] Repeated\n[ar:Artist]\n[00:00.000] First'
      )
    ).toEqual([
      { timeMs: 5, text: 'First' },
      { timeMs: 1_255, text: 'Repeated' },
      { timeMs: 2_505, text: 'Later' },
      { timeMs: 3_255, text: 'Repeated' }
    ])
  })

  it('finds the active line and returns two surrounding lines on each side', () => {
    const lines = parseSyncedLyrics(
      '[00:00.00] A\n[00:01.00] B\n[00:02.00] C\n[00:03.00] D\n[00:04.00] E'
    )
    const current = currentSyncedLineIndex(lines, 2_500)

    expect(current).toBe(2)
    expect(syncedLyricsWindow(lines, current).map(({ line }) => line.text)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E'
    ])
  })

  it('groups rapid lines into blocks spaced far enough apart for message edits', () => {
    const lines = parseSyncedLyrics(
      '[00:00.00] A\n[00:00.20] B\n[00:00.80] C\n[00:01.25] D\n[00:01.90] E\n[00:02.50] F'
    )

    expect(groupRapidSyncedLyrics(lines)).toEqual([
      { timeMs: 0, text: 'A\nB\nC' },
      { timeMs: 1_250, text: 'D\nE' },
      { timeMs: 2_500, text: 'F' }
    ])
  })

  it('uses grouped blocks when loading live synchronized lyrics', async () => {
    const currentTrack = track()
    const state = await loadInitialLiveLyricsState({
      now: () => 0,
      getCurrentTrack: async () => currentTrack,
      getLyricsForTrack: async () =>
        lyricsFor(currentTrack, '[00:00.00] A\n[00:00.20] B\n[00:00.40] C\n[00:02.00] D')
    })

    expect(state.lines).toEqual([
      { timeMs: 0, text: 'A\nB\nC' },
      { timeMs: 2_000, text: 'D' }
    ])
  })
})

describe('live lyrics scheduling', () => {
  it('accounts for Spotify request and lyrics lookup latency in initial progress', async () => {
    const currentTrack = track('one', 0)
    const state = await loadInitialLiveLyricsState({
      now: () => Date.now(),
      getCurrentTrack: async () => {
        vi.setSystemTime(200)
        return currentTrack
      },
      getLyricsForTrack: async () => {
        vi.setSystemTime(1_200)
        return lyricsFor(currentTrack)
      }
    })

    expect(state.anchorTimeMs).toBe(100)
    expect(liveLyricsView(state, Date.now()).spotifyProgressMs).toBe(1_600)
  })

  it('starts Discord edits early by the measured render latency', async () => {
    const currentTrack = track()
    const state = stateFor(currentTrack, '[00:00.00] A\n[00:02.00] B')
    const rendered: Array<{ at: number; index: number }> = []
    const session = new LiveLyricsSession({
      token: '0000000000000014',
      ownerId: 'owner',
      isPublic: true,
      initialState: state,
      renderedView: initialView(state),
      initialRenderLatencyMs: 200,
      render: async (view) => {
        rendered.push({ at: Date.now(), index: view.currentIndex })
      },
      onClose: () => undefined,
      dependencies: {
        getCurrentTrack: async () => currentTrack,
        getLyricsForTrack: async () => lyricsFor(currentTrack)
      }
    })
    session.start()

    await vi.advanceTimersByTimeAsync(1_824)
    expect(rendered).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(rendered).toEqual([{ at: 1_825, index: 1 }])
    await session.stop('test complete', false)
  })

  it('stores bounded offsets by Spotify track and removes zero offsets', () => {
    saveLyricsOffset('one', 750)
    saveLyricsOffset('two', -100_000)

    expect(loadLyricsOffset('one')).toBe(1_000)
    expect(loadLyricsOffset('two')).toBe(-MAX_LYRICS_OFFSET_MS)
    expect(getStoredValue(LYRICS_OFFSETS_KEY)).toContain('"one"')

    saveLyricsOffset('one', 0)
    expect(loadLyricsOffset('one')).toBe(0)
  })

  it('ignores malformed persisted offset data', () => {
    setStoredValue(LYRICS_OFFSETS_KEY, '{bad json')
    expect(loadLyricsOffset('one')).toBe(0)
  })

  it('restores the saved offset when a later session starts on the same song', async () => {
    saveLyricsOffset('one', 500)
    const currentTrack = track('one')
    const state = stateFor(currentTrack)
    const session = new LiveLyricsSession({
      token: '0000000000000013',
      ownerId: 'owner',
      isPublic: true,
      initialState: state,
      renderedView: liveLyricsView(state, Date.now(), false, 500),
      render: async () => undefined,
      onClose: () => undefined,
      dependencies: {
        getCurrentTrack: async () => currentTrack,
        getLyricsForTrack: async () => lyricsFor(currentTrack)
      }
    })

    expect(session.view().offsetMs).toBe(500)
    await session.stop('test complete', false)
  })

  it('replaces the existing global session instead of duplicating Spotify polling', async () => {
    const currentTrack = track()
    const state = stateFor(currentTrack)
    const makeSession = (token: string) =>
      new LiveLyricsSession({
        token,
        ownerId: token,
        isPublic: true,
        initialState: state,
        renderedView: initialView(state),
        render: async () => undefined,
        onClose: () => unregisterLyricsSession(token),
        dependencies: {
          getCurrentTrack: async () => currentTrack,
          getLyricsForTrack: async () => lyricsFor(currentTrack)
        }
      })
    const first = makeSession('0000000000000010')
    const second = makeSession('0000000000000011')

    await registerLyricsSession(first)
    await registerLyricsSession(second)

    expect(first.isActive).toBe(false)
    expect(getLyricsSession(first.token)).toBeUndefined()
    expect(getLyricsSession(second.token)).toBe(second)
  })

  it('adjusts lyric time in half-second steps and clamps extreme offsets', async () => {
    const currentTrack = track()
    const state = stateFor(currentTrack)
    const render = vi.fn(async (_view: LiveLyricsView) => undefined)
    const session = new LiveLyricsSession({
      token: '0000000000000012',
      ownerId: 'owner',
      isPublic: true,
      initialState: state,
      renderedView: initialView(state),
      render,
      onClose: () => undefined,
      dependencies: {
        getCurrentTrack: async () => currentTrack,
        getLyricsForTrack: async () => lyricsFor(currentTrack)
      }
    })

    const halfStep = await session.adjustOffset(500)
    expect(halfStep).toMatchObject({
      offsetMs: 500,
      spotifyProgressMs: 0,
      progressMs: 500,
      currentIndex: 0
    })

    const advanced = await session.adjustOffset(500)
    expect(advanced).toMatchObject({
      offsetMs: 1_000,
      spotifyProgressMs: 0,
      progressMs: 1_000,
      currentIndex: 1
    })

    const delayed = await session.adjustOffset(-1_500)
    expect(delayed).toMatchObject({ offsetMs: -500, progressMs: 0, currentIndex: 0 })

    const clamped = await session.adjustOffset(100_000)
    expect(clamped.offsetMs).toBe(MAX_LYRICS_OFFSET_MS)
    expect(render).toHaveBeenCalledTimes(4)
    await session.stop('test complete', false)
  })

  it('coalesces rapid line transitions to avoid Discord edit bursts', async () => {
    const currentTrack = track()
    const state = stateFor(
      currentTrack,
      '[00:00.00] A\n[00:00.20] B\n[00:00.40] C\n[00:00.60] D\n[00:01.00] E\n[00:02.00] F'
    )
    const rendered: Array<{ at: number; index: number }> = []
    const session = new LiveLyricsSession({
      token: '0000000000000001',
      ownerId: 'owner',
      isPublic: true,
      initialState: state,
      renderedView: initialView(state),
      render: async (view) => {
        rendered.push({ at: Date.now(), index: view.currentIndex })
      },
      onClose: () => undefined,
      dependencies: {
        getCurrentTrack: async () => currentTrack,
        getLyricsForTrack: async () => lyricsFor(currentTrack)
      }
    })
    session.start()

    await vi.advanceTimersByTimeAsync(MIN_LYRICS_EDIT_INTERVAL_MS - 1)
    expect(rendered).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(rendered).toEqual([{ at: MIN_LYRICS_EDIT_INTERVAL_MS, index: 4 }])

    await vi.advanceTimersByTimeAsync(MIN_LYRICS_EDIT_INTERVAL_MS)
    expect(rendered.at(-1)).toEqual({ at: MIN_LYRICS_EDIT_INTERVAL_MS * 2, index: 5 })
    expect(rendered).toHaveLength(2)
    await session.stop('test complete', false)
  })

  it('corrects local timing from Spotify every five seconds', async () => {
    const initialTrack = track('one', 0)
    const correctedTrack = track('one', 20)
    const state = stateFor(
      initialTrack,
      '[00:00.00] Zero\n[00:10.00] Ten\n[00:20.00] Twenty\n[00:30.00] Thirty'
    )
    const render = vi.fn(async (_view: LiveLyricsView) => undefined)
    const getCurrentTrack = vi.fn(async () => correctedTrack)
    const session = new LiveLyricsSession({
      token: '0000000000000002',
      ownerId: 'owner',
      isPublic: true,
      initialState: state,
      renderedView: initialView(state),
      render,
      onClose: () => undefined,
      dependencies: {
        getCurrentTrack,
        getLyricsForTrack: async () => lyricsFor(correctedTrack)
      }
    })
    session.start()

    await vi.advanceTimersByTimeAsync(SPOTIFY_RESYNC_INTERVAL_MS)

    expect(getCurrentTrack).toHaveBeenCalledTimes(1)
    expect(render).toHaveBeenCalledTimes(1)
    expect(render.mock.calls[0]![0].currentIndex).toBe(2)
    await session.stop('test complete', false)
  })

  it('restores each song offset when Spotify advances between tracks', async () => {
    const firstTrack = track('one', 0)
    const secondTrack = track('two', 2)
    const firstState = stateFor(firstTrack)
    saveLyricsOffset('two', -500)
    const getCurrentTrack = vi
      .fn<() => Promise<SpotifyCurrentTrack>>()
      .mockResolvedValueOnce(secondTrack)
      .mockResolvedValueOnce(firstTrack)
    const getLyricsForTrack = vi.fn(async (selectedTrack: SpotifyCurrentTrack) =>
      lyricsFor(
        selectedTrack,
        '[00:00.00] New zero\n[00:01.00] New one\n[00:02.00] New two\n[00:03.00] New three'
      )
    )
    const render = vi.fn(async (_view: LiveLyricsView) => undefined)
    const session = new LiveLyricsSession({
      token: '0000000000000003',
      ownerId: 'owner',
      isPublic: true,
      initialState: firstState,
      renderedView: initialView(firstState),
      render,
      onClose: () => undefined,
      dependencies: { getCurrentTrack, getLyricsForTrack }
    })
    await session.adjustOffset(1_000)
    render.mockClear()
    session.start()

    await vi.advanceTimersByTimeAsync(SPOTIFY_RESYNC_INTERVAL_MS)

    expect(getLyricsForTrack).toHaveBeenCalledWith(secondTrack)
    expect(render.mock.calls.at(-1)![0]).toMatchObject({
      mode: 'lyrics',
      currentIndex: 1,
      offsetMs: -500,
      track: { uri: 'spotify:track:two' }
    })

    await vi.advanceTimersByTimeAsync(SPOTIFY_RESYNC_INTERVAL_MS)
    expect(render.mock.calls.at(-1)![0]).toMatchObject({
      offsetMs: 1_000,
      track: { uri: 'spotify:track:one' }
    })
    await session.stop('test complete', false)
  })

  it('keeps polling while idle and starts lyrics when playback resumes', async () => {
    const resumedTrack = track('resumed', 2)
    const idleState: LiveLyricsState = {
      mode: 'idle',
      track: null,
      lines: [],
      detail: 'Waiting for Spotify playback',
      anchorProgressMs: 0,
      anchorTimeMs: Date.now()
    }
    const getCurrentTrack = vi.fn(async () => resumedTrack)
    const getLyricsForTrack = vi.fn(async () => lyricsFor(resumedTrack))
    const render = vi.fn(async (_view: LiveLyricsView) => undefined)
    const session = new LiveLyricsSession({
      token: '0000000000000005',
      ownerId: 'owner',
      isPublic: true,
      initialState: idleState,
      renderedView: initialView(idleState),
      render,
      onClose: () => undefined,
      dependencies: { getCurrentTrack, getLyricsForTrack }
    })
    session.start()

    await vi.advanceTimersByTimeAsync(SPOTIFY_RESYNC_INTERVAL_MS)

    expect(getLyricsForTrack).toHaveBeenCalledWith(resumedTrack)
    expect(render.mock.calls.at(-1)![0]).toMatchObject({
      mode: 'lyrics',
      track: { uri: 'spotify:track:resumed' }
    })
    await session.stop('test complete', false)
  })

  it('keeps waiting when Spotify still has no active playback', async () => {
    const idleState: LiveLyricsState = {
      mode: 'idle',
      track: null,
      lines: [],
      detail: 'Waiting for Spotify playback',
      anchorProgressMs: 0,
      anchorTimeMs: Date.now()
    }
    const getCurrentTrack = vi.fn(async () => {
      throw new NoSpotifyPlaybackError()
    })
    const render = vi.fn(async (_view: LiveLyricsView) => undefined)
    const session = new LiveLyricsSession({
      token: '0000000000000006',
      ownerId: 'owner',
      isPublic: true,
      initialState: idleState,
      renderedView: initialView(idleState),
      render,
      onClose: () => undefined,
      dependencies: {
        getCurrentTrack,
        getLyricsForTrack: async () => lyricsFor(track())
      }
    })
    session.start()

    await vi.advanceTimersByTimeAsync(SPOTIFY_RESYNC_INTERVAL_MS)

    expect(getCurrentTrack).toHaveBeenCalledTimes(1)
    expect(render).not.toHaveBeenCalled()
    await session.stop('test complete', false)
  })

  it('stops all future polling and rendering', async () => {
    const currentTrack = track()
    const state = stateFor(currentTrack)
    const getCurrentTrack = vi.fn(async () => currentTrack)
    const render = vi.fn(async (_view: LiveLyricsView) => undefined)
    const session = new LiveLyricsSession({
      token: '0000000000000004',
      ownerId: 'owner',
      isPublic: true,
      initialState: state,
      renderedView: initialView(state),
      render,
      onClose: () => undefined,
      dependencies: {
        getCurrentTrack,
        getLyricsForTrack: async () => lyricsFor(currentTrack)
      }
    })
    session.start()
    await session.stop('Stopped by requester', false)

    await vi.advanceTimersByTimeAsync(SPOTIFY_RESYNC_INTERVAL_MS * 2)

    expect(getCurrentTrack).not.toHaveBeenCalled()
    expect(render).not.toHaveBeenCalled()
  })
})
