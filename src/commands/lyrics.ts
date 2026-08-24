import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  RESTEvents,
  Routes,
  type APIRequest,
  type ButtonInteraction,
  type Client,
  type ResponseLike
} from 'discord.js'
import { randomUUID } from 'node:crypto'
import { isAdminUser } from '../authorization.js'
import type { Flags } from '../flags.js'
import { deleteStoredValue, getStoredValue, setStoredValue } from '../helpers/kv-store.js'
import type { Subcommand } from '../types.js'
import {
  commandContainer,
  commandReferenceReply,
  deferCommandResponse,
  errorContainer,
  sendCommandReply,
  separator,
  summarySection,
  text,
  type TopLevelComponent
} from '../components.js'
import {
  LiveLyricsSession,
  LyricsEditRateLimit,
  MAX_LYRICS_OFFSET_MS,
  PUBLIC_LYRICS_SESSION_MS,
  currentSyncedWordCount,
  displayedLyricText,
  getLyricsSession,
  liveLyricsView,
  loadLyricsOffset,
  loadInitialLiveLyricsState,
  registerLyricsSession,
  stopActiveLyricsSessions,
  syncedLyricsWindow,
  unregisterLyricsSession,
  type LyricsDisplayMode,
  type LiveLyricsView
} from './lyrics-session.js'

export const LYRICS_STOP_BUTTON_ID = 'lyrics-stop'
export const LYRICS_OFFSET_BUTTON_ID = 'lyrics-offset'
export const LYRICS_DISPLAY_BUTTON_ID = 'lyrics-display'
export const LYRICS_SESSION_KEY = 'lyrics-session'

interface StoredLyricsSession {
  version: 1
  token: string
  ownerId: string
  channelId: string
  messageId: string
  startedAt: number
}

function observeLyricsEditRateLimit(
  client: Client,
  expectedPath: string,
  rateLimit: LyricsEditRateLimit
): () => void {
  const listener = (request: APIRequest, response: ResponseLike) => {
    if (request.method.toUpperCase() !== 'PATCH') return
    rateLimit.observe(response.headers, String(request.path) === expectedPath)
  }
  client.rest.on(RESTEvents.Response, listener)
  return () => client.rest.off(RESTEvents.Response, listener)
}

function readStoredLyricsSession(): StoredLyricsSession | null {
  try {
    const raw = getStoredValue(LYRICS_SESSION_KEY)
    if (!raw || raw.length > 2_048) return null
    const value = JSON.parse(raw) as Partial<StoredLyricsSession>
    const safeId = (id: unknown) =>
      typeof id === 'string' && id.length > 0 && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id)
    if (
      value.version !== 1 ||
      typeof value.token !== 'string' ||
      !/^[a-f0-9]{16}$/.test(value.token) ||
      !safeId(value.ownerId) ||
      !safeId(value.channelId) ||
      !safeId(value.messageId) ||
      typeof value.startedAt !== 'number' ||
      !Number.isFinite(value.startedAt)
    ) {
      return null
    }
    return value as StoredLyricsSession
  } catch {
    return null
  }
}

function saveStoredLyricsSession(session: StoredLyricsSession): void {
  try {
    setStoredValue(LYRICS_SESSION_KEY, JSON.stringify(session))
  } catch {
    // The live message can continue until restart if storage is temporarily unavailable.
  }
}

function deleteStoredLyricsSession(token?: string): void {
  try {
    if (token && readStoredLyricsSession()?.token !== token) return
    deleteStoredValue(LYRICS_SESSION_KEY)
  } catch {
    // Session cleanup must not make button handling fail.
  }
}

function inlineText(value: string): string {
  return value
    .slice(0, 500)
    .replaceAll('@', '@\u200b')
    .replace(/([\\`*_{}()#+.!|>~-])/g, '\\$1')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
}

function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

function formatOffset(milliseconds: number): string {
  const seconds = milliseconds / 1_000
  const value = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)
  return `${seconds > 0 ? '+' : ''}${value}s`
}

function trackHeader(view: LiveLyricsView): TopLevelComponent {
  if (!view.track) {
    return summarySection('Live lyrics', [
      '-# Spotify playback: inactive',
      `-# lyrics offset: ${formatOffset(view.offsetMs)}`,
      '-# timing: checked every 5 seconds',
      '-# source: LRCLIB'
    ])
  }

  const pronunciationSource =
    view.displayMode === 'korean-pronunciation'
      ? view.lines.find((line) => line.pronunciationSource)?.pronunciationSource
      : undefined

  return summarySection(
    `Live lyrics: ${inlineText(view.track.name)}`,
    [
      `-# artist: ${inlineText(view.track.artists)}`,
      `-# album: ${inlineText(view.track.album)}`,
      `-# playback: ${view.track.isPlaying ? 'playing' : 'paused'} at ${formatClock(view.spotifyProgressMs)} / ${formatClock(view.track.durationSeconds * 1_000)}`,
      `-# lyrics offset: ${formatOffset(view.offsetMs)}`,
      '-# timing: local transitions; Spotify correction every 5 seconds',
      ...(pronunciationSource
        ? [
            `-# pronunciation: [Vocaloid Lyrics Wiki](${pronunciationSource}); [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)`
          ]
        : []),
      '-# source: LRCLIB'
    ],
    { label: 'Open in Spotify', url: `https://open.spotify.com/track/${view.track.id}` }
  )
}

