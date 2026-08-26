import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  RESTEvents,
  Routes,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  type APIRequest,
  type ButtonInteraction,
  type Client,
  type ResponseLike
} from 'discord.js'
import { randomUUID } from 'node:crypto'
import { isAdminUser } from '../authorization.js'
import type { Flags } from '../flags.js'
import { deleteStoredValue, getStoredValue, setStoredValue } from '../helpers/kv-store.js'
import { interactionOriginalMessageRoute } from '../helpers/interaction-routes.js'
import type { Subcommand } from '../types.js'
import {
  commandContainer,
  commandReferenceReply,
  container,
  deferCommandResponse,
  errorContainer,
  sendCommandReply,
  summarySection,
  text,
  type TopLevelComponent
} from '../components.js'
import {
  LiveLyricsSession,
  LyricsEditRateLimit,
  MAX_LYRICS_OFFSET_MS,
  MESSAGE_LYRICS_EDIT_INTERVAL_MS,
  MIN_LYRICS_EDIT_INTERVAL_MS,
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
export const PUBLIC_LYRICS_INTERACTION_MS = 10 * 60 * 1_000

const EMPTY_LYRIC_LINE = `-# ${'\u200b'.repeat(100)}`
const LYRICS_WINDOW_RADIUS = 2

interface StoredLyricsSession {
  version: 1 | 2
  token: string
  ownerId: string
  channelId: string
  messageId?: string
  metrics?: boolean
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
      (value.version !== 1 && value.version !== 2) ||
      typeof value.token !== 'string' ||
      !/^[a-f0-9]{16}$/.test(value.token) ||
      !safeId(value.ownerId) ||
      !safeId(value.channelId) ||
      (value.version === 1
        ? !safeId(value.messageId)
        : value.messageId !== undefined && !safeId(value.messageId)) ||
      (value.metrics !== undefined && typeof value.metrics !== 'boolean') ||
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
  const value = Number.isInteger(seconds)
    ? String(seconds)
    : seconds.toFixed(3).replace(/0+$/, '')
  return `${seconds > 0 ? '+' : ''}${value}s`
}

function formatPeriod(milliseconds: number): string {
  const seconds = milliseconds / 1_000
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(3).replace(/0+$/, '')}s`
}

function trackMetadata(view: LiveLyricsView): TopLevelComponent {
  if (!view.track) {
    return summarySection('Live lyrics', [`-# source: ${view.lyricsSource ?? 'pending'}`])
  }

  const pronunciationSource =
    view.displayMode === 'korean-pronunciation'
      ? view.lines.find((line) => line.pronunciationSource)?.pronunciationSource
      : undefined

  const lines = [
    `-# artist: ${inlineText(view.track.artists)}`,
    `-# album: ${inlineText(view.track.album)}`,
    ...(pronunciationSource
      ? [
          `-# pronunciation: [Vocaloid Lyrics Wiki](${pronunciationSource}); [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)`
        ]
      : []),
    `-# source: ${view.lyricsSource ?? 'LRCLIB'}`
  ]
  const spotifyLink = {
    label: 'Open in Spotify',
    url: `https://open.spotify.com/track/${view.track.id}`
  }
  if (!view.track.imageUrl) {
    return summarySection(inlineText(view.track.name), lines, spotifyLink)
  }

  return new SectionBuilder()
    .addTextDisplayComponents(
      text(`## ${inlineText(view.track.name)}`),
      text([...lines, `-# [Open in Spotify](${spotifyLink.url})`].join('\n'))
    )
    .setThumbnailAccessory(
      new ThumbnailBuilder()
        .setURL(view.track.imageUrl)
        .setDescription(`${view.track.name} album artwork`.slice(0, 1_024))
    )
}

function timingMetrics(view: LiveLyricsView): TopLevelComponent {
  return summarySection('Metrics', [
    view.track
      ? `-# playback: ${view.track.isPlaying ? 'playing' : 'paused'} at ${formatClock(view.spotifyProgressMs)} / ${formatClock(view.track.durationSeconds * 1_000)}`
      : '-# Spotify playback: inactive',
    `-# offsets: Discord ${formatOffset(view.discordOffsetMs)} / Spotify ${formatOffset(view.offsetMs)}`,
    `-# render interval: ${formatPeriod(view.renderIntervalMs)}`,
    view.track
      ? '-# synchronization: local transitions; Spotify correction every 1 second'
      : '-# synchronization: checked every 1 second'
  ])
}

