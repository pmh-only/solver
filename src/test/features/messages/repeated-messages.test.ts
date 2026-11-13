import { join } from 'node:path'
import { MessageType, type Message } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadCommunitySettings,
  manageCommunitySettings
} from '../../../features/community/settings.js'
import { clearStoredValues } from '../../../shared/storage/kv-store.js'
import { isolateStoredValues } from '../../support/kv-store.js'
import { createMessageHandler } from '../../../discord/gateway/messages.js'
import { createRepeatedMessageHandler } from '../../../features/messages/repeated.js'
import { clearRuntimeIssuesForTests, runtimeIssueSummary } from '../../../shared/runtime/health.js'

const ROLE = '333333333333333333'
const OTHER_ROLE = '444444444444444444'
const LOG_CHANNEL = '999999999999999999'
let sequence = 0
const add = vi.fn(async () => undefined)
const has = vi.fn(() => false)
const fetch = vi.fn(async () => ({ roles: { add, cache: { has } } }))
const sendLog = vi.fn(async (_payload: unknown) => undefined)
const channelFetch = vi.fn(
  async (_id: string): Promise<unknown> => ({
    guildId: '111111111111111111',
    isSendable: () => true,
    send: sendLog
  })
)
function message(overrides: object = {}): Message {
  return {
    id: String(++sequence),
    guildId: '111111111111111111',
    channelId: '222222222222222222',
    author: { id: '555555555555555555', bot: false },
    guild: { members: { fetch }, channels: { fetch: channelFetch } },
    member: { roles: { add, cache: { has } } },
    content: 'same text',
    type: MessageType.Default,
    ...overrides
  } as unknown as Message
}
function configure(roleId = ROLE, windowSeconds = 300) {
  manageCommunitySettings({
    action: 'update',
    settings: { repeatedMessages: { roleId, windowSeconds } }
  })
}
async function send(
  handler: ReturnType<typeof createRepeatedMessageHandler>,
  count = 5,
  overrides = {}
) {
  for (let i = 0; i < count; i++) await handler(message(overrides))
}

beforeEach(() => {
  isolateStoredValues(join(process.cwd(), '.tmp', 'repeated-messages.test.sqlite'))
  clearStoredValues()
  clearRuntimeIssuesForTests()
  vi.clearAllMocks()
  has.mockReturnValue(false)
  add.mockImplementation(async () => {
    has.mockReturnValue(true)
  })
  fetch.mockResolvedValue({ roles: { add, cache: { has } } })
  channelFetch.mockResolvedValue({
    guildId: '111111111111111111',
    isSendable: () => true,
    send: sendLog
  })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
})
afterEach(() => vi.useRealTimers())

