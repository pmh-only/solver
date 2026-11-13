import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import {
  Collection,
  Events,
  MessageFlags,
  MessageType,
  PermissionFlagsBits,
  type Client,
  type Message
} from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { communityApplicationCommands } from '../../../features/community/application-commands.js'
import {
  COMMUNITY_SETTINGS_KEY,
  loadCommunitySettings,
  manageCommunitySettings
} from '../../../features/community/settings.js'
import {
  DeletedMessageHistory,
  deletedMessageHistory,
  registerDeletedMessageTracking
} from '../../../features/messages/deleted.js'
import { clearStoredValues, setStoredValue } from '../../../shared/storage/kv-store.js'
import { isolateStoredValues } from '../../support/kv-store.js'
import { commandJSON, dispatch, getCallback, makeSubcommands } from '../../support/e2e.js'

const GUILD = '333333333333333333'
const CHANNEL = '777777777777777777'
const USER = '555555555555555555'
const permissions = String(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory)
let sequence = 0
function message(overrides: object = {}): Message {
  return {
    id: String(++sequence),
    guildId: GUILD,
    channelId: CHANNEL,
    author: { id: USER, bot: false },
    partial: false,
    content: 'deleted human text',
    type: MessageType.Default,
    attachments: new Collection(),
    ...overrides
  } as unknown as Message
}
function slash(overrides: object = {}) {
  const user = { id: USER, username: 'ordinary-user', discriminator: '0', avatar: null }
  return commandJSON('', {
    guild_id: GUILD,
    channel_id: CHANNEL,
    channel: { id: CHANNEL },
    app_permissions: permissions,
    member: { user, roles: [], permissions, joined_at: '2020-01-01T00:00:00Z' },
    user,
    data: { id: '888888888888888888', type: 1, name: 'deleted', options: [] },
    ...overrides
  })
}
async function run(overrides = {}) {
  const calls = await dispatch(slash(overrides), makeSubcommands())
  return getCallback(calls) as { type: number; data: { flags: number; components: unknown[] } }
}

