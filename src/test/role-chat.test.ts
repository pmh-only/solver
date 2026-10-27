import { join } from 'node:path'
import { GatewayIntentBits, IntentsBitField, type Message } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoleChatHandler, generateRoleChatReply } from '../role-chat.js'
import { loadCommunitySettings, manageCommunitySettings } from '../community-settings.js'
import { clearStoredValues, setStoredValue } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import { discordClientOptions } from '../discord-client-options.js'
import { commandJSON, dispatch, getCallback, makeSubcommands } from './e2e.js'
import { subcommand as list } from '../commands/list.js'

const { createResponse, createClient } = vi.hoisted(() => ({
  createResponse: vi.fn(),
  createClient: vi.fn()
}))
vi.mock('openai', () => ({
  default: class {
    constructor(options: unknown) {
      createClient(options)
    }
    responses = { create: createResponse }
  }
}))
vi.mock('../openai-config.js', () => ({
  loadOpenAIApiKey: () => 'secret-token',
  loadOpenAIEndpoint: () => 'https://api.example.com/v1'
}))

const GUILD = '333333333333333333'
const ROLE = '444444444444444444'
const USER = '555555555555555555'
const generate = vi.fn<(prompt: string, settings: unknown) => Promise<string>>()
const sendTyping = vi.fn<() => Promise<void>>()