function lyricsContent(view: LiveLyricsView): TopLevelComponent[] {
  if (view.mode !== 'lyrics') {
    const title =
      view.mode === 'idle'
        ? 'Waiting for playback'
        : view.mode === 'stopped'
          ? 'Live session stopped'
          : view.mode === 'error'
            ? 'Temporary error'
            : 'Synchronized lyrics unavailable'
    return [text(`**${title}**\n-# ${inlineText(view.detail)}`)]
  }

  const window = syncedLyricsWindow(view.lines, view.currentIndex, LYRICS_WINDOW_RADIUS)
  let renderedLines = window.map(({ line, current }) => {
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
    const underlineEnd = words[Math.max(0, expectedWords - 1)]
    if (!underlineEnd || underlineEnd.index === undefined) return `## ${content}`
    const end = underlineEnd.index + underlineEnd[0].length
    return `## __${content.slice(0, end)}__${content.slice(end)}`
  })
  if (view.currentIndex < 0) {
    const upcoming = renderedLines.slice(0, LYRICS_WINDOW_RADIUS)
    renderedLines = [
      ...Array<string>(LYRICS_WINDOW_RADIUS).fill(EMPTY_LYRIC_LINE),
      '**Waiting for the first synchronized line**',
      ...upcoming,
      ...Array<string>(LYRICS_WINDOW_RADIUS - upcoming.length).fill(EMPTY_LYRIC_LINE)
    ]
  } else {
    const leading = Math.max(0, LYRICS_WINDOW_RADIUS - view.currentIndex)
    const following = view.lines.length - view.currentIndex - 1
    const trailing = Math.max(0, LYRICS_WINDOW_RADIUS - following)
    renderedLines = [
      ...Array<string>(leading).fill(EMPTY_LYRIC_LINE),
      ...renderedLines,
      ...Array<string>(trailing).fill(EMPTY_LYRIC_LINE)
    ]
  }

  return [
    text(renderedLines.join('\n')),
    text(
      view.currentIndex >= 0
        ? `-# line ${view.currentIndex + 1} of ${view.lines.length}`
        : `-# ${view.lines.length} synchronized lines loaded`
    )
  ]
}

export function formatLiveLyrics(
  view: LiveLyricsView,
  includeMetrics = false
): TopLevelComponent[] {
  return [
    trackMetadata(view),
    ...(includeMetrics ? [timingMetrics(view)] : []),
    ...lyricsContent(view)
  ]
}