export function formatLiveLyrics(view: LiveLyricsView): TopLevelComponent[] {
  const header = trackHeader(view)
  if (view.mode !== 'lyrics') {
    const title =
      view.mode === 'idle'
        ? 'Waiting for playback'
        : view.mode === 'stopped'
          ? 'Live session stopped'
          : view.mode === 'error'
            ? 'Temporary error'
            : 'Synchronized lyrics unavailable'
    return [header, separator(), text(`**${title}**\n-# ${inlineText(view.detail)}`)]
  }

  const window = syncedLyricsWindow(view.lines, view.currentIndex)
  const renderedLines = window.map(({ line, current }) => {
    const displayedText = displayedLyricText(line, view.displayMode)
    const content = displayedText
      .split('\n')
      .map((value) => inlineText(value || '[instrumental]'))
      .join(' / ')
    if (!current) return `-# ${content}`

    const durationMs = (view.track?.durationSeconds ?? 0) * 1_000
    const expectedWords = currentSyncedWordCount(
      view.lines,
      view.currentIndex,
      view.progressMs,
      durationMs,
      view.displayMode
    )
    const words = [...content.matchAll(/\S+/g)].filter(([word]) => word !== '/')
    const italicEnd = words[Math.max(0, expectedWords - 1)]
    if (!italicEnd || italicEnd.index === undefined) return `## ${content}`
    const end = italicEnd.index + italicEnd[0].length
    return `## *${content.slice(0, end)}*${content.slice(end)}`
  })
  if (view.currentIndex < 0) {
    renderedLines.unshift('**Waiting for the first synchronized line**')
  }

  return [
    header,
    separator(),
    text(renderedLines.join('\n')),
    text(
      view.currentIndex >= 0
        ? `-# line ${view.currentIndex + 1} of ${view.lines.length}`
        : `-# ${view.lines.length} synchronized lines loaded`
    )
  ]
}

function controlButtons(view: LiveLyricsView, token: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${LYRICS_OFFSET_BUTTON_ID}:${token}:minus-one`)
      .setLabel('-1s')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(view.stopped || view.offsetMs <= -MAX_LYRICS_OFFSET_MS),
    new ButtonBuilder()
      .setCustomId(`${LYRICS_OFFSET_BUTTON_ID}:${token}:minus-half`)
      .setLabel('-0.5s')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(view.stopped || view.offsetMs <= -MAX_LYRICS_OFFSET_MS),
    new ButtonBuilder()
      .setCustomId(`${LYRICS_OFFSET_BUTTON_ID}:${token}:plus-half`)
      .setLabel('+0.5s')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(view.stopped || view.offsetMs >= MAX_LYRICS_OFFSET_MS),
    new ButtonBuilder()
      .setCustomId(`${LYRICS_OFFSET_BUTTON_ID}:${token}:plus-one`)
      .setLabel('+1s')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(view.stopped || view.offsetMs >= MAX_LYRICS_OFFSET_MS),
    new ButtonBuilder()
      .setCustomId(`${LYRICS_STOP_BUTTON_ID}:${token}`)
      .setLabel(view.stopped ? 'Stopped' : 'Stop')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(view.stopped)
  )
}

function displayModeButtons(view: LiveLyricsView, token: string) {
  const hasPronunciation = view.lines.some((line) => line.pronunciation)
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${LYRICS_DISPLAY_BUTTON_ID}:${token}:japanese`)
      .setLabel('Japanese')
      .setStyle(view.displayMode === 'japanese' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(view.stopped),
    new ButtonBuilder()
      .setCustomId(`${LYRICS_DISPLAY_BUTTON_ID}:${token}:korean-pronunciation`)
      .setLabel('Korean pronunciation')
      .setStyle(
        view.displayMode === 'korean-pronunciation' ? ButtonStyle.Primary : ButtonStyle.Secondary
      )
      .setDisabled(view.stopped || !hasPronunciation)
  )
}

