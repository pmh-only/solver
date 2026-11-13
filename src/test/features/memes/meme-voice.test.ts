import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { ChannelType, GatewayIntentBits, IntentsBitField, type Message } from 'discord.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { discordClientOptions } from '../../../discord/client-options.js'
import { playMemeAudio } from '../../../features/memes/voice.js'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  join: vi.fn(),
  existing: vi.fn(),
  ready: vi.fn(),
  player: vi.fn(),
  resource: vi.fn()
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('@discordjs/voice', () => ({
  AudioPlayerStatus: { Idle: 'idle', Playing: 'playing' },
  NoSubscriberBehavior: { Stop: 'stop' },
  StreamType: { OggOpus: 'ogg' },
  VoiceConnectionStatus: { Ready: 'ready', Destroyed: 'destroyed', Disconnected: 'disconnected' },
  createAudioPlayer: mocks.player,
  createAudioResource: mocks.resource,
  entersState: mocks.ready,
  getVoiceConnection: mocks.existing,
  joinVoiceChannel: mocks.join
}))
const url = 'https://s3.lth.so/memehub/audio?signature=secret'
const fetchMock = vi.fn<typeof fetch>()
let connection: EventEmitter & {
  state: { status: string }
  destroy: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
}
let player: EventEmitter & { play: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }
let process: EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  kill: ReturnType<typeof vi.fn>
}

