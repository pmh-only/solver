import { afterEach, describe, expect, it, vi } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import * as mcpRuntime from '../agent/mcp-runtime.js'
import {
  lyricsClient,
  parseSpotifyCurrentTrack,
  type CurrentTrackLyrics
} from '../commands/_lyrics.js'
import { formatCurrentTrackLyrics, subcommand as lyrics } from '../commands/lyrics.js'
import {
  autocompleteJSON,
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands
} from './e2e.js'

const subs = makeSubcommands(lyrics)

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

function currentLyrics(overrides: Partial<CurrentTrackLyrics> = {}): CurrentTrackLyrics {
  return {
    track: {
      id: 'abc123',
      uri: 'spotify:track:abc123',
      name: 'Test Song',
      artists: 'Test Artist',
      album: 'Test Album',
      durationSeconds: 225,
      progressSeconds: 62,
      isPlaying: true
    },
    match: {
      id: 42,
      trackName: 'Test Song',
      artistName: 'Test Artist',
      albumName: 'Test Album',
      duration: 225,
      instrumental: false,
      plainLyrics: 'First line\nSecond line',
      syncedLyrics: '[00:01.00] First line\n[00:02.00] Second line'
    },
    lyrics: 'First line\nSecond line',
    synchronized: true,
    ...overrides
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('lyrics command', () => {
  it('defers then displays lyrics for the current Spotify track', async () => {
    vi.spyOn(lyricsClient, 'getCurrentTrackLyrics').mockResolvedValue(currentLyrics())

    const calls = await dispatch(commandJSON('lyrics'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const edit = getEdit(calls)

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(JSON.stringify(edit)).toContain('Lyrics: Test Song')
    expect(JSON.stringify(edit)).toContain('First line')
    expect(JSON.stringify(edit)).toContain('source: LRCLIB')
  })

  it('supports a public response through --pub', async () => {
    vi.spyOn(lyricsClient, 'getCurrentTrackLyrics').mockResolvedValue(currentLyrics())

    const calls = await dispatch(commandJSON('lyrics --pub'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })

  it('rejects positional arguments without calling external services', async () => {
    const lookup = vi.spyOn(lyricsClient, 'getCurrentTrackLyrics')
    const calls = await dispatch(commandJSON('lyrics another song'), subs)
    const callback = getCallback(calls)

    expect(JSON.stringify(callback)).toContain('lyrics takes no arguments')
    expect(lookup).not.toHaveBeenCalled()
  })

  it('appears in command autocomplete', async () => {
    const calls = await dispatch(autocompleteJSON('lyr'), subs)
    const callback = getCallback(calls) as { data: { choices: Array<{ value: string }> } }

    expect(callback.data.choices.some(({ value }) => value === 'lyrics')).toBe(true)
  })

  it('bounds long lyrics before building Discord components', () => {
    const formatted = formatCurrentTrackLyrics(
      currentLyrics({ lyrics: `line\n${'x'.repeat(20_000)}` })
    )
    const serialized = JSON.stringify(
      formatted.map((component) => (typeof component === 'string' ? component : component.toJSON()))
    )

    expect(serialized).toContain('Lyrics truncated to fit Discord limits')
    expect(serialized.length).toBeLessThan(15_000)
  })
})

describe('lyrics runtime', () => {
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
        name: 'Test Song',
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
    expect(result.lyrics).toBe('First line\nSecond line')
    expect(result.synchronized).toBe(true)
  })

  it('falls back to LRCLIB search and strips timestamps when only synced lyrics exist', async () => {
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
            syncedLyrics: '[00:01.00] First line\n[00:02.00] Second line'
          }
        ])
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await lyricsClient.getCurrentTrackLyrics()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[1]![0] as URL).pathname).toBe('/api/search')
    expect(result.lyrics).toBe('First line\nSecond line')
  })

  it('reports when Spotify has no current playback', () => {
    expect(() =>
      parseSpotifyCurrentTrack({
        content: [{ type: 'text', text: 'Nothing is currently playing.' }]
      })
    ).toThrow('No Spotify track is currently playing')
  })

  it('turns Spotify MCP authentication failures into an actionable error', async () => {
    vi.spyOn(mcpRuntime, 'callAgentMcpTool').mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'Not authenticated. Run spotify-mcp auth first.' }]
    })

    await expect(lyricsClient.getCurrentTrackLyrics()).rejects.toThrow(
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