function liveLyricsReply(view: LiveLyricsView, token: string, args: string, flags: Flags) {
  const base = commandContainer(subcommand, args, flags, ...formatLiveLyrics(view))
  return {
    components: [base.components[0]!, displayModeButtons(view, token), controlButtons(view, token)],
    files: base.files,
    flags: base.flags
  }
}

export async function restoreLyricsSession(client: Client): Promise<boolean> {
  const stored = readStoredLyricsSession()
  if (!stored) {
    deleteStoredLyricsSession()
    return false
  }
  if (stored.startedAt > Date.now() || Date.now() - stored.startedAt >= PUBLIC_LYRICS_SESSION_MS) {
    deleteStoredLyricsSession(stored.token)
    return false
  }

  const initialState = await loadInitialLiveLyricsState()
  const initialOffsetMs = initialState.track ? loadLyricsOffset(initialState.track.id) : 0
  const initialView = liveLyricsView(initialState, Date.now(), false, initialOffsetMs)
  const flags: Flags = new Map([['pub', true]])
  const rateLimit = new LyricsEditRateLimit()
  const removeRateLimitObserver = observeLyricsEditRateLimit(
    client,
    Routes.channelMessage(stored.channelId, stored.messageId),
    rateLimit
  )
  const render = async (view: LiveLyricsView) => {
    const reply = liveLyricsReply(view, stored.token, 'lyrics --pub', flags)
    await client.rest.patch(Routes.channelMessage(stored.channelId, stored.messageId), {
      body: {
        components: reply.components.map((component) => component.toJSON()),
        attachments: [],
        flags: MessageFlags.IsComponentsV2,
        allowed_mentions: { parse: [] }
      }
    })
  }

  const initialRenderStartedAt = Date.now()
  try {
    await render(initialView)
  } catch {
    removeRateLimitObserver()
    deleteStoredLyricsSession(stored.token)
    return false
  }

  const session = new LiveLyricsSession({
    token: stored.token,
    ownerId: stored.ownerId,
    isPublic: true,
    initialState,
    renderedView: initialView,
    initialOffsetMs,
    initialRenderLatencyMs: Date.now() - initialRenderStartedAt,
    startedAt: stored.startedAt,
    render,
    dependencies: {
      automaticEditDelay: (lastEditAt, now) => rateLimit.nextDelay(lastEditAt, now)
    },
    onClose: () => {
      removeRateLimitObserver()
      unregisterLyricsSession(stored.token)
      deleteStoredLyricsSession(stored.token)
    }
  })
  await registerLyricsSession(session)
  session.start()
  return true
}

type LyricsControl =
  | { token: string; action: 'stop' }
  | { token: string; action: 'offset'; deltaMs: number }
  | { token: string; action: 'display'; displayMode: LyricsDisplayMode }

function parseLyricsControl(customId: string): LyricsControl | null {
  const stop = customId.match(new RegExp(`^${LYRICS_STOP_BUTTON_ID}:([a-f0-9]{16})$`))
  if (stop?.[1]) return { token: stop[1], action: 'stop' }

  const display = customId.match(
    new RegExp(`^${LYRICS_DISPLAY_BUTTON_ID}:([a-f0-9]{16}):(japanese|korean-pronunciation)$`)
  )
  if (display?.[1] && display[2]) {
    return {
      token: display[1],
      action: 'display',
      displayMode: display[2] as LyricsDisplayMode
    }
  }

  const offset = customId.match(
    new RegExp(
      `^${LYRICS_OFFSET_BUTTON_ID}:([a-f0-9]{16}):(minus-one|minus-half|plus-half|plus-one)$`
    )
  )
  if (!offset?.[1] || !offset[2]) return null
  const deltas: Record<string, number> = {
    'minus-one': -1_000,
    'minus-half': -500,
    'plus-half': 500,
    'plus-one': 1_000
  }
  return {
    token: offset[1],
    action: 'offset',
    deltaMs: deltas[offset[2]]!
  }
}

export function isLyricsControlButtonId(customId: string): boolean {
  return (
    customId.startsWith(`${LYRICS_STOP_BUTTON_ID}:`) ||
    customId.startsWith(`${LYRICS_OFFSET_BUTTON_ID}:`) ||
    customId.startsWith(`${LYRICS_DISPLAY_BUTTON_ID}:`)
  )
}

