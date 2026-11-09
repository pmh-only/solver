import { join } from 'node:path'
import {
  Collection,
  MessageType,
  type Attachment,
  type Message,
  type PartialMessage,
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
  categories: { harassment: true, hate: false, 'violence/graphic': true },
  category_scores: { harassment: 0.98765, hate: 0.01, 'violence/graphic': 0.8532 }
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
    attachments: new Collection(),
    reactions: { cache: new Collection() },
    client: { rest: { delete: vi.fn().mockResolvedValue(undefined) } },
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
  vi.unstubAllGlobals()
})

function attachment(overrides: Record<string, unknown> = {}): Attachment {
  return {
    id: '9000000000000000001',
    size: 100,
    contentType: 'image/png',
    url: 'https://cdn.discordapp.com/attachments/777777777777777777/9000000000000000001/image.png?ex=123&sig=secret',
    ...overrides
  } as Attachment
}
function files(...items: Attachment[]) {
  return new Collection(items.map((item) => [item.id, item]))
}

describe('edited messages and attachment moderation', () => {
  it('rechecks edits, replaces categories/scores, and removes only the bot warning when clean', async () => {
    const moderate = vi
      .fn()
      .mockResolvedValueOnce(flagged)
      .mockResolvedValueOnce({
        flagged: true,
        categories: { hate: true },
        category_scores: { hate: 0.9234 }
      })
      .mockResolvedValueOnce({ flagged: false, categories: {} })
    const handler = createChatModerationHandler(moderate)
    const source = message()
    await handler(source)
    source.content = 'edited harmful content'
    await handler(source)
    const record = JSON.parse(getStoredValue(KEY)!)[`${GUILD}:${CHANNEL}:${ID}`]
    expect(record.categories).toEqual(['hate'])
    expect(record.scores).toEqual({ hate: 0.9234 })
    source.content = 'now safe'
    await handler(source)
    expect(moderate).toHaveBeenCalledTimes(3)
    expect(getStoredValue(KEY)).toBe('{}')
    expect(source.client.rest.delete).toHaveBeenCalledExactlyOnceWith(
      `/channels/${CHANNEL}/messages/${ID}/reactions/${encodeURIComponent('⚠️')}/@me`
    )
  })
  it('checks uncached edited messages and safely handles fetch failures', async () => {
    const source = message()
    const fetch = vi.fn().mockRejectedValueOnce(new Error('gone')).mockResolvedValue(source)
    const partial = { partial: true, guildId: GUILD, fetch } as unknown as PartialMessage
    const moderate = vi.fn().mockResolvedValue(flagged)
    const handler = createChatModerationHandler(moderate)
    await handler(partial)
    expect(moderate).not.toHaveBeenCalled()
    await handler(partial)
    expect(moderate).toHaveBeenCalledExactlyOnceWith(source.content)
  })
  it.each(['resolve', 'reject'])(
    'never applies a stale in-flight result on edits (%s)',
    async (outcome) => {
      let resolve!: (value: unknown) => void
      let reject!: (error: Error) => void
      const moderate = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((done, fail) => {
              resolve = done
              reject = fail
            })
        )
        .mockResolvedValueOnce({
          flagged: true,
          categories: { hate: true },
          category_scores: { hate: 0.99 }
        })
      const handler = createChatModerationHandler(moderate)
      const source = message()
      const first = handler(source)
      await vi.advanceTimersByTimeAsync(0)
      source.content = 'new revision'
      const edited = handler(source)
      if (outcome === 'resolve') resolve(flagged)
      else reject(new Error('old request failed'))
      await Promise.all([first, edited])
      expect(moderate).toHaveBeenCalledTimes(2)
      expect(moderate).toHaveBeenLastCalledWith('new revision')
      expect(source.react).toHaveBeenCalledTimes(1)
      expect(JSON.parse(getStoredValue(KEY)!)[`${GUILD}:${CHANNEL}:${ID}`].categories).toEqual([
        'hate'
      ])
    }
  )
  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])(
    'checks attachment-only %s messages',
    async (contentType) => {
      const fetch = vi.fn()
      vi.stubGlobal('fetch', fetch)
      const file = attachment({ contentType })
      const source = message({ content: '', attachments: files(file) })
      await createChatModerationHandler()(source)
      expect(provider.create).toHaveBeenCalledExactlyOnceWith({
        model: 'omni-moderation-latest',
        input: [{ type: 'image_url', image_url: { url: file.url } }]
      })
      expect(fetch).not.toHaveBeenCalled()
      expect(source.react).toHaveBeenCalledWith('⚠️')
      expect(getStoredValue(KEY)).not.toContain('sig=secret')
    }
  )
  it('checks body and multiple attachments together and rechecks attachment replacements/removal', async () => {
    const moderate = vi
      .fn()
      .mockResolvedValueOnce(flagged)
      .mockResolvedValueOnce(flagged)
      .mockResolvedValueOnce({ flagged: false, categories: {} })
    const handler = createChatModerationHandler(moderate)
    const first = attachment()
    const second = attachment({
      id: '9000000000000000002',
      url: first.url.replace('image.png', 'second.png')
    })
    const source = message({ attachments: files(first, second) })
    await handler(source)
    expect(moderate).toHaveBeenCalledWith([
      { type: 'text', text: source.content },
      { type: 'image_url', image_url: { url: first.url } },
      { type: 'image_url', image_url: { url: second.url } }
    ])
    source.attachments = files(second)
    await handler(source)
    source.attachments = files()
    await handler(source)
    expect(moderate).toHaveBeenCalledTimes(3)
    expect(source.client.rest.delete).toHaveBeenCalledOnce()
  })
  it('clears the warning when an attachment-only message becomes empty', async () => {
    const source = message({ content: '', attachments: files(attachment()) })
    const handler = createChatModerationHandler()
    await handler(source)
    source.attachments = files()
    await handler(source)
    expect(provider.create).toHaveBeenCalledTimes(1)
    expect(source.client.rest.delete).toHaveBeenCalledOnce()
    expect(getStoredValue(KEY)).toBe('{}')
  })
  it('downloads UTF-8 text/JSON attachments with bounded streaming and no redirects', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(
        async () => new Response('file content', { headers: { 'content-length': '12' } })
      )
    vi.stubGlobal('fetch', fetch)
    const file = attachment({
      contentType: 'application/json',
      size: 12,
      url: attachment().url.replace('image.png', 'body.json')
    })
    const source = message({ attachments: files(file) })
    await createChatModerationHandler()(source)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(file.url, {
      redirect: 'error',
      signal: expect.any(AbortSignal)
    })
    expect(provider.create).toHaveBeenCalledWith({
      model: 'omni-moderation-latest',
      input: [
        { type: 'text', text: source.content },
        { type: 'text', text: 'file content' }
      ]
    })
    expect(getStoredValue(KEY)).not.toContain('file content')
  })
  it.each([
    { url: 'http://127.0.0.1/file.txt', contentType: 'text/plain' },
    { url: 'https://evil.example/file.png' },
    { url: 'https://cdn.discordapp.com/other/image.png' },
    { contentType: 'application/pdf' },
    { contentType: 'video/mp4' },
    { contentType: 'audio/mpeg' },
    { size: 21 * 1024 * 1024 },
    { contentType: 'text/plain', size: 65537 }
  ])('does not fetch or claim unsupported/unsafe attachments are clean: %j', async (overrides) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const source = message({ content: '', attachments: files(attachment(overrides)) })
    await createChatModerationHandler()(source)
    expect(fetch).not.toHaveBeenCalled()
    expect(provider.create).not.toHaveBeenCalled()
    expect(runtimeIssueSummary()).toContain('attachments could not be checked')
  })
  it.each(['timeout', 'oversized-header', 'oversized-stream', 'invalid-utf8', 'http-error'])(
    'reports failed text downloads without dropping body checks (%s)',
    async (failure) => {
      const fetch = vi.fn().mockImplementation(async () => {
        if (failure === 'timeout') throw new Error('timed out: secret URL')
        if (failure === 'oversized-header')
          return new Response('small', { headers: { 'content-length': '65537' } })
        if (failure === 'oversized-stream') return new Response('x'.repeat(65537))
        if (failure === 'invalid-utf8') return new Response(new Uint8Array([0xff]))
        return new Response('error', { status: 503 })
      })
      vi.stubGlobal('fetch', fetch)
      const source = message({ attachments: files(attachment({ contentType: 'text/plain' })) })
      await createChatModerationHandler()(source)
      expect(provider.create).toHaveBeenCalledWith({
        model: 'omni-moderation-latest',
        input: source.content
      })
      expect(runtimeIssueSummary()).toContain('attachments could not be checked')
      expect(runtimeIssueSummary()).not.toContain('secret URL')
      await createModerationReactionHandler()(reaction(source), user)
      expect(JSON.stringify(vi.mocked(source.reply).mock.calls[0]![0])).toContain(
        '일부 첨부파일 검사 불가'
      )
    }
  )
  it('does not send over-budget image/text totals', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('x'.repeat(40000)))
    vi.stubGlobal('fetch', fetch)
    const first = attachment({ size: 11 * 1024 * 1024 })
    const second = attachment({ id: '9000000000000000002', size: 11 * 1024 * 1024 })
    const text = attachment({ id: '9000000000000000003', size: 40000, contentType: 'text/plain' })
    const text2 = attachment({ id: '9000000000000000004', size: 40000, contentType: 'text/plain' })
    const source = message({ content: '', attachments: files(first, second, text, text2) })
    await createChatModerationHandler()(source)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(provider.create).toHaveBeenCalledWith({
      model: 'omni-moderation-latest',
      input: [
        { type: 'image_url', image_url: { url: first.url } },
        { type: 'text', text: 'x'.repeat(40000) }
      ]
    })
    expect(runtimeIssueSummary()).toContain('attachments could not be checked')
  })
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
    await handler(message({ id: '2000000000000000000' }))
    expect(moderate).toHaveBeenCalledTimes(1)
    expect(runtimeIssueSummary()).toContain('capacity')
    await vi.advanceTimersByTimeAsync(60_000)
    await handler(message({ id: '2000000000000000000' }))
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
    const duplicate = handler(message())
    await vi.advanceTimersByTimeAsync(0)
    expect(moderate).toHaveBeenCalledTimes(1)
    resolve(flagged)
    await pending
    await duplicate
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
    await vi.advanceTimersByTimeAsync(0)
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
      embeds: [expect.anything()],
      allowedMentions: { parse: [], repliedUser: false }
    })
    const output = JSON.stringify(payload)
    expect(output).toContain('harassment')
    expect(output).toContain('violence/graphic')
    expect(output).toContain('98.77%')
    expect(output).toContain('85.32%')
    expect(output).toContain('위반 확정 확률이 아닙니다')
    expect(output).not.toContain('(hate)')
    expect(output).not.toContain(source.content)
  })
  it('never displays old categories after a source edit, even before its new check finishes', async () => {
    const source = message({ content: 'new content' })
    await createModerationReactionHandler()(reaction(source), user)
    expect(source.reply).not.toHaveBeenCalled()
  })
  it('automatically refreshes legacy results instead of displaying missing scores', async () => {
    setStoredValue(
      KEY,
      JSON.stringify({
        [`${GUILD}:${CHANNEL}:${ID}`]: {
          categories: ['hate'],
          createdAt: Date.now(),
          shownAt: 0
        }
      })
    )
    const source = message()
    await createModerationReactionHandler()(reaction(source), user)
    const output = JSON.stringify(vi.mocked(source.reply).mock.calls[0]![0])
    expect(provider.create).toHaveBeenCalledExactlyOnceWith({
      model: 'omni-moderation-latest',
      input: source.content
    })
    expect(output).toContain('98.77%')
    expect(output).toContain('85.32%')
    expect(output).not.toContain('점수 없음')
    const stored = JSON.parse(getStoredValue(KEY)!)[`${GUILD}:${CHANNEL}:${ID}`]
    expect(stored.scores).toEqual({ harassment: 0.98765, 'violence/graphic': 0.8532 })
    expect(stored.signature).toMatch(/^[a-f0-9]{64}$/)
  })
  it('refreshes missing/partial scores even when the revision fingerprint matches', async () => {
    const source = message({ content: 'fresh revision checked by the shared handler' })
    const check = createChatModerationHandler()
    await check(source)
    const stored = JSON.parse(getStoredValue(KEY)!)
    delete stored[`${GUILD}:${CHANNEL}:${ID}`].scores['violence/graphic']
    setStoredValue(KEY, JSON.stringify(stored))
    const handler = createModerationReactionHandler(check)
    await handler(reaction(source), user)
    expect(provider.create).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(vi.mocked(source.reply).mock.calls[0]![0])).toContain('85.32%')
    await handler(reaction(source), user)
    expect(provider.create).toHaveBeenCalledTimes(2)
    expect(source.reply).toHaveBeenCalledTimes(1)
  })
  it('coalesces simultaneous score refreshes and persists the display cooldown', async () => {
    const source = message()
    const stored = JSON.parse(getStoredValue(KEY)!)
    delete stored[`${GUILD}:${CHANNEL}:${ID}`].scores
    setStoredValue(KEY, JSON.stringify(stored))
    let complete!: (result: unknown) => void
    const check = createChatModerationHandler(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const handler = createModerationReactionHandler(check)
    const first = handler(reaction(source), user)
    await vi.advanceTimersByTimeAsync(0)
    const duplicate = handler(reaction(source), user)
    complete(flagged)
    await Promise.all([first, duplicate])
    expect(source.reply).toHaveBeenCalledTimes(1)
    await handler(reaction(source), user)
    expect(source.reply).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    await handler(reaction(source), user)
    expect(source.reply).toHaveBeenCalledTimes(2)
  })
  it('reports providers that omit scores instead of pretending stored data is the only cause', async () => {
    const source = message()
    const stored = JSON.parse(getStoredValue(KEY)!)
    delete stored[`${GUILD}:${CHANNEL}:${ID}`].scores
    setStoredValue(KEY, JSON.stringify(stored))
    provider.create.mockResolvedValue({
      results: [{ flagged: true, categories: flagged.categories }]
    })
    await createModerationReactionHandler()(reaction(source), user)
    const output = JSON.stringify(vi.mocked(source.reply).mock.calls[0]![0])
    expect(output).toContain('점수 조회 불가')
    expect(output).not.toContain('0.00%')
    expect(runtimeIssueSummary()).toContain('omitted category_scores')
  })
  it('retains scoreless legacy results for another attempt if refresh fails', async () => {
    const source = message()
    setStoredValue(
      KEY,
      JSON.stringify({
        [`${GUILD}:${CHANNEL}:${ID}`]: {
          categories: ['hate'],
          createdAt: Date.now(),
          shownAt: 0
        }
      })
    )
    provider.create.mockRejectedValueOnce(new Error('provider unavailable'))
    const handler = createModerationReactionHandler()
    await handler(reaction(source), user)
    expect(source.reply).not.toHaveBeenCalled()
    expect(JSON.parse(getStoredValue(KEY)!)[`${GUILD}:${CHANNEL}:${ID}`]).toBeDefined()
    await vi.advanceTimersByTimeAsync(60_000)
    await handler(reaction(source), user)
    expect(JSON.stringify(vi.mocked(source.reply).mock.calls[0]![0])).toContain('98.77%')
  })
  it('uses the shared request budget for refreshes and retries after the window resets', async () => {
    const source = message({ content: 'fresh revision consuming the shared request budget' })
    manageCommunitySettings({
      action: 'update',
      settings: { chatModeration: { requestsPerMinute: 1 } }
    })
    const check = createChatModerationHandler()
    await check(source)
    const stored = JSON.parse(getStoredValue(KEY)!)
    delete stored[`${GUILD}:${CHANNEL}:${ID}`].scores
    setStoredValue(KEY, JSON.stringify(stored))
    const handler = createModerationReactionHandler(check)
    await handler(reaction(source), user)
    expect(provider.create).toHaveBeenCalledTimes(1)
    expect(runtimeIssueSummary()).toContain('capacity')
    await vi.advanceTimersByTimeAsync(60_000)
    await handler(reaction(source), user)
    expect(provider.create).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(vi.mocked(source.reply).mock.calls.at(-1)![0])).toContain('98.77%')
  })
  it('removes stale detection when a legacy result refresh now comes back clean', async () => {
    const source = message()
    setStoredValue(
      KEY,
      JSON.stringify({
        [`${GUILD}:${CHANNEL}:${ID}`]: {
          categories: ['hate'],
          createdAt: Date.now(),
          shownAt: 0
        }
      })
    )
    provider.create.mockResolvedValue({ results: [{ flagged: false, categories: {} }] })
    await createModerationReactionHandler()(reaction(source), user)
    expect(getStoredValue(KEY)).toBe('{}')
    expect(source.reply).not.toHaveBeenCalled()
    expect(source.client.rest.delete).toHaveBeenCalledOnce()
  })
  it('preserves exact 0% and 100% scores and rejects out-of-range provider scores', async () => {
    const source = message({ content: 'different input' })
    await createChatModerationHandler(async () => ({
      ...flagged,
      category_scores: { harassment: 0, 'violence/graphic': 1 }
    }))(source)
    await createModerationReactionHandler()(reaction(source), user)
    const output = JSON.stringify(vi.mocked(source.reply).mock.calls[0]![0])
    expect(output).toContain('0.00%')
    expect(output).toContain('100.00%')
    const bad = message({ id: '2000000000000000000' })
    await createChatModerationHandler(async () => ({
      ...flagged,
      category_scores: { harassment: 1.1 }
    }))(bad)
    expect(bad.react).not.toHaveBeenCalled()
    expect(runtimeIssueSummary()).toContain('chat_moderation')
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
