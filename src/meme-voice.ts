import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { ChannelType, type Message } from 'discord.js'
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel
} from '@discordjs/voice'

const activeGuilds = new Set<string>()

async function downloadAudio(url: string): Promise<Buffer> {
  const parsed = new URL(url)
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 's3.lth.so' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    url.length > 2000
  )
    throw new Error('Unexpected meme audio host')
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
  if (!response.ok || !response.body) throw new Error('Meme audio download failed')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 10 * 1024 * 1024) throw new Error('Oversized meme audio')
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel()
  }
  if (!size) throw new Error('Empty meme audio')
  return Buffer.concat(chunks) as Buffer
}

/** Never move or interrupt an existing voice connection. Failures fall back to the media link. */
export async function playMemeAudio(message: Message, url: string): Promise<boolean> {
  const guild = message.guild
  const channel = message.member?.voice?.channel
  if (
    !guild ||
    !channel ||
    channel.type !== ChannelType.GuildVoice ||
    !channel.joinable ||
    !channel.speakable ||
    activeGuilds.has(guild.id) ||
    activeGuilds.size >= 2 ||
    getVoiceConnection(guild.id)
  )
    return false
  activeGuilds.add(guild.id)
  let connection: ReturnType<typeof joinVoiceChannel> | undefined
  let player: ReturnType<typeof createAudioPlayer> | undefined
  let process: ReturnType<typeof spawn> | undefined
  let input: Readable | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const audio = await downloadAudio(url)
    if (message.member?.voice.channelId !== channel.id || getVoiceConnection(guild.id)) return false
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false
    })
    // Keep transport errors handled even during readiness/cleanup; never log signed URLs.
    connection.on('error', () => {})
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000)
    player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } })
    connection.subscribe(player)
    // Only pipe I/O is allowed: an uploaded playlist cannot make FFmpeg fetch URLs or local files.
    process = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-protocol_whitelist',
        'pipe',
        '-i',
        'pipe:0',
        '-t',
        '120',
        '-vn',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-c:a',
        'libopus',
        '-frame_duration',
        '20',
        '-f',
        'ogg',
        'pipe:1'
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] }
    )
    const finished = new Promise<void>((resolve, reject) => {
      let started = false
      timer = setTimeout(() => reject(new Error('Meme audio playback timed out')), 130_000)
      process!.on('error', reject)
      process!.stdin!.on('error', reject)
      process!.stdout!.on('error', reject)
      process!.on('exit', (code) => {
        if (code !== 0) reject(new Error('Meme audio decoding failed'))
      })
      connection!.on('error', reject)
      connection!.on(VoiceConnectionStatus.Disconnected, () =>
        reject(new Error('Voice disconnected'))
      )
      player!.on('error', reject)
      player!.on(AudioPlayerStatus.Playing, () => {
        started = true
      })
      player!.on(AudioPlayerStatus.Idle, () => {
        if (started) resolve()
        else reject(new Error('Empty meme audio playback'))
      })
      player!.play(createAudioResource(process!.stdout!, { inputType: StreamType.OggOpus }))
      input = Readable.from([audio])
      input.on('error', reject)
      input.pipe(process!.stdin!)
    })
    await finished
    return true
  } catch {
    console.error('meme audio playback failed; falling back to media link')
    return false
  } finally {
    if (timer) clearTimeout(timer)
    input?.destroy()
    player?.stop(true)
    process?.stdin?.destroy()
    process?.stdout?.destroy()
    process?.kill('SIGKILL')
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed)
      connection.destroy()
    activeGuilds.delete(guild.id)
  }
}
