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

function message(overrides: Record<string, unknown> = {}) {
  return {
    guildId: GUILD,
    author: { id: USER, bot: false },
    webhookId: null,
    system: false,
    content: `<@&${ROLE}> 안녕`,
    reply: vi.fn().mockResolvedValue(undefined),
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
  generate.mockReset().mockResolvedValue('**안녕하세요!**')
  createResponse
    .mockReset()
    .mockResolvedValue({ status: 'completed', output_text: '**안녕하세요!**' })
})
afterEach(() => {
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
  it('limits concurrency per guild and globally and releases slots after completion', async () => {
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
    await handler(message({ author: { id: ROLE, bot: false } }))
    const second = handler(message({ guildId: USER }))
    const finishSecond = finish
    await handler(message({ guildId: ROLE }))
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

describe('tool-free text generation', () => {
  it('uses only the prompt, with no tools, histories, or agent infrastructure', async () => {
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
        tools: [],
        tool_choice: 'none',
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
    { roleId: ROLE, requestsPerHour: 10000 }
  ])('rejects invalid configuration %j', (settings) => {
    expect(() => configure(GUILD, settings)).toThrow()
    expect(loadCommunitySettings(GUILD).roleChat).toBeNull()
  })
})
