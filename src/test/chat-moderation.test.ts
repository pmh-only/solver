import { join } from 'node:path'
import {
  MessageFlags,
  MessageType,
  type Message,
  type MessageReaction,
  type User
} from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChatModerationHandler, createModerationReactionHandler } from '../chat-moderation.js'
import { manageCommunitySettings, loadCommunitySettings } from '../community-settings.js'
import {
  clearStoredValues,
  getStoredValue,
  setStoredValue,
  isInternalStoredKey
} from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import { clearRuntimeIssuesForTests, runtimeIssueSummary } from '../runtime-health.js'

const KEY = 'community:chat-moderation'
const provider = vi.hoisted(() => ({ create: vi.fn(), options: vi.fn(), key: vi.fn() }))
vi.mock('openai', () => ({
  default: class {
    moderations = { create: provider.create }
    constructor(options: unknown) {
      provider.options(options)
    }
  }
}))
vi.mock('../openai-config.js', () => ({
  loadOpenAIApiKey: provider.key,
  loadOpenAIEndpoint: () => 'https://api.openai.com/v1'
}))
const GUILD = '333333333333333333'
const CHANNEL = '777777777777777777'
const ID = '1000000000000000001'
const flagged = {
  flagged: true,
  categories: { harassment: true, hate: false, 'violence/graphic': true }
}

