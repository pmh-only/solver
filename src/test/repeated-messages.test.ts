import { join } from 'node:path'
import { MessageType, type Message } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCommunitySettings, manageCommunitySettings } from '../community-settings.js'
import { clearStoredValues } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import { createMessageHandler } from '../message-handler.js'
import { createRepeatedMessageHandler } from '../repeated-messages.js'
import { clearRuntimeIssuesForTests, runtimeIssueSummary } from '../runtime-health.js'

const ROLE = '333333333333333333'
const OTHER_ROLE = '444444444444444444'
let sequence = 0
const add = vi.fn(async () => undefined)
const has = vi.fn(() => false)
const fetch = vi.fn(async () => ({ roles: { add, cache: { has } } }))
function message(overrides: object = {}): Message {
  return {
    id: String(++sequence),
    guildId: '111111111111111111',
    channelId: '222222222222222222',
    author: { id: '555555555555555555', bot: false },
    guild: { members: { fetch } },
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
})