describe('repeated message roles', () => {
  it('is disabled by default and /a configuration persists without resetting unrelated fields', async () => {
    const handler = createRepeatedMessageHandler()
    expect(loadCommunitySettings().repeatedMessages).toBeNull()
    await send(handler)
    expect(add).not.toHaveBeenCalled()
    manageCommunitySettings({ action: 'update', settings: { repeatedMessages: { roleId: ROLE } } })
    manageCommunitySettings({ action: 'update', settings: { anonymousName: 'keep' } })
    expect(loadCommunitySettings().repeatedMessages).toEqual({ roleId: ROLE, windowSeconds: 300 })
    await send(handler)
    expect(add).toHaveBeenCalledOnce()
  })

  it.each([
    { roleId: 'bad' },
    { roleId: ROLE, windowSeconds: 0 },
    { roleId: ROLE, windowSeconds: 3601 }
  ])('rejects invalid settings %j', (repeatedMessages) => {
    expect(() =>
      manageCommunitySettings({ action: 'update', settings: { repeatedMessages } })
    ).toThrow()
  })

  it('assigns on the fifth exact repeat even with intervening text, and not again', async () => {
    configure()
    const handler = createRepeatedMessageHandler()
    await send(handler, 4)
    await handler(message({ content: 'different' }))
    expect(add).not.toHaveBeenCalled()
    await handler(message())
    expect(add).toHaveBeenCalledWith(ROLE, expect.any(String))
    await send(handler, 10)
    expect(add).toHaveBeenCalledOnce()
  })

  it.each([
    { guildId: null },
    { author: { id: '555555555555555555', bot: true } },
    { webhookId: 'webhook' },
    { type: MessageType.ChannelPinnedMessage },
    { content: '' },
    { content: '  ' }
  ])('ignores ineligible messages %j', async (overrides) => {
    configure()
    await send(createRepeatedMessageHandler(), 5, overrides)
    expect(add).not.toHaveBeenCalled()
  })

  it('isolates guilds, channels, authors and exact content', async () => {
    configure()
    const handler = createRepeatedMessageHandler()
    await send(handler, 4)
    await handler(message({ guildId: '666666666666666666' }))
    await handler(message({ channelId: '777777777777777777' }))
    await handler(message({ author: { id: '888888888888888888', bot: false } }))
    await handler(message({ content: 'same text ' }))
    expect(add).not.toHaveBeenCalled()
  })

  it('expires counts using the configured rolling window', async () => {
    configure(ROLE, 10)
    const handler = createRepeatedMessageHandler()
    await send(handler, 4)
    vi.advanceTimersByTime(10_000)
    await handler(message())
    expect(add).not.toHaveBeenCalled()
    await send(handler, 4)
    expect(add).toHaveBeenCalledOnce()
  })

  it('does not count duplicate deliveries', async () => {
    configure()
    const handler = createRepeatedMessageHandler()
    const source = message()
    for (let i = 0; i < 6; i++) await handler(source)
    expect(add).not.toHaveBeenCalled()
    await send(handler, 4)
    expect(add).toHaveBeenCalledOnce()
  })

  it('coalesces concurrent role assignments and fetches missing members', async () => {
    configure()
    const handler = createRepeatedMessageHandler()
    await Promise.all(Array.from({ length: 8 }, () => handler(message({ member: null }))))
    expect(fetch).toHaveBeenCalledOnce()
    expect(add).toHaveBeenCalledOnce()
  })

  it('skips members who already have the role', async () => {
    configure()
    has.mockReturnValue(true)
    await send(createRepeatedMessageHandler())
    expect(add).not.toHaveBeenCalled()
  })

  it('clears counts on disable and role changes', async () => {
    configure()
    const handler = createRepeatedMessageHandler()
    await send(handler, 4)
    manageCommunitySettings({ action: 'update', settings: { repeatedMessages: null } })
    await send(handler)
    configure(OTHER_ROLE)
    await handler(message())
    expect(add).not.toHaveBeenCalled()
    await send(handler, 4)
    expect(add).toHaveBeenCalledWith(OTHER_ROLE, expect.any(String))
  })

  it('reports safe failures, throttles retries, and recovers on a later repeat', async () => {
    configure()
    add.mockRejectedValueOnce(new Error('secret text'))
    const handler = createRepeatedMessageHandler()
    await send(handler)
    expect(runtimeIssueSummary()).toContain('repeated_messages')
    expect(runtimeIssueSummary()).not.toContain('secret text')
    await send(handler)
    expect(add).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(60_000)
    await handler(message())
    expect(add).toHaveBeenCalledTimes(2)
    expect(runtimeIssueSummary()).not.toContain('repeated_messages')
  })

  it('checks commands before existing early-return routing without invoking role chat', async () => {
    configure()
    const commands = vi.fn(async () => true)
    const chat = vi.fn(async () => undefined)
    const skip = vi.fn(async () => false)
    const handler = createMessageHandler(commands, chat, skip, skip)
    for (let i = 0; i < 5; i++) await handler(message({ content: '!!ping' }))
    expect(add).toHaveBeenCalledOnce()
    expect(commands).toHaveBeenCalledTimes(5)
    expect(chat).not.toHaveBeenCalled()
  })

  it('defaults logging off and persists /a channel updates independently of repeat settings', () => {
    expect(loadCommunitySettings().automodChannelId).toBeNull()
    configure()
    manageCommunitySettings({ action: 'update', settings: { automodChannelId: LOG_CHANNEL } })
    manageCommunitySettings({ action: 'update', settings: { anonymousName: 'preserved' } })
    expect(loadCommunitySettings()).toMatchObject({
      automodChannelId: LOG_CHANNEL,
      repeatedMessages: { roleId: ROLE, windowSeconds: 300 }
    })
    expect(() =>
      manageCommunitySettings({ action: 'update', settings: { automodChannelId: 'bad' } })
    ).toThrow()
    manageCommunitySettings({ action: 'reset' })
    expect(loadCommunitySettings().automodChannelId).toBeNull()
  })

  it('sends the user, repeated content, role and source link only after successful assignment', async () => {
    configure()
    manageCommunitySettings({ action: 'update', settings: { automodChannelId: LOG_CHANNEL } })
    const handler = createRepeatedMessageHandler()
    await send(handler, 4, { content: 'repeated @everyone <@555555555555555555>' })
    expect(sendLog).not.toHaveBeenCalled()
    const source = message({ content: 'repeated @everyone <@555555555555555555>' })
    await handler(source)
    expect(channelFetch).toHaveBeenCalledWith(LOG_CHANNEL, { force: true })
    expect(add.mock.invocationCallOrder[0]).toBeLessThan(sendLog.mock.invocationCallOrder[0]!)
    const payload = sendLog.mock.calls[0]![0] as {
      content: string
      allowedMentions: unknown
    }
    expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false })
    const rendered = payload.content
    expect(rendered).toContain(source.content)
    expect(rendered).toContain(source.author.id)
    expect(rendered).toContain(ROLE)
    expect(rendered).toContain(
      `https://discord.com/channels/${source.guildId}/${source.channelId}/${source.id}`
    )
    await send(handler, 5, { content: source.content })
    expect(sendLog).toHaveBeenCalledOnce()
  })

  it('does not reset accumulated counts when configuring the automod channel', async () => {
    configure()
    const handler = createRepeatedMessageHandler()
    await send(handler, 4)
    manageCommunitySettings({ action: 'update', settings: { automodChannelId: LOG_CHANNEL } })
    await handler(message())
    expect(sendLog).toHaveBeenCalledOnce()
  })

  it('does not log existing roles or failed assignments', async () => {
    configure()
    manageCommunitySettings({ action: 'update', settings: { automodChannelId: LOG_CHANNEL } })
    has.mockReturnValue(true)
    await send(createRepeatedMessageHandler())
    has.mockReturnValue(false)
    add.mockRejectedValueOnce(new Error('role failed'))
    await send(createRepeatedMessageHandler())
    expect(channelFetch).not.toHaveBeenCalled()
    expect(sendLog).not.toHaveBeenCalled()
  })

  it('does not send logs when the channel is unset or disabled', async () => {
    configure()
    await send(createRepeatedMessageHandler())
    manageCommunitySettings({ action: 'update', settings: { automodChannelId: LOG_CHANNEL } })
    manageCommunitySettings({ action: 'update', settings: { automodChannelId: null } })
    has.mockReturnValue(false)
    await send(createRepeatedMessageHandler())
    expect(add).toHaveBeenCalledTimes(2)
    expect(channelFetch).not.toHaveBeenCalled()
  })

  it.each([
    null,
    { guildId: 'other-guild', isSendable: () => true, send: sendLog },
    { guildId: '111111111111111111', isSendable: () => false, send: sendLog }
  ])('rejects unavailable, cross-guild or unsendable log destinations', async (channel) => {
    configure()
    manageCommunitySettings({ action: 'update', settings: { automodChannelId: LOG_CHANNEL } })
    channelFetch.mockResolvedValueOnce(channel)
    await send(createRepeatedMessageHandler())
    expect(add).toHaveBeenCalledOnce()
    expect(sendLog).not.toHaveBeenCalled()
    expect(runtimeIssueSummary()).toContain('repeated_messages_log')
  })

  it('does not send to a destination disabled while it was being fetched', async () => {
    configure()
    manageCommunitySettings({ action: 'update', settings: { automodChannelId: LOG_CHANNEL } })
    channelFetch.mockImplementationOnce(async () => {
      manageCommunitySettings({ action: 'update', settings: { automodChannelId: null } })
      return { guildId: '111111111111111111', isSendable: () => true, send: sendLog }
    })
    await send(createRepeatedMessageHandler())
    expect(add).toHaveBeenCalledOnce()
    expect(sendLog).not.toHaveBeenCalled()
  })

  it('reports log failures separately without retrying an already successful assignment', async () => {
    configure()
    manageCommunitySettings({ action: 'update', settings: { automodChannelId: LOG_CHANNEL } })
    sendLog.mockRejectedValueOnce(new Error('sensitive text'))
    const handler = createRepeatedMessageHandler()
    await send(handler)
    await send(handler, 10)
    expect(add).toHaveBeenCalledOnce()
    expect(sendLog).toHaveBeenCalledOnce()
    expect(runtimeIssueSummary()).toContain('repeated_messages_log')
    expect(runtimeIssueSummary()).not.toContain('sensitive text')
    has.mockReturnValue(false)
    await send(handler, 5, { content: 'another repeated message' })
    expect(runtimeIssueSummary()).not.toContain('repeated_messages_log')
  })

  it('uses bounded plain-text logs without needing Embed Links permission', async () => {
    configure()
    manageCommunitySettings({ action: 'update', settings: { automodChannelId: LOG_CHANNEL } })
    await send(createRepeatedMessageHandler(), 5, { content: 'x'.repeat(4000) })
    const payload = sendLog.mock.calls[0]![0] as { content: string }
    expect(payload).not.toHaveProperty('embeds')
    expect(payload.content.length).toBeLessThanOrEqual(2000)
    expect(payload.content).toContain('x'.repeat(1499))
    expect(payload.content).toMatch(/…$/)
  })

  it('uses fresh membership even when the gateway member incorrectly has the role cached', async () => {
    configure()
    const stale = { roles: { add, cache: { has: () => true } } }
    await send(createRepeatedMessageHandler(), 5, { member: stale })
    expect(fetch).toHaveBeenCalledWith({ user: '555555555555555555', force: true })
    expect(add).toHaveBeenCalledOnce()
  })

  it('reassigns a manually removed role after five new repeats, even for the same text', async () => {
    configure()
    manageCommunitySettings({ action: 'update', settings: { automodChannelId: LOG_CHANNEL } })
    const handler = createRepeatedMessageHandler()
    await send(handler)
    expect(add).toHaveBeenCalledOnce()
    has.mockReturnValue(false)
    await send(handler, 4)
    expect(add).toHaveBeenCalledOnce()
    await handler(message())
    expect(add).toHaveBeenCalledTimes(2)
    expect(sendLog).toHaveBeenCalledTimes(2)
  })

  it('rechecks roles after five new messages without duplicate role additions or logs', async () => {
    configure()
    manageCommunitySettings({ action: 'update', settings: { automodChannelId: LOG_CHANNEL } })
    const handler = createRepeatedMessageHandler()
    await send(handler)
    await send(handler, 10)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(add).toHaveBeenCalledOnce()
    expect(sendLog).toHaveBeenCalledOnce()
  })

  it('does not log a role assignment if settings change during the fresh member fetch', async () => {
    configure()
    fetch.mockImplementationOnce(async () => {
      configure(OTHER_ROLE)
      return { roles: { add, cache: { has } } }
    })
    await send(createRepeatedMessageHandler())
    expect(add).not.toHaveBeenCalled()
    expect(sendLog).not.toHaveBeenCalled()
  })

  it('reports the Discord code and failed operation without leaking service errors', async () => {
    configure()
    add.mockRejectedValueOnce(Object.assign(new Error('secret body'), { code: 50013, status: 403 }))
    await send(createRepeatedMessageHandler())
    expect(runtimeIssueSummary()).toContain('stage=role_add; discord_code=50013; http_status=403')
    expect(runtimeIssueSummary()).not.toContain('secret body')
  })

  it('distinguishes log-send errors from role assignment errors', async () => {
    configure()
    manageCommunitySettings({ action: 'update', settings: { automodChannelId: LOG_CHANNEL } })
    sendLog.mockRejectedValueOnce(
      Object.assign(new Error('secret token'), { code: 50001, status: 403 })
    )
    await send(createRepeatedMessageHandler())
    expect(runtimeIssueSummary()).toContain('stage=log_send; discord_code=50001; http_status=403')
    expect(runtimeIssueSummary()).not.toContain('secret token')
    expect(add).toHaveBeenCalledOnce()
  })
})
