import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  Routes,
  type ButtonInteraction
} from 'discord.js'
import { randomUUID } from 'node:crypto'
import type { Flags } from '../flags.js'
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
  MAX_LYRICS_OFFSET_MS,
  getLyricsSession,
  liveLyricsView,
  loadInitialLiveLyricsState,
  registerLyricsSession,
  stopActiveLyricsSessions,
  syncedLyricsWindow,
  unregisterLyricsSession,
  type LiveLyricsView
} from './lyrics-session.js'

export const LYRICS_STOP_BUTTON_ID = 'lyrics-stop'
export const LYRICS_OFFSET_BUTTON_ID = 'lyrics-offset'

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
  const seconds = Math.trunc(milliseconds / 1_000)
  return `${seconds > 0 ? '+' : ''}${seconds}s`
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

  return summarySection(
    `Live lyrics: ${inlineText(view.track.name)}`,
    [
      `-# artist: ${inlineText(view.track.artists)}`,
      `-# album: ${inlineText(view.track.album)}`,
      `-# playback: ${view.track.isPlaying ? 'playing' : 'paused'} at ${formatClock(view.spotifyProgressMs)} / ${formatClock(view.track.durationSeconds * 1_000)}`,
      `-# lyrics offset: ${formatOffset(view.offsetMs)}`,
      '-# timing: local transitions; Spotify correction every 5 seconds',
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
    const content = inlineText(line.text || '[instrumental]')
    return current ? `## ${content}` : `-# ${content}`
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
      .setCustomId(`${LYRICS_OFFSET_BUTTON_ID}:${token}:minus`)
      .setLabel('-1s')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(view.stopped || view.offsetMs <= -MAX_LYRICS_OFFSET_MS),
    new ButtonBuilder()
      .setCustomId(`${LYRICS_OFFSET_BUTTON_ID}:${token}:plus`)
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

function liveLyricsReply(view: LiveLyricsView, token: string, args: string, flags: Flags) {
  const base = commandContainer(subcommand, args, flags, ...formatLiveLyrics(view))
  return {
    components: [base.components[0]!, controlButtons(view, token)],
    files: base.files,
    flags: base.flags
  }
}

type LyricsControl =
  | { token: string; action: 'stop' }
  | { token: string; action: 'offset'; deltaMs: number }

function parseLyricsControl(customId: string): LyricsControl | null {
  const stop = customId.match(new RegExp(`^${LYRICS_STOP_BUTTON_ID}:([a-f0-9]{16})$`))
  if (stop?.[1]) return { token: stop[1], action: 'stop' }

  const offset = customId.match(
    new RegExp(`^${LYRICS_OFFSET_BUTTON_ID}:([a-f0-9]{16}):(minus|plus)$`)
  )
  if (!offset?.[1] || !offset[2]) return null
  return {
    token: offset[1],
    action: 'offset',
    deltaMs: offset[2] === 'plus' ? 1_000 : -1_000
  }
}

export function isLyricsControlButtonId(customId: string): boolean {
  return (
    customId.startsWith(`${LYRICS_STOP_BUTTON_ID}:`) ||
    customId.startsWith(`${LYRICS_OFFSET_BUTTON_ID}:`)
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
  if (interaction.user.id !== session.ownerId) {
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
    const isPublic = flags.has('pub')

    let session: LiveLyricsSession
    const initialView = liveLyricsView(initialState)

    const initialReply = liveLyricsReply(initialView, token, args, flags)
    const message = await interaction.editReply({
      components: initialReply.components,
      files: initialReply.files,
      attachments: [],
      flags: MessageFlags.IsComponentsV2
    })
    const publicChannelId = interaction.channelId ?? message.channelId

    const render = async (view: LiveLyricsView) => {
      const reply = liveLyricsReply(view, token, args, flags)
      const payload = {
        components: reply.components,
        files: reply.files,
        attachments: [],
        flags: MessageFlags.IsComponentsV2 as const
      }
      if (isPublic && publicChannelId) {
        await interaction.client.rest.patch(Routes.channelMessage(publicChannelId, message.id), {
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
      isPublic,
      initialState,
      renderedView: initialView,
      render,
      onClose: () => unregisterLyricsSession(token)
    })
    await registerLyricsSession(session)
    session.start()
  }
}
