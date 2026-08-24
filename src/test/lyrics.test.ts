import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client, InteractionResponseType, MessageFlags } from 'discord.js'
import * as mcpRuntime from '../agent/mcp-runtime.js'
import {
  lyricsClient,
  parseSpotifyCurrentTrack,
  type CurrentTrackLyrics,
  type SpotifyCurrentTrack
} from '../commands/_lyrics.js'
import {
  LYRICS_DISPLAY_BUTTON_ID,
  LYRICS_OFFSET_BUTTON_ID,
  LYRICS_SESSION_KEY,
  LYRICS_STOP_BUTTON_ID,
  formatLiveLyrics,
  restoreLyricsSession,
  subcommand as lyrics
} from '../commands/lyrics.js'
import {
  clearLyricsSessions,
  currentSyncedLineIndex,
  LYRICS_OFFSETS_KEY,
  parseSyncedLyrics,
  type LiveLyricsView
} from '../commands/lyrics-session.js'
import { deleteStoredValue, getStoredValue, setStoredValue } from '../helpers/kv-store.js'
import {
  autocompleteJSON,
  buttonJSON,
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands,
  type DispatchOptions,
  type RestCall
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

function publicMessageBody(calls: RestCall[]): { components: unknown[] } {
  return calls.find(
    ({ method, route }) => method === 'POST' && route === '/channels/777777777777777777/messages'
  )?.body as { components: unknown[] }
}

async function startCommand(input = 'lyrics', options: DispatchOptions = {}) {
  vi.spyOn(lyricsClient, 'getCurrentTrack').mockResolvedValue(spotifyTrack())
  vi.spyOn(lyricsClient, 'getLyricsForTrack').mockResolvedValue(currentLyrics())
  return dispatch(commandJSON(input, { channel: { id: '777777777777777777', type: 1 } }), subs, {
    postResult: (route) =>
      route === '/channels/777777777777777777/messages'
        ? { id: 'public-message-0', channel_id: '777777777777777777' }
        : {},
    ...options
  })
}

beforeEach(() => {
  deleteStoredValue(LYRICS_OFFSETS_KEY)
  deleteStoredValue(LYRICS_SESSION_KEY)
})

afterEach(async () => {
  await clearLyricsSessions()
  deleteStoredValue(LYRICS_OFFSETS_KEY)
  deleteStoredValue(LYRICS_SESSION_KEY)
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
    expect(rendered).toContain('## *Current line*')
    expect(rendered).toContain('After one')
    expect(rendered).toContain('After two')
    expect(collectCustomIds(edit.components)).toEqual([
      expect.stringMatching(new RegExp(`^${LYRICS_DISPLAY_BUTTON_ID}:[a-f0-9]{16}:japanese$`)),
      expect.stringMatching(
        new RegExp(`^${LYRICS_DISPLAY_BUTTON_ID}:[a-f0-9]{16}:korean-pronunciation$`)
      ),
      expect.stringMatching(new RegExp(`^${LYRICS_OFFSET_BUTTON_ID}:[a-f0-9]{16}:minus-one$`)),
      expect.stringMatching(new RegExp(`^${LYRICS_OFFSET_BUTTON_ID}:[a-f0-9]{16}:minus-half$`)),
      expect.stringMatching(new RegExp(`^${LYRICS_OFFSET_BUTTON_ID}:[a-f0-9]{16}:plus-half$`)),
      expect.stringMatching(new RegExp(`^${LYRICS_OFFSET_BUTTON_ID}:[a-f0-9]{16}:plus-one$`)),
      expect.stringMatching(new RegExp(`^${LYRICS_STOP_BUTTON_ID}:[a-f0-9]{16}$`))
    ])
    expect(rendered).toContain('"label":"-1s"')
    expect(rendered).toContain('"label":"-0.5s"')
    expect(rendered).toContain('"label":"+0.5s"')
    expect(rendered).toContain('"label":"+1s"')
    expect(rendered).toContain('"label":"Japanese"')
    expect(rendered).toContain('"label":"Korean pronunciation"')
  })

  it('switches between Japanese and Korean pronunciation display modes', async () => {
    const track = spotifyTrack()
    vi.spyOn(lyricsClient, 'getCurrentTrack').mockResolvedValue(track)
    vi.spyOn(lyricsClient, 'getLyricsForTrack').mockResolvedValue({
      ...currentLyrics(track),
      match: {
        ...currentLyrics(track).match!,
        plainLyrics: '君の名は',
        syncedLyrics: '[01:02.00] 君の名は'
      },
      lyrics: '君の名は'
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 }))
    )
    const calls = await dispatch(
      commandJSON('lyrics', { channel: { id: '777777777777777777', type: 1 } }),
      subs
    )
    const initial = getEdit(calls) as { components: unknown[] }
    const koreanModeId = collectCustomIds(initial.components).find((customId) =>
      customId.endsWith(':korean-pronunciation')
    )!

    expect(JSON.stringify(initial)).toContain('## *君の名は*')
    expect(JSON.stringify(initial)).not.toContain('키미노나와')

    const modeCalls = await dispatch(
      buttonJSON(initial.components, koreanModeId, {}, MessageFlags.IsComponentsV2),
      subs
    )
    const callback = getCallback(modeCalls) as { type: number }
    const korean = JSON.stringify(calls.filter(({ method }) => method === 'PATCH').at(-1)?.body)

    expect(callback.type).toBe(InteractionResponseType.DeferredMessageUpdate)
    expect(korean).toContain('## *키미노나와*')
    expect(korean).not.toContain('## 君の名は')

    const koreanEdit = calls.filter(({ method }) => method === 'PATCH').at(-1)?.body as {
      components: unknown[]
    }
    const japaneseModeId = collectCustomIds(koreanEdit.components).find((customId) =>
      customId.endsWith(':japanese')
    )!
    await dispatch(
      buttonJSON(koreanEdit.components, japaneseModeId, {}, MessageFlags.IsComponentsV2),
      subs
    )
    const japanese = JSON.stringify(calls.filter(({ method }) => method === 'PATCH').at(-1)?.body)

    expect(japanese).toContain('## *君の名は*')
    expect(japanese).not.toContain('## 키미노나와')
  })

  it('supports a public live session through --pub', async () => {
    const calls = await startCommand('lyrics --pub')
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const published = publicMessageBody(calls)

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeFalsy()
    expect(JSON.stringify(published)).toContain('Live lyrics: Test Song')
    expect(
      calls.some(({ method, route }) => method === 'DELETE' && route.includes('/webhooks/'))
    ).toBe(true)
    expect(JSON.parse(getStoredValue(LYRICS_SESSION_KEY)!)).toMatchObject({
      version: 1,
      channelId: '777777777777777777',
      messageId: 'public-message-0'
    })
  })

  it('restores a persisted public session and resumes bot-authenticated edits', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    vi.spyOn(lyricsClient, 'getCurrentTrack').mockResolvedValue(spotifyTrack())
    vi.spyOn(lyricsClient, 'getLyricsForTrack').mockResolvedValue(currentLyrics())
    setStoredValue(
      LYRICS_SESSION_KEY,
      JSON.stringify({
        version: 1,
        token: '0123456789abcdef',
        ownerId: '111111111111111111',
        channelId: '777777777777777777',
        messageId: '888888888888888888',
        startedAt: 1_000
      })
    )
    const client = new Client({ intents: [] })
    const patch = vi.fn<(_route: string, _request: unknown) => Promise<object>>(async () => ({}))
    ;(client.rest as unknown as { patch: typeof patch }).patch = patch

    await expect(restoreLyricsSession(client)).resolves.toBe(true)

    expect(patch).toHaveBeenCalledWith(
      '/channels/777777777777777777/messages/888888888888888888',
      expect.objectContaining({
        body: expect.objectContaining({ flags: MessageFlags.IsComponentsV2 })
      })
    )
    expect(JSON.stringify(patch.mock.calls[0]![1])).toContain('Live lyrics: Test Song')
    client.destroy()
  })

  it('uses bot-authenticated message edits for public sessions after the initial reply', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const calls = await startCommand('lyrics --pub')

    await vi.advanceTimersByTimeAsync(2_000)

    const patches = calls.filter(({ method }) => method === 'PATCH')
    expect(patches.length).toBeGreaterThan(0)
    expect(
      patches.every(
        ({ route }) => route === '/channels/777777777777777777/messages/public-message-0'
      )
    ).toBe(true)
  })

  it('keeps the public interaction reply durable when normal message creation fails', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const calls = await startCommand('lyrics --pub', {
      postError: (route) =>
        route === '/channels/777777777777777777/messages'
          ? new Error('Missing Send Messages')
          : undefined
    })

    await vi.advanceTimersByTimeAsync(2_000)

    const patches = calls.filter(({ method }) => method === 'PATCH')
    expect(patches.length).toBeGreaterThan(1)
    expect(patches[0]!.route).toContain('/webhooks/')
    expect(
      patches.slice(1).every(({ route }) => route === '/channels/777777777777777777/messages/0')
    ).toBe(true)
    expect(JSON.parse(getStoredValue(LYRICS_SESSION_KEY)!)).toMatchObject({
      channelId: '777777777777777777',
      messageId: '0'
    })
  })

  it('advances synchronized lyrics by one second when the owner presses +1s', async () => {
    const startCalls = await startCommand()
    const edit = getEdit(startCalls) as { components: unknown[] }
    const plusId = collectCustomIds(edit.components).find(
      (customId) =>
        customId.startsWith(`${LYRICS_OFFSET_BUTTON_ID}:`) && customId.endsWith(':plus-one')
    )!
    const offsetCalls = await dispatch(
      buttonJSON(edit.components, plusId, {}, MessageFlags.IsComponentsV2),
      subs
    )
    const callback = getCallback(offsetCalls) as { type: number }
    const updated = startCalls.filter(({ method }) => method === 'PATCH').at(-1)?.body

    expect(callback.type).toBe(InteractionResponseType.DeferredMessageUpdate)
    expect(JSON.stringify(updated)).toContain('lyrics offset: +1s')
    expect(JSON.stringify(updated)).toContain('## *After one*')
  })

  it('supports positive and negative half-second lyric adjustments', async () => {
    const positiveCalls = await startCommand()
    const positiveEdit = getEdit(positiveCalls) as { components: unknown[] }
    const plusHalfId = collectCustomIds(positiveEdit.components).find((customId) =>
      customId.endsWith(':plus-half')
    )!
    await dispatch(
      buttonJSON(positiveEdit.components, plusHalfId, {}, MessageFlags.IsComponentsV2),
      subs
    )
    const positive = positiveCalls.filter(({ method }) => method === 'PATCH').at(-1)?.body

    expect(JSON.stringify(positive)).toContain('lyrics offset: +0.5s')
    expect(JSON.stringify(positive)).toContain('## *After* one')

    await clearLyricsSessions()
    deleteStoredValue(LYRICS_OFFSETS_KEY)
    vi.restoreAllMocks()
    const negativeCalls = await startCommand()
    const negativeEdit = getEdit(negativeCalls) as { components: unknown[] }
    const minusHalfId = collectCustomIds(negativeEdit.components).find((customId) =>
      customId.endsWith(':minus-half')
    )!
    await dispatch(
      buttonJSON(negativeEdit.components, minusHalfId, {}, MessageFlags.IsComponentsV2),
      subs
    )
    const negative = negativeCalls.filter(({ method }) => method === 'PATCH').at(-1)?.body

    expect(JSON.stringify(negative)).toContain('lyrics offset: -0.5s')
    expect(JSON.stringify(negative)).toContain('## *Current* line')
  })

  it("allows an administrator to adjust another user's lyric timing", async () => {
    process.env.ADMIN_USER_IDS = '666666666666666666,777777777777777777'
    const startCalls = await startCommand()
    const edit = getEdit(startCalls) as { components: unknown[] }
    const plusHalfId = collectCustomIds(edit.components).find((customId) =>
      customId.endsWith(':plus-half')
    )!
    const offsetCalls = await dispatch(
      buttonJSON(
        edit.components,
        plusHalfId,
        {
          user: {
            id: '777777777777777777',
            username: 'adminuser',
            discriminator: '0',
            avatar: null,
            global_name: 'Admin User'
          }
        },
        MessageFlags.IsComponentsV2
      ),
      subs
    )
    const callback = getCallback(offsetCalls) as { type: number }
    const updated = startCalls.filter(({ method }) => method === 'PATCH').at(-1)?.body

    expect(callback.type).toBe(InteractionResponseType.DeferredMessageUpdate)
    expect(JSON.stringify(updated)).toContain('lyrics offset: +0.5s')
  })

  it('restores a song timing adjustment in a later live session', async () => {
    const firstCalls = await startCommand()
    const firstEdit = getEdit(firstCalls) as { components: unknown[] }
    const plusHalfId = collectCustomIds(firstEdit.components).find((customId) =>
      customId.endsWith(':plus-half')
    )!
    await dispatch(
      buttonJSON(firstEdit.components, plusHalfId, {}, MessageFlags.IsComponentsV2),
      subs
    )

    await clearLyricsSessions()
    vi.restoreAllMocks()
    const laterCalls = await startCommand()
    const later = JSON.stringify(getEdit(laterCalls))

    expect(later).toContain('lyrics offset: +0.5s')
    expect(later).toContain('## *After* one')
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
    const edit = publicMessageBody(startCalls)
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
      stopped: false,
      displayMode: 'japanese'
    }
    const rendered = JSON.stringify(
      formatLiveLyrics(view).map((component) =>
        typeof component === 'string' ? component : component.toJSON()
      )
    )

    expect(rendered).toContain('## *Current line*')
    expect(rendered).toContain('Before two')
    expect(rendered).toContain('After two')
  })

  it('renders only Japanese lyrics in Japanese display mode', () => {
    const view: LiveLyricsView = {
      mode: 'lyrics',
      track: spotifyTrack(),
      lines: [{ timeMs: 0, text: '君の名は', pronunciation: '키미노나와' }],
      detail: '',
      anchorProgressMs: 0,
      anchorTimeMs: 0,
      currentIndex: 0,
      progressMs: 0,
      spotifyProgressMs: 0,
      offsetMs: 0,
      stopped: false,
      displayMode: 'japanese'
    }
    const rendered = JSON.stringify(
      formatLiveLyrics(view).map((component) =>
        typeof component === 'string' ? component : component.toJSON()
      )
    )

    expect(rendered).toContain('## *君の名は*')
    expect(rendered).not.toContain('키미노나와')
  })

  it('attributes pronunciation sourced from Vocaloid Lyrics Wiki', () => {
    const sourceUrl = 'https://vocaloidlyrics.miraheze.org/wiki/Test_Song'
    const view: LiveLyricsView = {
      mode: 'lyrics',
      track: spotifyTrack(),
      lines: [
        { timeMs: 0, text: '君の名は', pronunciation: '키미노나와', pronunciationSource: sourceUrl }
      ],
      detail: '',
      anchorProgressMs: 0,
      anchorTimeMs: 0,
      currentIndex: 0,
      progressMs: 0,
      spotifyProgressMs: 0,
      offsetMs: 0,
      stopped: false,
      displayMode: 'korean-pronunciation'
    }
    const rendered = JSON.stringify(
      formatLiveLyrics(view).map((component) =>
        typeof component === 'string' ? component : component.toJSON()
      )
    )

    expect(rendered).toContain(`[Vocaloid Lyrics Wiki](${sourceUrl})`)
    expect(rendered).toContain('CC BY-SA 4.0')
    expect(rendered).toContain('## *키미노나와*')
    expect(rendered).not.toContain('## 君の名は')
  })

  it('keeps untranslated parts of a merged line in Korean pronunciation mode', () => {
    const view: LiveLyricsView = {
      mode: 'lyrics',
      track: spotifyTrack(),
      lines: [{ timeMs: 0, text: '君の名は\nNever mind', pronunciation: '키미노나와\n' }],
      detail: '',
      anchorProgressMs: 0,
      anchorTimeMs: 0,
      currentIndex: 0,
      progressMs: 0,
      spotifyProgressMs: 0,
      offsetMs: 0,
      stopped: false,
      displayMode: 'korean-pronunciation'
    }
    const rendered = JSON.stringify(
      formatLiveLyrics(view).map((component) =>
        typeof component === 'string' ? component : component.toJSON()
      )
    )

    expect(rendered).toContain('## *키미노나와* / Never mind')
  })

  it('separates lines merged into a synchronized block with slashes', () => {
    const view: LiveLyricsView = {
      mode: 'lyrics',
      track: spotifyTrack(),
      lines: [{ timeMs: 0, text: 'First\nSecond' }],
      detail: '',
      anchorProgressMs: 0,
      anchorTimeMs: 0,
      currentIndex: 0,
      progressMs: 0,
      spotifyProgressMs: 0,
      offsetMs: 0,
      stopped: false,
      displayMode: 'japanese'
    }
    const rendered = JSON.stringify(
      formatLiveLyrics(view).map((component) =>
        typeof component === 'string' ? component : component.toJSON()
      )
    )

    expect(rendered).toContain('## *First* / Second')
    expect(rendered).not.toContain('## First\\n## Second')
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
