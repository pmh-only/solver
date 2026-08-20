import { afterEach, describe, expect, it, vi } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import * as mcpRuntime from '../agent/mcp-runtime.js'
import {
  lyricsClient,
  parseSpotifyCurrentTrack,
  type CurrentTrackLyrics,
  type SpotifyCurrentTrack
} from '../commands/_lyrics.js'
import {
  LYRICS_OFFSET_BUTTON_ID,
  LYRICS_STOP_BUTTON_ID,
  formatLiveLyrics,
  subcommand as lyrics
} from '../commands/lyrics.js'
import {
  clearLyricsSessions,
  currentSyncedLineIndex,
  parseSyncedLyrics,
  type LiveLyricsView
} from '../commands/lyrics-session.js'
import {
  autocompleteJSON,
  buttonJSON,
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands
} from './e2e.js'

const subs = makeSubcommands(lyrics)

function spotifyTrack(overrides: Partial<SpotifyCurrentTrack> = {}): SpotifyCurrentTrack {
  return {
    id: 'abc123',
    uri: 'spotify:track:abc123',
    name: 'Test Song',
    artists: 'Test Artist',
    album: 'Test Album',
    durationSeconds: 225,
    progressSeconds: 62,
    isPlaying: true,
    ...overrides
  }
}

function playbackResult() {
  return {
    content: [
      {
        type: 'text',
        text: [
          'Now playing: "Test Song" by Test Artist',
          'Album: Test Album',
          'Progress: 1:02 / 3:45',
          'Device: Browser (Computer)',
          'URI: spotify:track:abc123'
        ].join('\n')
      }
    ]
  }
}

function currentLyrics(track = spotifyTrack()): CurrentTrackLyrics {
  return {
    track,
    match: {
      id: 42,
      trackName: track.name,
      artistName: track.artists,
      albumName: track.album,
      duration: track.durationSeconds,
      instrumental: false,
      plainLyrics: 'Before two\nBefore one\nCurrent line\nAfter one\nAfter two',
      syncedLyrics: [
        '[00:58.00] Before two',
        '[01:00.00] Before one',
        '[01:02.00] Current line',
        '[01:03.00] After one',
        '[01:04.00] After two'
      ].join('\n')
    },
    lyrics: 'Before two\nBefore one\nCurrent line\nAfter one\nAfter two',
    synchronized: true
  }
}

function collectCustomIds(value: unknown, ids: string[] = []): string[] {
  if (!value || typeof value !== 'object') return ids
  if (Array.isArray(value)) {
    value.forEach((entry) => collectCustomIds(entry, ids))
    return ids
  }
  const record = value as { components?: unknown; custom_id?: unknown }
  if (typeof record.custom_id === 'string') ids.push(record.custom_id)
  collectCustomIds(record.components, ids)
  return ids
}

async function startCommand(input = 'lyrics') {
  vi.spyOn(lyricsClient, 'getCurrentTrack').mockResolvedValue(spotifyTrack())
  vi.spyOn(lyricsClient, 'getLyricsForTrack').mockResolvedValue(currentLyrics())
  return dispatch(commandJSON(input, { channel: { id: '777777777777777777', type: 1 } }), subs)
}