beforeEach(() => {
  isolateStoredValues(join(process.cwd(), '.tmp', 'deleted-messages.test.sqlite'))
  clearStoredValues()
  deletedMessageHistory.clear()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
})
afterEach(() => {
  deletedMessageHistory.clear()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('recent deleted-message capture', () => {
  it('registers single and bulk deletion gateway handlers without fetching deleted data', () => {
    const client = new EventEmitter()
    registerDeletedMessageTracking(client as unknown as Client)
    const first = message()
    client.emit(Events.MessageDelete, first)
    client.emit(
      Events.MessageBulkDelete,
      new Collection([
        ['second', message({ content: 'bulk second' })],
        ['third', message({ content: 'bulk third' })]
      ])
    )
    const records = deletedMessageHistory.recent(GUILD, CHANNEL)
    expect(records.map((record) => record.content)).toEqual([
      'bulk third',
      'bulk second',
      first.content
    ])
    client.emit(Events.MessageDelete, first)
    expect(deletedMessageHistory.recent(GUILD, CHANNEL)).toHaveLength(3)
  })

  it.each([
    { partial: true, author: null, content: null },
    { guildId: null },
    { author: { id: USER, bot: true } },
    { webhookId: 'webhook' },
    { type: MessageType.ChannelPinnedMessage },
    { content: ' ' }
  ])('ignores unknown, private or ineligible messages %j', (overrides) => {
    const history = new DeletedMessageHistory()
    const fetch = vi.fn()
    history.capture(message({ ...overrides, fetch }))
    expect(history.recent(GUILD, CHANNEL)).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps only the latest five messages per channel and isolates guilds/channels', () => {
    const history = new DeletedMessageHistory()
    for (let i = 0; i < 8; i++) history.capture(message({ content: `content-${i}` }))
    history.capture(message({ guildId: '444444444444444444', content: 'other guild secret' }))
    history.capture(message({ channelId: '888888888888888888', content: 'other channel secret' }))
    expect(history.recent(GUILD, CHANNEL).map((record) => record.content)).toEqual([
      'content-7',
      'content-6',
      'content-5',
      'content-4',
      'content-3'
    ])
  })

  it('bounds the total number of retained channels', () => {
    const history = new DeletedMessageHistory()
    for (let i = 0; i < 201; i++) history.capture(message({ channelId: String(i) }))
    expect(history.recent(GUILD, '0')).toEqual([])
    expect(history.recent(GUILD, '200')).toHaveLength(1)
  })

  it('bounds attachment filenames and text without storing URLs or downloads', () => {
    const history = new DeletedMessageHistory()
    const attachments = new Collection(
      Array.from({ length: 10 }, (_, i) => [
        String(i),
        {
          name: 'f'.repeat(200),
          url: 'https://private.example/secret',
          size: 100
        }
      ])
    )
    history.capture(message({ content: 'x'.repeat(4000), attachments }))
    const record = history.recent(GUILD, CHANNEL)[0]!
    expect(record.content).toHaveLength(1000)
    expect(record.attachments).toHaveLength(3)
    expect(record.attachments[0]).toHaveLength(100)
    expect(JSON.stringify(record)).not.toContain('private.example')
    history.capture(message({ content: '', attachments }))
    expect(history.recent(GUILD, CHANNEL)).toHaveLength(2)
  })

  it('expires entries at the configured retention boundary and does not persist across instances', () => {
    manageCommunitySettings({
      action: 'update',
      settings: { deletedMessages: { retentionMinutes: 1 } }
    })
    const history = new DeletedMessageHistory()
    history.capture(message())
    expect(new DeletedMessageHistory().recent(GUILD, CHANNEL)).toEqual([])
    vi.advanceTimersByTime(59_999)
    expect(history.recent(GUILD, CHANNEL)).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(history.recent(GUILD, CHANNEL)).toEqual([])
  })

  it.each([{ deletedMessages: { enabled: false } }, { disabledCommands: ['deleted'] }])(
    'disables both capture and viewing and clears observed records (%j)',
    (settings) => {
      const history = new DeletedMessageHistory()
      history.capture(message())
      manageCommunitySettings({ action: 'update', settings })
      history.capture(message())
      expect(history.recent(GUILD, CHANNEL)).toEqual([])
      manageCommunitySettings({ action: 'reset' })
      expect(history.recent(GUILD, CHANNEL)).toEqual([])
    }
  )

  it('fails closed on corrupt settings rather than retaining newly deleted data', () => {
    const history = new DeletedMessageHistory()
    history.capture(message())
    setStoredValue(COMMUNITY_SETTINGS_KEY, '{broken')
    history.capture(message())
    manageCommunitySettings({ action: 'reset' })
    expect(history.recent(GUILD, CHANNEL)).toEqual([])
  })
})

describe('guild /deleted routing', () => {
  it('registers a guild-only command with no options or member-permission restriction', () => {
    expect(
      communityApplicationCommands.find((command) => command.name === 'deleted')
    ).toMatchObject({
      contexts: [0],
      integration_types: [0],
      default_member_permissions: null,
      options: []
    })
  })

  it('allows ordinary members to publicly show only their channel without publishing controls', async () => {
    deletedMessageHistory.capture(message())
    deletedMessageHistory.capture(
      message({ channelId: '888888888888888888', content: 'other channel secret' })
    )
    deletedMessageHistory.capture(
      message({ guildId: '444444444444444444', content: 'other guild secret' })
    )
    const callback = await run()
    expect(callback.data.flags & MessageFlags.Ephemeral).toBeFalsy()
    expect(callback.data.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    const rendered = JSON.stringify(callback.data.components)
    expect(rendered).toContain('deleted human text')
    expect(rendered).toContain(USER)
    expect(rendered).toContain('삭제')
    expect(rendered).not.toContain('other channel secret')
    expect(rendered).not.toContain('other guild secret')
    expect(rendered).not.toContain('custom_id')
  })

  it('shows a truthful empty state when no cached deletion is available', async () => {
    const callback = await run()
    expect(callback.data.flags & MessageFlags.Ephemeral).toBeFalsy()
    const rendered = JSON.stringify(callback.data.components)
    expect(rendered).toContain('최근 삭제된 메시지가 없습니다')
    expect(rendered).toContain('재시작하면')
  })

  it('rejects DMs', async () => {
    deletedMessageHistory.capture(message())
    const rendered = JSON.stringify(await run({ guild_id: undefined, member: undefined }))
    expect(rendered).toContain('서버에서만')
    expect(rendered).not.toContain('deleted human text')
  })

  it.each([
    { app_permissions: '0' },
    {
      member: {
        user: { id: USER, username: 'user', discriminator: '0' },
        roles: [],
        permissions: '0'
      }
    }
  ])('requires current channel/history permissions for user and bot (%j)', async (overrides) => {
    deletedMessageHistory.capture(message())
    const callback = await run(overrides)
    expect(callback.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    const rendered = JSON.stringify(callback)
    expect(rendered).toContain('권한이 필요')
    expect(rendered).not.toContain('deleted human text')
  })

  it('respects the /a disable switch and includes the command in /help', async () => {
    deletedMessageHistory.capture(message())
    manageCommunitySettings({ action: 'update', settings: { deletedMessages: { enabled: false } } })
    expect(JSON.stringify(await run())).toContain('비활성화된 기능')
    const raw = slash()
    raw.data = {
      id: '888888888888888888',
      type: 1,
      name: 'help',
      options: [{ type: 3, name: 'command', value: 'deleted' }]
    }
    const help = await dispatch(raw, makeSubcommands())
    expect(JSON.stringify(help)).toContain('/deleted')
  })

  it('bounds and escapes worst-case text without exceeding Discord component limits', async () => {
    for (let i = 0; i < 5; i++)
      deletedMessageHistory.capture(
        message({
          content: '*'.repeat(4000),
          attachments: new Collection([['file', { name: '`'.repeat(1000) }]])
        })
      )
    const components = (await run()).data.components
    const strings: string[] = []
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(collect)
        return
      }
      if (!value || typeof value !== 'object') return
      if ('content' in value && typeof value.content === 'string') strings.push(value.content)
      Object.values(value).forEach(collect)
    }
    collect(components)
    expect(strings.join('').length).toBeLessThan(4000)
    expect(strings.some((value) => value.includes('\\*'))).toBe(true)
  })

  it('defaults and validates /a retention configuration without overwriting unrelated settings', () => {
    expect(loadCommunitySettings().deletedMessages).toEqual({ enabled: true, retentionMinutes: 60 })
    manageCommunitySettings({
      action: 'update',
      settings: { deletedMessages: { retentionMinutes: 10 } }
    })
    manageCommunitySettings({ action: 'update', settings: { anonymousName: 'keep' } })
    expect(loadCommunitySettings().deletedMessages).toEqual({ enabled: true, retentionMinutes: 10 })
    expect(() =>
      manageCommunitySettings({
        action: 'update',
        settings: { deletedMessages: { retentionMinutes: 0 } }
      })
    ).toThrow()
    expect(() =>
      manageCommunitySettings({
        action: 'update',
        settings: { deletedMessages: { retentionMinutes: 1441 } }
      })
    ).toThrow()
  })
})
