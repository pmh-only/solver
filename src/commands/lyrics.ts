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

function trackHeader(view: LiveLyricsView): TopLevelComponent {
  if (!view.track) {
    return summarySection('Live lyrics', [
      '-# Spotify playback: inactive',
      '-# timing: checked every 5 seconds',
      '-# source: LRCLIB'
    ])
  }

  return summarySection(
    `Live lyrics: ${inlineText(view.track.name)}`,
    [
      `-# artist: ${inlineText(view.track.artists)}`,
      `-# album: ${inlineText(view.track.album)}`,
      `-# playback: ${view.track.isPlaying ? 'playing' : 'paused'} at ${formatClock(view.progressMs)} / ${formatClock(view.track.durationSeconds * 1_000)}`,
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

function stopButton(token: string, disabled: boolean) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${LYRICS_STOP_BUTTON_ID}:${token}`)
      .setLabel(disabled ? 'Stopped' : 'Stop')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  )
}

function liveLyricsReply(view: LiveLyricsView, token: string, args: string, flags: Flags) {
  const base = commandContainer(subcommand, args, flags, ...formatLiveLyrics(view))
  return {
    components: [base.components[0]!, stopButton(token, view.stopped)],
    files: base.files,
    flags: base.flags
  }
}

function parseStopToken(customId: string): string | null {
  const match = customId.match(new RegExp(`^${LYRICS_STOP_BUTTON_ID}:([a-f0-9]{16})$`))
  return match?.[1] ?? null
}

export function isLyricsStopButtonId(customId: string): boolean {
  return customId.startsWith(`${LYRICS_STOP_BUTTON_ID}:`)
}

export async function handleLyricsStopButton(interaction: ButtonInteraction): Promise<void> {
  const token = parseStopToken(interaction.customId)
  const session = token ? getLyricsSession(token) : undefined
  if (!session) {
    await interaction.reply(
      errorContainer('lyrics', new Map(), 'This live lyrics session has expired.')
    )
    return
  }
  if (interaction.user.id !== session.ownerId) {
    await interaction.reply(
      errorContainer('lyrics', new Map(), 'Only the user who started this session can stop it.')
    )
    return
  }

  await interaction.deferUpdate()
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