afterEach(async () => {
  await clearLyricsSessions()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('lyrics command', () => {
  it('starts a live session with the current line and two lines on either side', async () => {
    const calls = await startCommand()
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls) as { components: unknown[] }
    const rendered = JSON.stringify(edit)

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(rendered).toContain('Live lyrics: Test Song')
    expect(rendered).toContain('Before two')
    expect(rendered).toContain('Before one')
    expect(rendered).toContain('## Current line')
    expect(rendered).toContain('After one')
    expect(rendered).toContain('After two')
    expect(collectCustomIds(edit.components)).toEqual([
      expect.stringMatching(new RegExp(`^${LYRICS_OFFSET_BUTTON_ID}:[a-f0-9]{16}:minus$`)),
      expect.stringMatching(new RegExp(`^${LYRICS_OFFSET_BUTTON_ID}:[a-f0-9]{16}:plus$`)),
      expect.stringMatching(new RegExp(`^${LYRICS_STOP_BUTTON_ID}:[a-f0-9]{16}$`))
    ])
    expect(rendered).toContain('"label":"-1s"')
    expect(rendered).toContain('"label":"+1s"')
  })

  it('supports a public live session through --pub', async () => {
    const calls = await startCommand('lyrics --pub')
    const defer = getCallback(calls) as { type: number; data: { flags: number } }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })

  it('uses bot-authenticated message edits for public sessions after the initial reply', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const calls = await startCommand('lyrics --pub')

    await vi.advanceTimersByTimeAsync(2_000)

    const patches = calls.filter(({ method }) => method === 'PATCH')
    expect(patches).toHaveLength(2)
    expect(patches[0]!.route).toContain('/webhooks/')
    expect(patches[1]!.route).toContain('/channels/777777777777777777/messages/0')
  })

  it('advances synchronized lyrics by one second when the owner presses +1s', async () => {
    const startCalls = await startCommand()
    const edit = getEdit(startCalls) as { components: unknown[] }
    const plusId = collectCustomIds(edit.components).find(
      (customId) => customId.startsWith(`${LYRICS_OFFSET_BUTTON_ID}:`) && customId.endsWith(':plus')
    )!
    const offsetCalls = await dispatch(
      buttonJSON(edit.components, plusId, {}, MessageFlags.IsComponentsV2),
      subs
    )
    const callback = getCallback(offsetCalls) as { type: number }
    const updated = startCalls.filter(({ method }) => method === 'PATCH').at(-1)?.body

    expect(callback.type).toBe(InteractionResponseType.DeferredMessageUpdate)
    expect(JSON.stringify(updated)).toContain('lyrics offset: +1s')
    expect(JSON.stringify(updated)).toContain('## After one')
  })

  it('stops the session when its owner presses Stop', async () => {
    const startCalls = await startCommand()
    const edit = getEdit(startCalls) as { components: unknown[] }
    const stopCalls = await dispatch(
      buttonJSON(edit.components, LYRICS_STOP_BUTTON_ID, {}, MessageFlags.IsComponentsV2),
      subs
    )
    const callback = getCallback(stopCalls) as { type: number }
    const stopped = JSON.stringify(getEdit(stopCalls))

    expect(callback.type).toBe(InteractionResponseType.DeferredMessageUpdate)
    expect(stopped).toContain('Live session stopped')
    expect(stopped).toContain('Stopped by requester')
  })

  it('does not let another user stop a public session', async () => {
    const startCalls = await startCommand('lyrics --pub')
    const edit = getEdit(startCalls) as { components: unknown[] }
    const stopCalls = await dispatch(
      buttonJSON(edit.components, LYRICS_STOP_BUTTON_ID, {
        user: {
          id: '777777777777777777',
          username: 'other',
          discriminator: '0',
          avatar: null,
          global_name: 'Other User'
        }
      }),
      subs
    )
    const callback = getCallback(stopCalls) as { data: { flags: number } }

    expect(callback.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(callback)).toContain(
      'Only the user who started this session can control it'
    )
  })

  it('reports an expired Stop button without throwing', async () => {
    const calls = await dispatch(buttonJSON([], `${LYRICS_STOP_BUTTON_ID}:0000000000000000`), subs)
    const callback = getCallback(calls) as { data: { flags: number } }

    expect(callback.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(callback)).toContain('session has expired')
  })

  it('rejects positional arguments without calling external services', async () => {
    const playback = vi.spyOn(lyricsClient, 'getCurrentTrack')
    const calls = await dispatch(commandJSON('lyrics another song'), subs)

    expect(JSON.stringify(getCallback(calls))).toContain('lyrics takes no arguments')
    expect(playback).not.toHaveBeenCalled()
  })

  it('appears in command autocomplete', async () => {
    const calls = await dispatch(autocompleteJSON('lyr'), subs)
    const callback = getCallback(calls) as { data: { choices: Array<{ value: string }> } }

    expect(callback.data.choices.some(({ value }) => value === 'lyrics')).toBe(true)
  })
})