function message(overrides: Record<string, unknown> = {}) {
  return {
    guildId: GUILD,
    channelId: '777777777777777777',
    channel: { sendTyping },
    author: { id: USER, bot: false },
    webhookId: null,
    system: false,
    content: `<@&${ROLE}> 안녕`,
    reply: vi.fn().mockResolvedValue(undefined),
    react: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as Message
}
function configure(guildId = GUILD, roleChat: Record<string, unknown> | null = { roleId: ROLE }) {
  return manageCommunitySettings({ action: 'update', guildId, settings: { roleChat } })
}

beforeEach(() => {
  vi.useFakeTimers()
  isolateStoredValues(join(process.cwd(), '.tmp', 'role-chat.test.sqlite'))
  clearStoredValues()
  vi.clearAllMocks()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  generate.mockReset().mockResolvedValue('**안녕하세요!**')
  sendTyping.mockReset().mockResolvedValue(undefined)
  createResponse
    .mockReset()
    .mockResolvedValue({ status: 'completed', output_text: '**안녕하세요!**' })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('role mention chat', () => {
  it('requests guild messages and message content gateway intents', () => {
    const intents = new IntentsBitField(discordClientOptions.intents)
    expect(intents.has(GatewayIntentBits.GuildMessages)).toBe(true)
    expect(intents.has(GatewayIntentBits.MessageContent)).toBe(true)
  })
  it.each([`<@&${ROLE}> 안녕`, `<&@${ROLE}> 안녕`, `안녕 <@&${ROLE}>`])(
    'lets any member invoke configured role chat with %s',
    async (content) => {
      configure()
      const input = message({ content })
      await createRoleChatHandler(generate)(input)
      expect(generate).toHaveBeenCalledWith('안녕', expect.objectContaining({ roleId: ROLE }))
      expect(input.reply).toHaveBeenCalledExactlyOnceWith({
        content: '**안녕하세요!**',
        allowedMentions: { parse: [], repliedUser: false }
      })
    }
  )
  it.each([
    { guildId: null },
    { guildId: '666666666666666666' },
    { author: { id: USER, bot: true } },
    { webhookId: '123' },
    { system: true },
    { content: '안녕' },
    { content: `<@&${USER}> 안녕` },
    { content: `<@&${ROLE}>` },
    { content: `<@&${ROLE}> ${'a'.repeat(4001)}` }
  ])('ignores unrelated or unsafe messages %j', async (overrides) => {
    configure()
    const input = message(overrides)
    await createRoleChatHandler(generate)(input)
    expect(generate).not.toHaveBeenCalled()
    expect(input.reply).not.toHaveBeenCalled()
    expect(input.react).not.toHaveBeenCalled()
    expect(sendTyping).not.toHaveBeenCalled()
  })
  it('is disabled by default and fails closed on corrupt settings', async () => {
    const handler = createRoleChatHandler(generate)
    await handler(message())
    setStoredValue(`community:settings:${GUILD}`, 'broken json')
    await handler(message())
    expect(generate).not.toHaveBeenCalled()
  })
  it('applies configuration updates and disablement immediately', async () => {
    configure()
    const handler = createRoleChatHandler(generate)
    configure(GUILD, { roleId: USER, model: 'custom-model' })
    await handler(message())
    await handler(message({ content: `<@&${USER}> 안녕` }))
    expect(generate).toHaveBeenCalledWith(
      '안녕',
      expect.objectContaining({ model: 'custom-model' })
    )
    configure(GUILD, null)
    await handler(message({ content: `<@&${USER}> 안녕` }))
    expect(generate).toHaveBeenCalledTimes(1)
  })
  it('bounds output to one ordinary message and disables all mentions', async () => {
    configure()
    generate.mockResolvedValue('@everyone ' + 'a'.repeat(2500))
    const input = message()
    await createRoleChatHandler(generate)(input)
    const payload = vi.mocked(input.reply).mock.calls[0]?.[0] as { content: string }
    expect(payload.content).toHaveLength(2000)
    expect(payload.content).toContain('@everyone')
    expect(payload).toEqual({
      content: expect.any(String),
      allowedMentions: { parse: [], repliedUser: false }
    })
  })
  it('enforces per-user cooldowns and persisted hourly guild limits', async () => {
    configure(GUILD, { roleId: ROLE, cooldownSeconds: 5, requestsPerHour: 2 })
    const handler = createRoleChatHandler(generate)
    await handler(message())
    await handler(message())
    expect(generate).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5001)
    await handler(message())
    await createRoleChatHandler(generate)(message({ author: { id: ROLE, bot: false } }))
    expect(generate).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(60 * 60_000)
    await handler(message())
    expect(generate).toHaveBeenCalledTimes(3)
  })
  it('enforces a global hourly cost cap', async () => {
    configure()
    setStoredValue(
      'community:role-chat-rate:global',
      JSON.stringify({ windowStart: Date.now(), count: 100 })
    )
    await createRoleChatHandler(generate)(message())
    expect(generate).not.toHaveBeenCalled()
  })
  it('allows concurrent users in one guild, caps global concurrency, and releases slots', async () => {
    let finish!: (value: string) => void
    generate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    configure()
    configure(USER)
    configure(ROLE)
    const handler = createRoleChatHandler(generate)
    const first = handler(message())
    const finishFirst = finish
    const second = handler(message({ author: { id: ROLE, bot: false } }))
    const finishSecond = finish
    await handler(message({ guildId: ROLE }))
    await handler(message({ guildId: USER }))
    expect(generate).toHaveBeenCalledTimes(2)
    finishFirst('first')
    finishSecond('second')
    await Promise.all([first, second])
    generate.mockResolvedValue('third')
    await handler(message({ guildId: ROLE }))
    expect(generate).toHaveBeenCalledTimes(3)
  })
  it.each(['failure', 'empty'])(
    'returns a safe ordinary error on %s and releases concurrency',
    async (mode) => {
      configure()
      if (mode === 'failure') generate.mockRejectedValueOnce(new Error('secret-token'))
      else generate.mockResolvedValueOnce('')
      const input = message()
      const handler = createRoleChatHandler(generate)
      await handler(input)
      expect(input.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('지금은') })
      )
      expect(JSON.stringify(vi.mocked(input.reply).mock.calls)).not.toContain('secret-token')
      await handler(message({ author: { id: ROLE, bot: false } }))
      expect(generate).toHaveBeenCalledTimes(2)
    }
  )
  it('keeps internal rate limit state hidden from list', async () => {
    configure()
    await createRoleChatHandler(generate)(message())
    const calls = await dispatch(commandJSON('list community'), makeSubcommands(list))
    expect(JSON.stringify(getCallback(calls))).not.toContain('role-chat-rate')
  })
})