function fixture(id = 'guild') {
  const channel = {
    id: `voice-${id}`,
    type: ChannelType.GuildVoice,
    joinable: true,
    speakable: true
  }
  return {
    guild: { id, voiceAdapterCreator: vi.fn() },
    member: { voice: { channel, channelId: channel.id } }
  }
}
function play(message = fixture()) {
  return playMemeAudio(message as unknown as Message, url)
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue(new Response('mock audio'))
  connection = Object.assign(new EventEmitter(), {
    state: { status: 'ready' },
    destroy: vi.fn(() => {
      connection.state.status = 'destroyed'
    }),
    subscribe: vi.fn()
  })
  player = Object.assign(new EventEmitter(), {
    play: vi.fn(() =>
      queueMicrotask(() => {
        player.emit('playing')
        player.emit('idle')
      })
    ),
    stop: vi.fn()
  })
  process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: vi.fn()
  })
  mocks.join.mockReturnValue(connection)
  mocks.player.mockReturnValue(player)
  mocks.spawn.mockReturnValue(process)
  mocks.ready.mockResolvedValue(connection)
  mocks.resource.mockReturnValue({ audio: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('enables the voice-state gateway intent', () => {
  expect(
    new IntentsBitField(discordClientOptions.intents).has(GatewayIntentBits.GuildVoiceStates)
  ).toBe(true)
})
it('joins the requester channel, plays once, and destroys all resources on completion', async () => {
  const message = fixture()
  expect(await play(message)).toBe(true)
  expect(mocks.join).toHaveBeenCalledWith({
    channelId: 'voice-guild',
    guildId: 'guild',
    adapterCreator: message.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false
  })
  expect(mocks.ready).toHaveBeenCalledWith(connection, 'ready', 10_000)
  expect(fetchMock).toHaveBeenCalledWith(url, {
    redirect: 'error',
    signal: expect.any(AbortSignal)
  })
  expect(mocks.spawn).toHaveBeenCalledWith(
    'ffmpeg',
    expect.arrayContaining(['-protocol_whitelist', 'pipe', '-t', '120', 'libopus']),
    { stdio: ['pipe', 'pipe', 'ignore'] }
  )
  expect(mocks.resource).toHaveBeenCalledWith(process.stdout, { inputType: 'ogg' })
  expect(player.play).toHaveBeenCalledOnce()
  expect(player.stop).toHaveBeenCalledWith(true)
  expect(process.kill).toHaveBeenCalledWith('SIGKILL')
  expect(connection.destroy).toHaveBeenCalledOnce()
})
it.each(['no-guild', 'no-channel', 'stage', 'no-connect', 'no-speak', 'existing'])(
  'does not download or join when %s',
  async (kind) => {
    const message = fixture()
    if (kind === 'no-guild') Object.assign(message, { guild: null })
    if (kind === 'no-channel') Object.assign(message.member.voice, { channel: null })
    if (kind === 'stage') message.member.voice.channel.type = ChannelType.GuildStageVoice
    if (kind === 'no-connect') message.member.voice.channel.joinable = false
    if (kind === 'no-speak') message.member.voice.channel.speakable = false
    if (kind === 'existing') mocks.existing.mockReturnValue({})
    expect(await play(message)).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.join).not.toHaveBeenCalled()
  }
)
it.each([
  'http://s3.lth.so/a',
  'https://127.0.0.1/a',
  'https://s3.lth.so.evil.test/a',
  'https://u:p@s3.lth.so/a'
])('rejects unsafe audio URL %s', async (unsafe) => {
  expect(await playMemeAudio(fixture() as unknown as Message, unsafe)).toBe(false)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(mocks.join).not.toHaveBeenCalled()
})
it.each(['http', 'empty', 'oversized', 'timeout'])(
  'falls back without joining on %s download',
  async (kind) => {
    if (kind === 'timeout') fetchMock.mockRejectedValueOnce(new Error('timeout'))
    else
      fetchMock.mockResolvedValueOnce(
        kind === 'http'
          ? new Response('', { status: 503 })
          : new Response(kind === 'empty' ? '' : new Uint8Array(10 * 1024 * 1024 + 1))
      )
    expect(await play()).toBe(false)
    expect(mocks.join).not.toHaveBeenCalled()
    // A failed attempt must release the guild lock.
    fetchMock.mockResolvedValueOnce(new Response('audio'))
    expect(await play()).toBe(true)
  }
)
it('does not join if the requester moved during the download', async () => {
  const message = fixture()
  fetchMock.mockImplementationOnce(async () => {
    message.member.voice.channelId = 'different'
    return new Response('audio')
  })
  expect(await play(message)).toBe(false)
  expect(mocks.join).not.toHaveBeenCalled()
})
it('does not replace a connection created during the download', async () => {
  mocks.existing.mockReturnValueOnce(undefined).mockReturnValueOnce({})
  expect(await play()).toBe(false)
  expect(mocks.join).not.toHaveBeenCalled()
})
it('leaves after voice readiness timeout', async () => {
  mocks.ready.mockRejectedValueOnce(new Error('timeout'))
  expect(await play()).toBe(false)
  expect(connection.destroy).toHaveBeenCalledOnce()
  expect(mocks.spawn).not.toHaveBeenCalled()
})
it.each(['player', 'process', 'stdin', 'decode', 'connection', 'disconnect', 'empty'])(
  'cleans up after %s playback failure',
  async (kind) => {
    player.play.mockImplementationOnce(() =>
      queueMicrotask(() => {
        if (kind === 'decode') process.emit('exit', 1)
        else if (kind === 'disconnect') connection.emit('disconnected')
        else if (kind === 'empty') player.emit('idle')
        else
          (({ player, process, stdin: process.stdin, connection })[kind]! as EventEmitter).emit(
            'error',
            new Error('secret')
          )
      })
    )
    expect(await play()).toBe(false)
    expect(connection.destroy).toHaveBeenCalledOnce()
    expect(process.kill).toHaveBeenCalledOnce()
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('secret'))
  }
)
it('leaves and releases the guild lock after the playback deadline', async () => {
  vi.useFakeTimers()
  player.play.mockImplementationOnce(() => {})
  const pending = play()
  await vi.waitFor(() => expect(player.play).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(130_000)
  expect(await pending).toBe(false)
  expect(connection.destroy).toHaveBeenCalledOnce()
})
it('refuses overlapping requests in the same guild and more than two active guilds', async () => {
  let release!: (value: Response) => void
  fetchMock.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve
      })
  )
  const first = play(fixture('one'))
  const firstRelease = release
  expect(await play(fixture('one'))).toBe(false)
  const second = play(fixture('two'))
  const secondRelease = release
  expect(await play(fixture('three'))).toBe(false)
  firstRelease(new Response('', { status: 503 }))
  secondRelease(new Response('', { status: 503 }))
  expect(await first).toBe(false)
  expect(await second).toBe(false)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