function message(overrides: Record<string, unknown> = {}) {
  const source = {
    guildId: GUILD,
    channelId: CHANNEL,
    id: ID,
    type: MessageType.Default,
    author: { bot: false },
    webhookId: null,
    content: 'private original text',
    react: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as Message
  source.fetch = vi.fn().mockResolvedValue(source)
  return source
}
function reaction(source: Message, emoji = '⚠️') {
  return { message: source, emoji: { name: emoji, id: null } } as MessageReaction
}
const user = { id: '555555555555555555', bot: false } as User

beforeEach(() => {
  vi.useFakeTimers()
  isolateStoredValues(join(process.cwd(), '.tmp', 'chat-moderation.test.sqlite'))
  clearStoredValues()
  clearRuntimeIssuesForTests()
  provider.create.mockReset().mockResolvedValue({ results: [flagged] })
  provider.options.mockReset()
  provider.key.mockReset().mockReturnValue('test-key')
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('chat moderation', () => {
  it('uses the existing OpenAI credential/endpoint and bounded SDK options', async () => {
    const source = message()
    await createChatModerationHandler()(source)
    expect(provider.options).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://api.openai.com/v1',
      timeout: 10_000,
      maxRetries: 0
    })
    expect(provider.create).toHaveBeenCalledExactlyOnceWith({
      model: 'omni-moderation-latest',
      input: source.content
    })
    expect(source.react).toHaveBeenCalledWith('⚠️')
  })
  it('safely handles SDK timeouts, missing credentials and reaction permission failures', async () => {
    provider.create.mockRejectedValueOnce(new Error('request timed out'))
    const handler = createChatModerationHandler()
    const source = message()
    await handler(source)
    expect(source.react).not.toHaveBeenCalled()
    provider.key.mockReturnValueOnce(undefined)
    await handler(source)
    expect(provider.create).toHaveBeenCalledTimes(1)
    vi.mocked(source.react).mockRejectedValueOnce(new Error('missing permissions'))
    await handler(source)
    expect(runtimeIssueSummary()).toContain('chat_moderation')
  })
  it('defaults on and supports /a configuration without overwriting unrelated settings', () => {
    expect(loadCommunitySettings().chatModeration).toEqual({
      enabled: true,
      requestsPerMinute: 120
    })
    manageCommunitySettings({
      action: 'update',
      settings: { chatModeration: { enabled: false, requestsPerMinute: 3 } }
    })
    expect(loadCommunitySettings().chatModeration.enabled).toBe(false)
    expect(loadCommunitySettings().messageCommands.enabled).toBe(true)
    expect(() =>
      manageCommunitySettings({
        action: 'update',
        settings: { chatModeration: { requestsPerMinute: 0 } }
      })
    ).toThrow()
  })
  it('checks text, reacts on detection and stores only flagged categories', async () => {
    const moderate = vi.fn().mockResolvedValue(flagged)
    const source = message()
    await createChatModerationHandler(moderate)(source)
    expect(moderate).toHaveBeenCalledExactlyOnceWith(source.content)
    expect(source.react).toHaveBeenCalledExactlyOnceWith('⚠️')
    const stored = getStoredValue(KEY)!
    expect(JSON.parse(stored)[`${GUILD}:${CHANNEL}:${ID}`].categories).toEqual([
      'harassment',
      'violence/graphic'
    ])
    expect(stored).not.toContain(source.content)
    expect(isInternalStoredKey(KEY)).toBe(true)
  })
  it.each([
    { guildId: null },
    { author: { bot: true } },
    { webhookId: 'webhook' },
    { type: MessageType.ChannelPinnedMessage },
    { content: '  ' }
  ])('ignores non-ordinary human guild text: %j', async (overrides) => {
    const moderate = vi.fn()
    await createChatModerationHandler(moderate)(message(overrides))
    expect(moderate).not.toHaveBeenCalled()
  })
  it('supports reply/thread text and bounds input to Discord text size', async () => {
    const moderate = vi.fn().mockResolvedValue({ flagged: false, categories: {} })
    await createChatModerationHandler(moderate)(
      message({ type: MessageType.Reply, content: 'x'.repeat(5000) })
    )
    expect(moderate).toHaveBeenCalledWith('x'.repeat(4000))
    expect(getStoredValue(KEY)).toBeUndefined()
  })
  it('does not react on a clean result or when disabled', async () => {
    const moderate = vi.fn().mockResolvedValue({ flagged: false, categories: { hate: false } })
    const source = message()
    const handler = createChatModerationHandler(moderate)
    await handler(source)
    manageCommunitySettings({ action: 'update', settings: { chatModeration: { enabled: false } } })
    await handler(source)
    expect(moderate).toHaveBeenCalledTimes(1)
    expect(source.react).not.toHaveBeenCalled()
  })
  it.each([undefined, { flagged: true, categories: { hate: 'yes' } }])(
    'safely reports malformed results',
    async (result) => {
      const source = message()
      await createChatModerationHandler(vi.fn().mockResolvedValue(result))(source)
      expect(source.react).not.toHaveBeenCalled()
      expect(runtimeIssueSummary()).toContain('chat_moderation')
    }
  )
  it('does not leak provider errors or break other gateway handling', async () => {
    await createChatModerationHandler(
      vi.fn().mockRejectedValue(new Error('secret submitted text'))
    )(message())
    expect(runtimeIssueSummary()).toContain('Chat moderation failed')
    expect(runtimeIssueSummary()).not.toContain('secret submitted text')
  })
  it('limits requests per minute, resetting the window', async () => {
    manageCommunitySettings({
      action: 'update',
      settings: { chatModeration: { requestsPerMinute: 1 } }
    })
    const moderate = vi.fn().mockResolvedValue({ flagged: false, categories: {} })
    const handler = createChatModerationHandler(moderate)
    await handler(message())
    await handler(message())
    expect(moderate).toHaveBeenCalledTimes(1)
    expect(runtimeIssueSummary()).toContain('capacity')
    await vi.advanceTimersByTimeAsync(60_000)
    await handler(message())
    expect(moderate).toHaveBeenCalledTimes(2)
  })
  it('coalesces duplicates, bounds concurrent checks and releases slots on failure', async () => {
    let resolve!: (value: unknown) => void
    const moderate = vi.fn().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const handler = createChatModerationHandler(moderate)
    const pending = handler(message())
    await handler(message())
    expect(moderate).toHaveBeenCalledTimes(1)
    resolve(flagged)
    await pending
    await handler(message())
    expect(moderate).toHaveBeenCalledTimes(1)
    const completes: Array<(value: unknown) => void> = []
    moderate.mockImplementation(
      () =>
        new Promise((done) => {
          completes.push(done)
        })
    )
    const jobs = Array.from({ length: 5 }, (_, i) =>
      handler(message({ id: String(2000000000000000000n + BigInt(i)) }))
    )
    expect(completes).toHaveLength(4)
    completes.forEach((done) => done({ flagged: false, categories: {} }))
    await Promise.all(jobs)
    moderate.mockResolvedValue({ flagged: false, categories: {} })
    await handler(message({ id: '3000000000000000000' }))
    expect(moderate).toHaveBeenCalledTimes(6)
  })
  it('does not apply detections if disabled while a request is running', async () => {
    const source = message()
    const handler = createChatModerationHandler(async () => {
      manageCommunitySettings({
        action: 'update',
        settings: { chatModeration: { enabled: false } }
      })
      return flagged
    })
    await handler(source)
    expect(source.react).not.toHaveBeenCalled()
  })
})

describe('warning reaction results', () => {
  beforeEach(async () => {
    await createChatModerationHandler(async () => flagged)(message())
  })
  it('displays persisted categories publicly in the same channel without mentions', async () => {
    const source = message()
    await createModerationReactionHandler()(reaction(source), user)
    expect(source.fetch).toHaveBeenCalledOnce()
    const payload = vi.mocked(source.reply).mock.calls[0]![0]
    expect(payload).toMatchObject({
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [], repliedUser: false }
    })
    const output = JSON.stringify(payload)
    expect(output).toContain('harassment')
    expect(output).toContain('violence/graphic')
    expect(output).not.toContain('(hate)')
    expect(output).not.toContain(source.content)
  })
  it('handles uncached partial messages with an unqualified warning emoji', async () => {
    const source = message()
    const partial = {
      id: ID,
      guildId: GUILD,
      channelId: CHANNEL,
      fetch: vi.fn().mockResolvedValue(source)
    } as unknown as Message
    await createModerationReactionHandler()(reaction(partial, '⚠'), user)
    expect(source.reply).toHaveBeenCalledOnce()
  })
  it('resolves uncached users and ignores bots after fetching', async () => {
    const source = message()
    const fetch = vi.fn().mockResolvedValue({ ...user, bot: true })
    const partial = { partial: true, bot: null, fetch } as unknown as User
    await createModerationReactionHandler()(reaction(source), partial)
    expect(fetch).toHaveBeenCalledOnce()
    expect(source.reply).not.toHaveBeenCalled()
    fetch.mockResolvedValue(user)
    await createModerationReactionHandler()(reaction(source), partial)
    expect(source.reply).toHaveBeenCalledOnce()
  })
  it('coalesces concurrent additions and allows another display after one minute', async () => {
    const source = message()
    const handler = createModerationReactionHandler()
    await Promise.all([handler(reaction(source), user), handler(reaction(source), user)])
    expect(source.reply).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    await handler(reaction(source), user)
    expect(source.reply).toHaveBeenCalledTimes(2)
  })
  it('ignores bots, other emoji, untracked messages and cross-guild/channel IDs', async () => {
    const source = message()
    const handler = createModerationReactionHandler()
    await handler(reaction(source), { ...user, bot: true } as User)
    await handler(reaction(source, '⭐'), user)
    for (const overrides of [
      { guildId: null },
      { guildId: '444444444444444444' },
      { channelId: '888888888888888888' },
      { id: '2000000000000000000' }
    ]) {
      const other = message(overrides)
      await handler(reaction(other), user)
      expect(other.reply).not.toHaveBeenCalled()
    }
    expect(source.reply).not.toHaveBeenCalled()
  })
  it('does not reveal expired, corrupt or disabled results', async () => {
    const source = message()
    const handler = createModerationReactionHandler()
    await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60_000)
    await handler(reaction(source), user)
    expect(getStoredValue(KEY)).toBe('{}')
    setStoredValue(KEY, '{broken')
    await handler(reaction(source), user)
    manageCommunitySettings({ action: 'reset-chat-moderation' })
    expect(getStoredValue(KEY)).toBeUndefined()
    manageCommunitySettings({ action: 'update', settings: { chatModeration: { enabled: false } } })
    await handler(reaction(source), user)
    expect(source.reply).not.toHaveBeenCalled()
  })
  it('handles deleted messages and failed delivery safely, permitting a later retry', async () => {
    const source = message()
    vi.mocked(source.fetch).mockRejectedValueOnce(new Error('deleted'))
    const handler = createModerationReactionHandler()
    await handler(reaction(source), user)
    expect(source.reply).not.toHaveBeenCalled()
    expect(runtimeIssueSummary()).toContain('chat_moderation_reaction')
    await handler(reaction(source), user)
    expect(source.reply).toHaveBeenCalledOnce()
  })
  it('bounds persisted state to the newest 1000 results', async () => {
    const record = { categories: ['hate'], createdAt: Date.now() - 1, shownAt: 0 }
    setStoredValue(
      KEY,
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 1000 }, (_, i) => [
            `${GUILD}:${CHANNEL}:${2000000000000000000n + BigInt(i)}`,
            record
          ])
        )
      )
    )
    await createChatModerationHandler(async () => flagged)(message())
    const stored = JSON.parse(getStoredValue(KEY)!)
    expect(Object.keys(stored)).toHaveLength(1000)
    expect(stored[`${GUILD}:${CHANNEL}:${ID}`]).toBeDefined()
  })
})