export async function handleLyricsControlButton(interaction: ButtonInteraction): Promise<void> {
  const control = parseLyricsControl(interaction.customId)
  const session = control ? getLyricsSession(control.token) : undefined
  if (!control || !session) {
    await interaction.reply(
      errorContainer('lyrics', new Map(), 'This live lyrics session has expired.')
    )
    return
  }
  if (interaction.user.id !== session.ownerId && !isAdminUser(interaction.user.id)) {
    await interaction.reply(
      errorContainer('lyrics', new Map(), 'Only the user who started this session can control it.')
    )
    return
  }

  await interaction.deferUpdate()
  if (control.action === 'offset') {
    await session.adjustOffset(control.deltaMs)
    return
  }
  if (control.action === 'display') {
    await session.setDisplayMode(control.displayMode)
    return
  }

  const view = await session.stop('Stopped by requester', false)
  const reply = liveLyricsReply(view, session.token, 'lyrics', new Map())
  await interaction.editReply({
    components: reply.components,
    files: reply.files,
    attachments: [],
    flags: MessageFlags.IsComponentsV2
  })
}

export const subcommand: Subcommand = {
  name: 'lyrics',
  description: 'live synchronized lyrics for Spotify playback',
  usage: 'lyrics [--pub]',
  examples: ['lyrics', 'lyrics --pub'],

  async execute(interaction, args, flags) {
    const restArgs = args.replace(/^\S+\s*/, '').trim()
    if (restArgs) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', 'lyrics takes no arguments')
      )
      return
    }

    await deferCommandResponse(interaction, flags)
    await stopActiveLyricsSessions()
    const initialState = await loadInitialLiveLyricsState()
    const token = randomUUID().replaceAll('-', '').slice(0, 16)
    const requestedPublic = flags.has('pub')

    let session: LiveLyricsSession
    const initialOffsetMs = initialState.track ? loadLyricsOffset(initialState.track.id) : 0
    const initialView = liveLyricsView(initialState, Date.now(), false, initialOffsetMs)

    const initialReply = liveLyricsReply(initialView, token, args, flags)
    const publicChannelId = interaction.channelId
    let messageId = ''
    let durablePublic = false
    let initialRenderLatencyMs = 0

    if (requestedPublic && publicChannelId) {
      const renderStartedAt = Date.now()
      try {
        const created = (await interaction.client.rest.post(
          Routes.channelMessages(publicChannelId),
          {
            body: {
              components: initialReply.components.map((component) => component.toJSON()),
              flags: MessageFlags.IsComponentsV2,
              allowed_mentions: { parse: [] }
            }
          }
        )) as { id?: unknown }
        if (typeof created.id !== 'string') throw new Error('Discord did not return a message ID')
        messageId = created.id
        durablePublic = true
        initialRenderLatencyMs = Date.now() - renderStartedAt
        await interaction.deleteReply().catch(() => {})
      } catch {
        durablePublic = false
      }
    }

    if (!durablePublic) {
      const renderStartedAt = Date.now()
      const message = await interaction.editReply({
        components: initialReply.components,
        files: initialReply.files,
        attachments: [],
        flags: MessageFlags.IsComponentsV2
      })
      messageId = message.id
      initialRenderLatencyMs = Date.now() - renderStartedAt
      durablePublic = requestedPublic && Boolean(publicChannelId)
    }

    const rateLimit = new LyricsEditRateLimit()
    const editPath =
      durablePublic && publicChannelId
        ? Routes.channelMessage(publicChannelId, messageId)
        : Routes.webhookMessage(interaction.applicationId, interaction.token)
    const removeRateLimitObserver = observeLyricsEditRateLimit(
      interaction.client,
      editPath,
      rateLimit
    )

    const render = async (view: LiveLyricsView) => {
      const reply = liveLyricsReply(view, token, args, flags)
      const payload = {
        components: reply.components,
        files: reply.files,
        attachments: [],
        flags: MessageFlags.IsComponentsV2 as const
      }
      if (durablePublic && publicChannelId) {
        await interaction.client.rest.patch(Routes.channelMessage(publicChannelId, messageId), {
          body: {
            components: reply.components.map((component) => component.toJSON()),
            attachments: [],
            flags: MessageFlags.IsComponentsV2,
            allowed_mentions: { parse: [] }
          }
        })
      } else {
        await interaction.editReply(payload)
      }
    }

    session = new LiveLyricsSession({
      token,
      ownerId: interaction.user.id,
      isPublic: durablePublic,
      initialState,
      renderedView: initialView,
      initialOffsetMs,
      initialRenderLatencyMs,
      render,
      dependencies: {
        automaticEditDelay: (lastEditAt, now) => rateLimit.nextDelay(lastEditAt, now)
      },
      onClose: () => {
        removeRateLimitObserver()
        unregisterLyricsSession(token)
        if (durablePublic) deleteStoredLyricsSession(token)
      }
    })
    await registerLyricsSession(session)
    if (durablePublic && publicChannelId) {
      saveStoredLyricsSession({
        version: 1,
        token,
        ownerId: interaction.user.id,
        channelId: publicChannelId,
        messageId,
        startedAt: session.startedAt
      })
    }
    session.start()
  }
}