describe('lyrics presentation', () => {
  it('renders a five-line synchronized window around the current line', () => {
    const lines = parseSyncedLyrics(currentLyrics().match!.syncedLyrics)
    const view: LiveLyricsView = {
      mode: 'lyrics',
      track: spotifyTrack(),
      lines,
      detail: '',
      anchorProgressMs: 62_500,
      anchorTimeMs: 0,
      currentIndex: currentSyncedLineIndex(lines, 62_500),
      progressMs: 62_500,
      spotifyProgressMs: 62_500,
      offsetMs: 0,
      stopped: false
    }
    const rendered = JSON.stringify(
      formatLiveLyrics(view).map((component) =>
        typeof component === 'string' ? component : component.toJSON()
      )
    )

    expect(rendered).toContain('## Current line')
    expect(rendered).toContain('Before two')
    expect(rendered).toContain('After two')
  })
})

describe('lyrics API runtime', () => {
  it('parses the Spotify MCP playback response', () => {
    expect(parseSpotifyCurrentTrack(playbackResult())).toMatchObject({
      id: 'abc123',
      name: 'Test Song',
      artists: 'Test Artist',
      album: 'Test Album',
      progressSeconds: 62,
      durationSeconds: 225,
      isPlaying: true
    })
  })

  it('looks up exact metadata in LRCLIB with a bounded identified request', async () => {
    vi.spyOn(mcpRuntime, 'callAgentMcpTool').mockResolvedValue(playbackResult())
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        id: 42,
        trackName: 'Test Song',
        artistName: 'Test Artist',
        albumName: 'Test Album',
        duration: 225,
        instrumental: false,
        plainLyrics: 'First line\nSecond line',
        syncedLyrics: '[00:01.00] First line\n[00:02.00] Second line'
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await lyricsClient.getCurrentTrackLyrics()
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [URL, RequestInit]

    expect(requestUrl.origin).toBe('https://lrclib.net')
    expect(requestUrl.pathname).toBe('/api/get')
    expect(requestUrl.searchParams.get('track_name')).toBe('Test Song')
    expect(requestUrl.searchParams.get('duration')).toBe('225')
    expect(requestInit).toMatchObject({
      headers: { 'Lrclib-Client': 'solver/1.0.0' },
      redirect: 'error'
    })
    expect(result.synchronized).toBe(true)
  })

  it('falls back to LRCLIB search when exact metadata is absent', async () => {
    vi.spyOn(mcpRuntime, 'callAgentMcpTool').mockResolvedValue(playbackResult())
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json([
          {
            id: 42,
            trackName: 'Test Song',
            artistName: 'Test Artist',
            albumName: 'Test Album',
            duration: 225,
            instrumental: false,
            plainLyrics: null,
            syncedLyrics: '[00:01.00] First line'
          }
        ])
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await lyricsClient.getCurrentTrackLyrics()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[1]![0] as URL).pathname).toBe('/api/search')
    expect(result.match?.id).toBe(42)
  })

  it('turns Spotify MCP authentication failures into an actionable error', async () => {
    vi.spyOn(mcpRuntime, 'callAgentMcpTool').mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'Not authenticated. Run spotify-mcp auth first.' }]
    })

    await expect(lyricsClient.getCurrentTrack()).rejects.toThrow(
      'Spotify is not authenticated; authenticate it through `/a` first'
    )
  })

  it('rejects oversized LRCLIB responses', async () => {
    vi.spyOn(mcpRuntime, 'callAgentMcpTool').mockResolvedValue(playbackResult())
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('x', {
          headers: { 'Content-Length': String(512 * 1024 + 1) }
        })
      )
    )

    await expect(lyricsClient.getCurrentTrackLyrics()).rejects.toThrow(
      'LRCLIB returned too much data'
    )
  })
})
