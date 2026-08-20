import type { Subcommand } from '../types.js'
import {
  codeBlock,
  commandReferenceReply,
  runRerunnableCommand,
  sendCommandReply,
  separator,
  summarySection,
  text,
  type TopLevelComponent
} from '../components.js'
import { lyricsClient, type CurrentTrackLyrics } from './_lyrics.js'

const MAX_LYRICS_CHARACTERS = 12_000
const LYRICS_CHUNK_CHARACTERS = 3_500

function inlineText(value: string): string {
  return value
    .replaceAll('@', '@\u200b')
    .replace(/([\\`*_{}()#+.!|>~-])/g, '\\$1')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
}

function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

function splitLyrics(value: string): { chunks: string[]; truncated: boolean } {
  const truncated = value.length > MAX_LYRICS_CHARACTERS
  let remaining = truncated ? value.slice(0, MAX_LYRICS_CHARACTERS).trimEnd() : value
  remaining = remaining.replaceAll('```', '``\u200b`')
  const chunks: string[] = []

  while (remaining.length > LYRICS_CHUNK_CHARACTERS) {
    let splitAt = remaining.lastIndexOf('\n', LYRICS_CHUNK_CHARACTERS)
    if (splitAt < LYRICS_CHUNK_CHARACTERS / 2) splitAt = LYRICS_CHUNK_CHARACTERS
    chunks.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return { chunks, truncated }
}

export function formatCurrentTrackLyrics(result: CurrentTrackLyrics): TopLevelComponent[] {
  const { track, match } = result
  const spotifyUrl = `https://open.spotify.com/track/${track.id}`
  const header = summarySection(
    `Lyrics: ${inlineText(track.name)}`,
    [
      `-# artist: ${inlineText(track.artists)}`,
      `-# album: ${inlineText(track.album)}`,
      `-# playback: ${track.isPlaying ? 'playing' : 'paused'} at ${formatClock(track.progressSeconds)} / ${formatClock(track.durationSeconds)}`,
      `-# source: LRCLIB${result.synchronized ? '; synchronized lyrics available' : ''}`
    ],
    { label: 'Open in Spotify', url: spotifyUrl }
  )

  if (match.instrumental) {
    return [header, separator(), text('**Instrumental track**\n-# No vocal lyrics to display.')]
  }
  if (!result.lyrics) {
    return [header, separator(), text('**Lyrics unavailable**\n-# LRCLIB has no lyric text.')]
  }

  const { chunks, truncated } = splitLyrics(result.lyrics)
  return [
    header,
    separator(),
    ...chunks.map((chunk, index) =>
      codeBlock(index === 0 ? 'Lyrics' : `Lyrics (${index + 1}/${chunks.length})`, chunk)
    ),
    ...(truncated ? [text('-# Lyrics truncated to fit Discord limits.')] : [])
  ]
}

export const subcommand: Subcommand = {
  name: 'lyrics',
  description: 'lyrics for the current Spotify track',
  usage: 'lyrics [--pub]',
  examples: ['lyrics'],

  async run() {
    return formatCurrentTrackLyrics(await lyricsClient.getCurrentTrackLyrics())
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

    await runRerunnableCommand(interaction, subcommand, args, flags, () =>
      subcommand.run!(args, flags)
    )
  }
}
