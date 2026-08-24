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
  LYRICS_OFFSET_BUTTON_ID,
  LYRICS_SESSION_KEY,
  LYRICS_STOP_BUTTON_ID,
  PUBLIC_LYRICS_INTERACTION_MS,
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
    expect(rendered).toContain('## __Current line__')
    expect(rendered).toContain('After one')
    expect(rendered).toContain('After two')
    expect(collectCustomIds(edit.components)).toEqual([
      expect.stringMatching(new RegExp(`^${LYRICS_OFFSET_BUTTON_ID}:[a-f0-9]{16}:minus-one$`)),
      expect.stringMatching(new RegExp(`^${LYRICS_OFFSET_BUTTON_ID}:[a-f0-9]{16}:minus-half$`)),
      expect.stringMatching(new RegExp(`^${LYRICS_OFFSET_BUTTON_ID}:[a-f0-9]{16}:plus-half$`)),
      expect.stringMatching(new RegExp(`^${LYRICS_OFFSET_BUTTON_ID}:[a-f0-9]{16}:plus-one$`))
    ])
    expect(
      edit.components.map((component) => (component as { type?: number }).type)
    ).toEqual([17, 17, 17, 1])
    expect(rendered).toContain('"label":"-1s"')
    expect(rendered).toContain('"label":"-0.5s"')
    expect(rendered).toContain('"label":"+0.5s"')
    expect(rendered).toContain('"label":"+1s"')
    expect(rendered).not.toContain('"label":"Japanese"')
    expect(rendered).not.toContain('"label":"Korean pronunciation"')
    expect(rendered).not.toContain('"label":"Stop"')
    expect(rendered).toContain('render interval: 0.401s')
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

    expect(JSON.stringify(initial)).toContain('## __君の名は__')
    expect(JSON.stringify(initial)).not.toContain('키미노나와')
    expect(JSON.stringify(initial)).toContain('"label":"Japanese"')
    expect(JSON.stringify(initial)).toContain('"label":"Korean pronunciation"')

    const modeCalls = await dispatch(
      buttonJSON(initial.components, koreanModeId, {}, MessageFlags.IsComponentsV2),
      subs
    )
    const callback = getCallback(modeCalls) as { type: number }
    const korean = JSON.stringify(calls.filter(({ method }) => method === 'PATCH').at(-1)?.body)

    expect(callback.type).toBe(InteractionResponseType.DeferredMessageUpdate)
    expect(korean).toContain('## __키미노나와__')
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

    expect(japanese).toContain('## __君の名は__')
    expect(japanese).not.toContain('## 키미노나와')
  })

  it('supports a public live session through --pub', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const calls = await startCommand('lyrics --pub')
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    const published = getEdit(calls)

    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeFalsy()
    expect(JSON.stringify(published)).toContain('Live lyrics: Test Song')
    expect(publicMessageBody(calls)).toBeUndefined()
    expect(JSON.parse(getStoredValue(LYRICS_SESSION_KEY)!)).toMatchObject({
      version: 2,
      ownerId: '666666666666666666',
      channelId: '777777777777777777'
    })
    expect(JSON.parse(getStoredValue(LYRICS_SESSION_KEY)!)).not.toHaveProperty('messageId')
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
    expect(JSON.stringify(patch.mock.calls[0]![1])).toContain('render interval: 1s')
    client.destroy()
  })

  it('restores a public interaction session into a new bot message after restart', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    vi.spyOn(lyricsClient, 'getCurrentTrack').mockResolvedValue(spotifyTrack())
    vi.spyOn(lyricsClient, 'getLyricsForTrack').mockResolvedValue(currentLyrics())
    setStoredValue(
      LYRICS_SESSION_KEY,
      JSON.stringify({
        version: 2,
        token: '0123456789abcdef',
        ownerId: '111111111111111111',
        channelId: '777777777777777777',
        startedAt: 1_000
      })
    )
    const client = new Client({ intents: [] })
    const post = vi.fn<(_route: string, _request: unknown) => Promise<object>>(async () => ({
      id: 'restored-message'
    }))
    ;(client.rest as unknown as { post: typeof post }).post = post

    await expect(restoreLyricsSession(client)).resolves.toBe(true)

    expect(post).toHaveBeenCalledWith(
      '/channels/777777777777777777/messages',
      expect.objectContaining({
        body: expect.objectContaining({ flags: MessageFlags.IsComponentsV2 })
      })
    )
    expect(JSON.stringify(post.mock.calls[0]![1])).toContain('Live lyrics: Test Song')
    expect(JSON.parse(getStoredValue(LYRICS_SESSION_KEY)!)).toMatchObject({
      version: 2,
      messageId: 'restored-message'
    })
    client.destroy()
  })

  it('moves a public interaction session to a bot message after ten minutes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const calls = await startCommand('lyrics --pub')

    await vi.advanceTimersByTimeAsync(PUBLIC_LYRICS_INTERACTION_MS - 1)
    expect(publicMessageBody(calls)).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1)

    const published = publicMessageBody(calls)
    expect(JSON.stringify(published)).toContain('Live lyrics: Test Song')
    expect(JSON.stringify(published)).toContain('render interval: 1s')
    expect(JSON.stringify(calls.filter(({ method }) => method === 'PATCH').at(-1)?.body)).toContain(
      'Continued in a bot message after 10 minutes.'
    )
    expect(JSON.parse(getStoredValue(LYRICS_SESSION_KEY)!)).toMatchObject({
      version: 2,
      channelId: '777777777777777777',
      messageId: 'public-message-0'
    })

    const migrationCallCount = calls.length
    await vi.advanceTimersByTimeAsync(2_000)

    expect(
      calls.slice(migrationCallCount).some(
        ({ route }) => route === '/channels/777777777777777777/messages/public-message-0'
      )
    ).toBe(true)
  })

  it('keeps using interaction edits when migration message creation fails', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const calls = await startCommand('lyrics --pub', {
      postError: (route) =>
        route === '/channels/777777777777777777/messages'
          ? new Error('Missing Send Messages')
          : undefined
    })

    await vi.advanceTimersByTimeAsync(PUBLIC_LYRICS_INTERACTION_MS)

    const patches = calls.filter(({ method }) => method === 'PATCH')
    expect(patches.length).toBeGreaterThan(1)
    expect(patches.every(({ route }) => route.includes('/webhooks/'))).toBe(true)
    expect(JSON.parse(getStoredValue(LYRICS_SESSION_KEY)!)).toMatchObject({
      version: 2,
      channelId: '777777777777777777'
    })
    expect(JSON.parse(getStoredValue(LYRICS_SESSION_KEY)!)).not.toHaveProperty('messageId')
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
    expect(JSON.stringify(updated)).toContain('Spotify +1s')
    expect(JSON.stringify(updated)).toContain('## __After one__')
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

    expect(JSON.stringify(positive)).toContain('Spotify +0.5s')
    expect(JSON.stringify(positive)).toContain('## __After__ one')

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

    expect(JSON.stringify(negative)).toContain('Spotify -0.5s')
    expect(JSON.stringify(negative)).toContain('## __Current__ line')
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
    expect(JSON.stringify(updated)).toContain('Spotify +0.5s')
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

    expect(later).toContain('Spotify +0.5s')
    expect(later).toContain('## __After__ one')
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
  function lyricWindowContent(view: LiveLyricsView): string {
    const component = formatLiveLyrics(view)[2]
    if (!component || typeof component === 'string') throw new Error('missing lyric window')
    return (component.toJSON() as { content: string }).content.replace(/^## Lyrics\n/, '')
  }

  it('renders a five-line synchronized window around the current line', () => {
    const lines = parseSyncedLyrics(currentLyrics().match!.syncedLyrics)
    const view: LiveLyricsView = {
      mode: 'lyrics',
      track: spotifyTrack(),
      lines,
      detail: '',
      anchorProgressMs: 62_500,
      anchorTimeMs: 0,
      lyricsSource: 'SyncLRC',
      currentIndex: currentSyncedLineIndex(lines, 62_500),
      progressMs: 62_500,
      spotifyProgressMs: 62_500,
      discordOffsetMs: 250,
      renderIntervalMs: 401,
      offsetMs: 0,
      stopped: false,
      displayMode: 'japanese'
    }
    const rendered = JSON.stringify(
      formatLiveLyrics(view).map((component) =>
        typeof component === 'string' ? component : component.toJSON()
      )
    )

    expect(rendered).toContain('## __Current line__')
    expect(rendered).toContain('Before two')
    expect(rendered).toContain('After two')
    expect(rendered).toContain('offsets: Discord +0.25s / Spotify 0s')
    expect(rendered).toContain('source: SyncLRC')
  })

  it('pads the start, pre-start, and end of a song to keep the current line centered', () => {
    const lines = parseSyncedLyrics(
      '[00:01.00] First\n[00:02.00] Second\n[00:03.00] Third\n[00:04.00] Fourth\n[00:05.00] Fifth'
    )
    const view: LiveLyricsView = {
      mode: 'lyrics',
      track: spotifyTrack(),
      lines,
      detail: '',
      anchorProgressMs: 0,
      anchorTimeMs: 0,
      currentIndex: -1,
      progressMs: 0,
      spotifyProgressMs: 0,
      discordOffsetMs: 0,
      renderIntervalMs: 401,
      offsetMs: 0,
      stopped: false,
      displayMode: 'japanese'
    }

    expect(lyricWindowContent(view).split('\n')).toEqual([
      '-# \u200b',
      '-# \u200b',
      '**Waiting for the first synchronized line**',
      '-# First',
      '-# Second'
    ])

    view.currentIndex = 0
    view.progressMs = 1_000
    expect(lyricWindowContent(view).split('\n')).toEqual([
      '-# \u200b',
      '-# \u200b',
      '## __First__',
      '-# Second',
      '-# Third'
    ])

    view.currentIndex = 4
    view.progressMs = 5_000
    expect(lyricWindowContent(view).split('\n')).toEqual([
      '-# Third',
      '-# Fourth',
      '## __Fifth__',
      '-# \u200b',
      '-# \u200b'
    ])
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
      discordOffsetMs: 0,
      renderIntervalMs: 401,
      offsetMs: 0,
      stopped: false,
      displayMode: 'japanese'
    }
    const rendered = JSON.stringify(
      formatLiveLyrics(view).map((component) =>
        typeof component === 'string' ? component : component.toJSON()
      )
    )

    expect(rendered).toContain('## __君の名は__')
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
      discordOffsetMs: 0,
      renderIntervalMs: 401,
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
    expect(rendered).toContain('## __키미노나와__')
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
      discordOffsetMs: 0,
      renderIntervalMs: 401,
      offsetMs: 0,
      stopped: false,
      displayMode: 'korean-pronunciation'
    }
    const rendered = JSON.stringify(
      formatLiveLyrics(view).map((component) =>
        typeof component === 'string' ? component : component.toJSON()
      )
    )

    expect(rendered).toContain('## __키미노나와__ / Never mind')
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
      discordOffsetMs: 0,
      renderIntervalMs: 401,
      offsetMs: 0,
      stopped: false,
      displayMode: 'japanese'
    }
    const rendered = JSON.stringify(
      formatLiveLyrics(view).map((component) =>
        typeof component === 'string' ? component : component.toJSON()
      )
    )

    expect(rendered).toContain('## __First__ / Second')
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

  it('uses SyncLRC when LRCLIB has no synchronized lyrics', async () => {
    vi.spyOn(mcpRuntime, 'callAgentMcpTool').mockResolvedValue(playbackResult())
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          id: 42,
          trackName: 'Test Song',
          artistName: 'Test Artist',
          albumName: 'Test Album',
          duration: 225,
          instrumental: false,
          plainLyrics: 'Unsynchronized lyrics',
          syncedLyrics: null
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          lyrics: '[00:01.00] First line\n[00:02.00] Second line',
          type: 'synced',
          track: 'Test Song',
          artist: 'Test Artist',
          album: 'Test Album',
          duration: 225,
          instrumental: false
        })
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await lyricsClient.getCurrentTrackLyrics()
    const [requestUrl, requestInit] = fetchMock.mock.calls[1] as [URL, RequestInit]

    expect(requestUrl.origin).toBe('https://api.synclrc.dev')
    expect(requestUrl.pathname).toBe('/lyrics')
    expect(requestUrl.searchParams.get('track')).toBe('Test Song')
    expect(requestUrl.searchParams.get('artist')).toBe('Test Artist')
    expect(requestUrl.searchParams.get('album')).toBe('Test Album')
    expect(requestUrl.searchParams.get('duration')).toBe('225')
    expect(requestUrl.searchParams.get('type')).toBe('synced')
    expect(requestInit).toMatchObject({ redirect: 'error' })
    expect(result).toMatchObject({
      synchronized: true,
      match: { source: 'SyncLRC', syncedLyrics: '[00:01.00] First line\n[00:02.00] Second line' }
    })
  })

  it('uses LrcApi when SyncLRC returns malformed lyrics', async () => {
    vi.spyOn(mcpRuntime, 'callAgentMcpTool').mockResolvedValue(playbackResult())
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ lyrics: 'Missing timestamps', type: 'synced' }))
      .mockResolvedValueOnce(
        Response.json([
          {
            title: 'Different Song',
            artist: 'Different Artist',
            album: 'Different Album',
            lyrics: '[00:01.00] Wrong line'
          },
          {
            title: 'Test Song',
            artist: 'Test Artist',
            album: 'Test Album',
            lyrics: '[Verse]\n[00:01.00] First line\n[00:02.00] Second line'
          }
        ])
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await lyricsClient.getCurrentTrackLyrics()
    const [requestUrl, requestInit] = fetchMock.mock.calls[3] as [URL, RequestInit]

    expect(requestUrl.origin).toBe('https://api.lrc.cx')
    expect(requestUrl.pathname).toBe('/jsonapi')
    expect(requestUrl.searchParams.get('title')).toBe('Test Song')
    expect(requestUrl.searchParams.get('artist')).toBe('Test Artist')
    expect(requestInit).toMatchObject({ redirect: 'error' })
    expect(result).toMatchObject({ synchronized: true, match: { source: 'LrcApi' } })
  })

  it('continues to LrcApi when SyncLRC times out', async () => {
    vi.spyOn(mcpRuntime, 'callAgentMcpTool').mockResolvedValue(playbackResult())
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'))
      .mockResolvedValueOnce(
        Response.json([
          {
            title: 'Test Song',
            artist: 'Test Artist',
            album: 'Test Album',
            lyrics: '[00:01.00] Fallback line'
          }
        ])
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(lyricsClient.getCurrentTrackLyrics()).resolves.toMatchObject({
      synchronized: true,
      match: { source: 'LrcApi' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('rejects synchronized fallback lyrics for a different track', async () => {
    vi.spyOn(mcpRuntime, 'callAgentMcpTool').mockResolvedValue(playbackResult())
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(
        Response.json({
          lyrics: '[00:01.00] Wrong SyncLRC line',
          type: 'synced',
          track: 'Completely Different Song',
          artist: 'Different Artist',
          album: 'Different Album',
          duration: 300,
          instrumental: false
        })
      )
      .mockResolvedValueOnce(
        Response.json([
          {
            title: 'Another Wrong Song',
            artist: 'Another Artist',
            album: 'Another Album',
            lyrics: '[00:01.00] Wrong LrcApi line'
          }
        ])
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(lyricsClient.getCurrentTrackLyrics()).resolves.toEqual({
      track: spotifyTrack(),
      match: null,
      lyrics: null,
      synchronized: false
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
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