function componentCard(component: TopLevelComponent): ContainerBuilder {
  const card = new ContainerBuilder()
  if (component instanceof SectionBuilder) return card.addSectionComponents(component)
  if (component instanceof TextDisplayBuilder) return card.addTextDisplayComponents(component)
  throw new Error('unsupported lyrics card component')
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
      .setDisabled(view.stopped || view.offsetMs >= MAX_LYRICS_OFFSET_MS)
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
  const metadata = trackMetadata(view)
  const base = commandContainer(subcommand, args, flags, ...lyricsContent(view))
  const displayModes = view.lines.some((line) => line.pronunciation)
    ? [displayModeButtons(view, token)]
    : []
  return {
    components: [
      componentCard(metadata),
      ...(flags.has('metrics') ? [componentCard(timingMetrics(view))] : []),
      base.components[0]!,
      ...displayModes,
      controlButtons(view, token)
    ],
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
  initialView.renderIntervalMs = MESSAGE_LYRICS_EDIT_INTERVAL_MS
  const flags: Flags = new Map([['pub', true]])
  if (stored.metrics) flags.set('metrics', true)
  let messageId = stored.messageId
  let initialRenderLatencyMs = 0

  if (!messageId) {
    const reply = liveLyricsReply(initialView, stored.token, 'lyrics --pub', flags)
    const renderStartedAt = Date.now()
    try {
      const created = (await client.rest.post(Routes.channelMessages(stored.channelId), {
        body: {
          components: reply.components.map((component) => component.toJSON()),
          flags: MessageFlags.IsComponentsV2,
          allowed_mentions: { parse: [] }
        }
      })) as { id?: unknown }
      if (typeof created.id !== 'string') return false
      messageId = created.id
      initialRenderLatencyMs = Date.now() - renderStartedAt
      saveStoredLyricsSession({ ...stored, version: 2, messageId })
    } catch {
      return false
    }
  }

  const rateLimit = new LyricsEditRateLimit()
  const removeRateLimitObserver = observeLyricsEditRateLimit(
    client,
    Routes.channelMessage(stored.channelId, messageId),
    rateLimit
  )
  const render = async (view: LiveLyricsView) => {
    const reply = liveLyricsReply(view, stored.token, 'lyrics --pub', flags)
    await client.rest.patch(Routes.channelMessage(stored.channelId, messageId), {
      body: {
        components: reply.components.map((component) => component.toJSON()),
        attachments: [],
        flags: MessageFlags.IsComponentsV2,
        allowed_mentions: { parse: [] }
      }
    })
  }

  if (stored.messageId) {
    const initialRenderStartedAt = Date.now()
    try {
      await render(initialView)
      initialRenderLatencyMs = Date.now() - initialRenderStartedAt
    } catch {
      removeRateLimitObserver()
      deleteStoredLyricsSession(stored.token)
      return false
    }
  }

  const session = new LiveLyricsSession({
    token: stored.token,
    ownerId: stored.ownerId,
    isPublic: true,
    initialState,
    renderedView: initialView,
    initialOffsetMs,
    initialRenderLatencyMs,
    startedAt: stored.startedAt,
    render,
    dependencies: {
      automaticEditDelay: (lastEditAt, now) =>
        rateLimit.nextDelay(lastEditAt, now, MESSAGE_LYRICS_EDIT_INTERVAL_MS),
      renderInterval: () => MESSAGE_LYRICS_EDIT_INTERVAL_MS
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
  usage: 'lyrics [--metrics] [--pub]',
  examples: ['lyrics', 'lyrics --metrics', 'lyrics --pub'],
  flags: {
    metrics: { description: 'show playback and synchronization metrics' }
  },

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

    const initialOffsetMs = initialState.track ? loadLyricsOffset(initialState.track.id) : 0
    const initialView = liveLyricsView(initialState, Date.now(), false, initialOffsetMs)

    const initialReply = liveLyricsReply(initialView, token, args, flags)
    const publicChannelId = interaction.channelId
    let messageId = ''
    let messageMode = false
    let migrationTimer: ReturnType<typeof setTimeout> | null = null
    const renderStartedAt = Date.now()
    await interaction.editReply({
      components: initialReply.components,
      files: initialReply.files,
      attachments: [],
      flags: MessageFlags.IsComponentsV2
    })
    const initialRenderLatencyMs = Date.now() - renderStartedAt

    let rateLimit = new LyricsEditRateLimit()
    let removeRateLimitObserver = observeLyricsEditRateLimit(
      interaction.client,
      interactionOriginalMessageRoute(interaction.applicationId, interaction.token),
      rateLimit
    )

    const interactionRender = async (view: LiveLyricsView) => {
      const reply = liveLyricsReply(view, token, args, flags)
      await interaction.editReply({
        components: reply.components,
        files: reply.files,
        attachments: [],
        flags: MessageFlags.IsComponentsV2 as const
      })
    }

    const session = new LiveLyricsSession({
      token,
      ownerId: interaction.user.id,
      isPublic: false,
      initialState,
      renderedView: initialView,
      initialOffsetMs,
      initialRenderLatencyMs,
      render: interactionRender,
      dependencies: {
        automaticEditDelay: (lastEditAt, now) =>
          rateLimit.nextDelay(
            lastEditAt,
            now,
            messageMode ? MESSAGE_LYRICS_EDIT_INTERVAL_MS : undefined
          ),
        renderInterval: () =>
          messageMode ? MESSAGE_LYRICS_EDIT_INTERVAL_MS : MIN_LYRICS_EDIT_INTERVAL_MS
      },
      onClose: () => {
        if (migrationTimer) clearTimeout(migrationTimer)
        removeRateLimitObserver()
        unregisterLyricsSession(token)
        if (requestedPublic) deleteStoredLyricsSession(token)
      }
    })
    await registerLyricsSession(session)

    if (requestedPublic && publicChannelId) {
      saveStoredLyricsSession({
        version: 2,
        token,
        ownerId: interaction.user.id,
        channelId: publicChannelId,
        metrics: flags.has('metrics'),
        startedAt: session.startedAt
      })
      migrationTimer = setTimeout(() => {
        migrationTimer = null
        void session.migrateToPublic(async (view) => {
          const reply = liveLyricsReply(
            { ...view, renderIntervalMs: MESSAGE_LYRICS_EDIT_INTERVAL_MS },
            token,
            args,
            flags
          )
          const created = (await interaction.client.rest.post(
            Routes.channelMessages(publicChannelId),
            {
              body: {
                components: reply.components.map((component) => component.toJSON()),
                flags: MessageFlags.IsComponentsV2,
                allowed_mentions: { parse: [] }
              }
            }
          )) as { id?: unknown }
          if (typeof created.id !== 'string') return null
          if (!session.isActive) {
            await interaction.client.rest
              .delete(Routes.channelMessage(publicChannelId, created.id))
              .catch(() => {})
            return null
          }

          const moved = container(
            args,
            flags,
            summarySection('Live lyrics moved', [
              '-# Continued in a bot message after 10 minutes.'
            ])
          )
          await interaction
            .editReply({
              components: moved.components,
              files: moved.files,
              attachments: [],
              flags: MessageFlags.IsComponentsV2
            })
            .catch(() => {})
          if (!session.isActive) {
            await interaction.client.rest
              .delete(Routes.channelMessage(publicChannelId, created.id))
              .catch(() => {})
            return null
          }

          messageId = created.id
          messageMode = true
          removeRateLimitObserver()
          rateLimit = new LyricsEditRateLimit()
          removeRateLimitObserver = observeLyricsEditRateLimit(
            interaction.client,
            Routes.channelMessage(publicChannelId, messageId),
            rateLimit
          )
          saveStoredLyricsSession({
            version: 2,
            token,
            ownerId: interaction.user.id,
            channelId: publicChannelId,
            messageId,
            metrics: flags.has('metrics'),
            startedAt: session.startedAt
          })

          return async (nextView) => {
            const nextReply = liveLyricsReply(nextView, token, args, flags)
            await interaction.client.rest.patch(Routes.channelMessage(publicChannelId, messageId), {
              body: {
                components: nextReply.components.map((component) => component.toJSON()),
                attachments: [],
                flags: MessageFlags.IsComponentsV2,
                allowed_mentions: { parse: [] }
              }
            })
          }
        })
      }, PUBLIC_LYRICS_INTERACTION_MS)
      migrationTimer.unref?.()
    }
    session.start()
  }
}