describe('role chat typing indicators', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
    })
    return { promise, resolve, reject }
  }

  it('starts immediately, refreshes during generation and reply delivery, and stops afterwards', async () => {
    configure()
    const generation = deferred<string>()
    const delivery = deferred<void>()
    generate.mockReturnValue(generation.promise)
    const input = message({ reply: vi.fn(() => delivery.promise) })
    const pending = createRoleChatHandler(generate)(input)
    expect(sendTyping).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(16000)
    expect(sendTyping).toHaveBeenCalledTimes(3)
    generation.resolve('done')
    await vi.advanceTimersByTimeAsync(8000)
    expect(input.reply).toHaveBeenCalledTimes(1)
    expect(sendTyping).toHaveBeenCalledTimes(4)
    delivery.resolve()
    await pending
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(16000)
    expect(sendTyping).toHaveBeenCalledTimes(4)
  })

  it('shares one channel timer and keeps typing until the last concurrent reply finishes', async () => {
    configure()
    const first = deferred<string>()
    const second = deferred<string>()
    generate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const handler = createRoleChatHandler(generate)
    const a = handler(message())
    const b = handler(message({ author: { id: ROLE, bot: false } }))
    expect(generate).toHaveBeenCalledTimes(2)
    expect(sendTyping).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(8000)
    expect(sendTyping).toHaveBeenCalledTimes(2)
    // The later request finishes first; its outgoing reply must not stop the first's indicator.
    second.resolve('second')
    await b
    expect(sendTyping).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(8000)
    expect(sendTyping).toHaveBeenCalledTimes(4)
    first.resolve('first')
    await a
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(8000)
    expect(sendTyping).toHaveBeenCalledTimes(4)
  })

  it('tracks different channels independently, including in the same guild', async () => {
    configure()
    const first = deferred<string>()
    const second = deferred<string>()
    const otherTyping = vi.fn().mockResolvedValue(undefined)
    generate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const handler = createRoleChatHandler(generate)
    const a = handler(message())
    const b = handler(
      message({
        channelId: '888888888888888888',
        channel: { sendTyping: otherTyping },
        author: { id: ROLE, bot: false }
      })
    )
    await vi.advanceTimersByTimeAsync(8000)
    expect(sendTyping).toHaveBeenCalledTimes(2)
    expect(otherTyping).toHaveBeenCalledTimes(2)
    first.resolve('first')
    await a
    await vi.advanceTimersByTimeAsync(8000)
    expect(sendTyping).toHaveBeenCalledTimes(2)
    expect(otherTyping).toHaveBeenCalledTimes(3)
    second.resolve('second')
    await b
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not overlap slow typing requests or block response generation', async () => {
    configure()
    const typing = deferred<void>()
    const generation = deferred<string>()
    sendTyping.mockReturnValue(typing.promise)
    generate.mockReturnValue(generation.promise)
    const pending = createRoleChatHandler(generate)(message())
    expect(generate).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(16000)
    expect(sendTyping).toHaveBeenCalledTimes(1)
    typing.resolve()
    await vi.advanceTimersByTimeAsync(8000)
    expect(sendTyping).toHaveBeenCalledTimes(2)
    generation.resolve('done')
    await pending
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['reject', 'throw'])(
    'ignores typing %s failures and retries on the next interval',
    async (failure) => {
      configure()
      const generation = deferred<string>()
      generate.mockReturnValue(generation.promise)
      if (failure === 'reject') sendTyping.mockRejectedValueOnce(new Error('missing permissions'))
      else
        sendTyping.mockImplementationOnce(() => {
          throw new Error('missing permissions')
        })
      const input = message()
      const pending = createRoleChatHandler(generate)(input)
      await vi.advanceTimersByTimeAsync(8000)
      expect(sendTyping).toHaveBeenCalledTimes(2)
      generation.resolve('done')
      await pending
      expect(input.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'done' }))
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('cleans up after generation and delivery failures without blocking later requests', async () => {
    configure()
    generate.mockRejectedValueOnce(new Error('timeout'))
    const handler = createRoleChatHandler(generate)
    const failure = handler(
      message({ reply: vi.fn().mockRejectedValue(new Error('deleted message')) })
    )
    await expect(failure).rejects.toThrow('deleted message')
    expect(vi.getTimerCount()).toBe(0)
    await handler(message({ author: { id: ROLE, bot: false } }))
    expect(generate).toHaveBeenCalledTimes(2)
    expect(sendTyping).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start typing for requests rejected by rate or concurrency limits', async () => {
    configure()
    const generation = deferred<string>()
    generate.mockReturnValue(generation.promise)
    const handler = createRoleChatHandler(generate)
    const a = handler(message())
    await handler(message()) // Same-user cooldown.
    const b = handler(message({ author: { id: ROLE, bot: false } }))
    const otherTyping = vi.fn()
    await handler(
      message({
        author: { id: GUILD, bot: false },
        channelId: USER,
        channel: { sendTyping: otherTyping }
      })
    )
    expect(otherTyping).not.toHaveBeenCalled()
    expect(sendTyping).toHaveBeenCalledTimes(1)
    generation.resolve('done')
    await Promise.all([a, b])
    const calls = sendTyping.mock.calls.length
    setStoredValue(
      'community:role-chat-rate:global',
      JSON.stringify({ windowStart: Date.now(), count: 100 })
    )
    await handler(message({ author: { id: GUILD, bot: false } }))
    expect(sendTyping).toHaveBeenCalledTimes(calls)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('random replies and processing acknowledgements', () => {
  it.each([0, 0.009999, 0.01, 0.99])(
    'replies without a role mention only below the 1%% threshold: %s',
    async (chance) => {
      configure()
      expect(loadCommunitySettings(GUILD).roleChat?.randomReplyChance).toBe(0.01)
      const input = message({ content: '그냥 일반 채팅' })
      await createRoleChatHandler(generate, () => chance)(input)
      expect(generate).toHaveBeenCalledTimes(chance < 0.01 ? 1 : 0)
      expect(input.react).toHaveBeenCalledTimes(chance < 0.01 ? 1 : 0)
      expect(input.reply).toHaveBeenCalledTimes(chance < 0.01 ? 1 : 0)
      if (chance < 0.01) {
        expect(generate).toHaveBeenCalledWith('그냥 일반 채팅', expect.any(Object))
        expect(input.react).toHaveBeenCalledWith('✅')
      }
    }
  )

  it('can disable random replies while keeping explicit role calls', async () => {
    configure(GUILD, { roleId: ROLE, randomReplyChance: 0 })
    const handler = createRoleChatHandler(generate, () => 0)
    await handler(message({ content: '일반 채팅' }))
    expect(generate).not.toHaveBeenCalled()
    const input = message()
    await handler(input)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(input.react).toHaveBeenCalledWith('✅')
  })

  it('applies the same cooldown and rate limits to random and explicit requests', async () => {
    configure(GUILD, { roleId: ROLE, requestsPerHour: 1 })
    const handler = createRoleChatHandler(generate, () => 0)
    const first = message({ content: '일반 채팅' })
    await handler(first)
    const cooldown = message()
    await handler(cooldown)
    const rateLimited = message({ author: { id: ROLE, bot: false } })
    await handler(rateLimited)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(first.react).toHaveBeenCalledWith('✅')
    expect(cooldown.react).not.toHaveBeenCalled()
    expect(rateLimited.react).not.toHaveBeenCalled()
  })

  it('never randomly replies to bots, webhooks, DMs, unconfigured guilds, or empty messages', async () => {
    configure()
    const handler = createRoleChatHandler(generate, () => 0)
    for (const overrides of [
      { author: { id: USER, bot: true } },
      { webhookId: USER },
      { guildId: null },
      { guildId: USER },
      { content: '   ' },
      { system: true }
    ]) {
      const input = message({ content: '일반 채팅', ...overrides })
      await handler(input)
      expect(input.react).not.toHaveBeenCalled()
    }
    expect(generate).not.toHaveBeenCalled()
  })

  it('acknowledges each concurrent request without reacting to excess requests', async () => {
    configure()
    let finish!: (value: string) => void
    generate.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const handler = createRoleChatHandler(generate)
    const a = message()
    const b = message({ author: { id: ROLE, bot: false } })
    const rejected = message({ author: { id: GUILD, bot: false } })
    const first = handler(a)
    const second = handler(b)
    await handler(rejected)
    expect(a.react).toHaveBeenCalledExactlyOnceWith('✅')
    expect(b.react).toHaveBeenCalledExactlyOnceWith('✅')
    expect(rejected.react).not.toHaveBeenCalled()
    finish('done')
    await Promise.all([first, second])
  })

  it('does not block or fail replies when reactions fail', async () => {
    configure()
    const input = message({ react: vi.fn().mockRejectedValue(new Error('missing AddReactions')) })
    await createRoleChatHandler(generate)(input)
    expect(input.reply).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('plain Markdown text generation', () => {
  it('can disable web search through /a configuration', async () => {
    const settings = configure(GUILD, { roleId: ROLE, webSearch: false }).roleChat!
    await generateRoleChatReply('hi', settings)
    const request = createResponse.mock.calls[0]?.[0]
    expect(request).toMatchObject({ tools: [], tool_choice: 'none' })
    expect(request).not.toHaveProperty('max_tool_calls')
    expect(request.instructions).toContain('No tools are available.')
  })
  it('allows only OpenAI web search, without histories or agent infrastructure', async () => {
    const settings = configure(GUILD, {
      roleId: ROLE,
      model: 'chat-model',
      systemPrompt: 'Be kind',
      maxOutputTokens: 512
    }).roleChat!
    expect(await generateRoleChatReply('안녕', settings)).toBe('**안녕하세요!**')
    expect(createClient).toHaveBeenCalledWith({
      apiKey: 'secret-token',
      baseURL: 'https://api.example.com/v1',
      maxRetries: 0,
      timeout: 30000
    })
    expect(createResponse).toHaveBeenCalledExactlyOnceWith(
      {
        model: 'chat-model',
        input: '안녕',
        instructions: expect.stringContaining('Be kind'),
        tools: [{ type: 'web_search' }],
        tool_choice: 'auto',
        max_tool_calls: 2,
        max_output_tokens: 512,
        store: false
      },
      { signal: expect.any(AbortSignal) }
    )
  })
  it.each([
    { status: 'incomplete', output_text: 'partial' },
    { status: 'completed', output_text: '' }
  ])('rejects malformed or incomplete service output %j', async (response) => {
    createResponse.mockResolvedValue(response)
    await expect(generateRoleChatReply('hi', configure().roleChat!)).rejects.toThrow()
  })
  it('propagates service timeout without retrying', async () => {
    createResponse.mockRejectedValueOnce(new Error('timeout'))
    await expect(generateRoleChatReply('hi', configure().roleChat!)).rejects.toThrow('timeout')
    expect(createResponse).toHaveBeenCalledTimes(1)
  })
  it.each([
    { roleId: 'bad' },
    { roleId: ROLE, maxOutputTokens: 100000 },
    { roleId: ROLE, cooldownSeconds: 0 },
    { roleId: ROLE, requestsPerHour: 10000 },
    { roleId: ROLE, randomReplyChance: -1 },
    { roleId: ROLE, randomReplyChance: 1.1 }
  ])('rejects invalid configuration %j', (settings) => {
    expect(() => configure(GUILD, settings)).toThrow()
    expect(loadCommunitySettings(GUILD).roleChat).toBeNull()
  })
})
