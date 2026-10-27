import { join } from 'node:path'
import { ChannelType, MessageFlags, PermissionsBitField, type Client, type Guild } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { manageCommunitySettings } from '../community-settings.js'
import { clearStoredValues, listStoredKeys } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import {
  commandJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands,
  type DispatchOptions
} from './e2e.js'

const GUILD = '333333333333333333'
const CHANNEL = '777777777777777777'
const OWNER = '555555555555555555'
const TARGET = '444444444444444444'
const PUBLIC_MESSAGE = '1000000000000000001'
const publicRoute = `/channels/${CHANNEL}/messages`
const subs = makeSubcommands()

function configureClient(client: Client) {
  const guild = (client.guilds as unknown as { _add(data: unknown): Guild })._add({
    id: GUILD,
    name: 'test',
    owner_id: '111111111111111111'
  })
  ;(client.channels as unknown as { _add(data: unknown, guild: Guild): unknown })._add(
    {
      id: CHANNEL,
      guild_id: GUILD,
      name: 'kickvotes',
      type: ChannelType.GuildText,
      permission_overwrites: []
    },
    guild
  )
  vi.spyOn(guild.members, 'fetch').mockResolvedValue({
    id: TARGET,
    user: { id: TARGET, bot: false },
    kickable: true,
    permissions: new PermissionsBitField()
  } as never)
}

function launch(options: DispatchOptions = {}) {
  const user = { id: OWNER, username: 'secret-vote-opener', discriminator: '0', avatar: null }
  return dispatch(
    commandJSON('', {
      guild_id: GUILD,
      channel: { id: CHANNEL },
      user,
      member: { user, permissions: '0', roles: [] },
      data: {
        id: '888888888888888888',
        type: 1,
        name: 'kickvote',
        options: [
          { name: 'user', type: 6, value: TARGET },
          { name: 'reason', type: 3, value: '반복적인 스팸' }
        ],
        resolved: {
          users: { [TARGET]: { id: TARGET, username: 'target', discriminator: '0', avatar: null } }
        }
      }
    }),
    subs,
    {
      configureClient,
      postResult: (route) =>
        route === publicRoute
          ? {
              id: PUBLIC_MESSAGE,
              type: 0,
              channel_id: CHANNEL,
              guild_id: GUILD,
              content: '',
              embeds: [],
              components: [],
              attachments: [],
              flags: MessageFlags.IsComponentsV2,
              author: {
                id: '999999999999999999',
                username: 'solver',
                discriminator: '0',
                avatar: null,
                bot: true
              }
            }
          : {},
      ...options
    }
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  isolateStoredValues(join(process.cwd(), '.tmp', 'kickvote.test.sqlite'))
  clearStoredValues()
  manageCommunitySettings({
    action: 'update',
    guildId: GUILD,
    settings: { kickvoteChannelId: CHANNEL }
  })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('anonymous kickvote publication (mntserver behavior)', () => {
  it('acknowledges privately and creates a separate anonymous channel message, not an interaction follow-up', async () => {
    const calls = await launch()
    expect(getCallback(calls)).toMatchObject({ type: 5, data: { flags: MessageFlags.Ephemeral } })
    const messages = calls.filter((call) => call.method === 'POST' && call.route === publicRoute)
    expect(messages).toHaveLength(1)
    const published = messages[0]!.body
    expect(published).toMatchObject({
      flags: MessageFlags.IsComponentsV2,
      allowed_mentions: { parse: [] }
    })
    const serialized = JSON.stringify(published)
    expect(serialized).toContain('누군가가 추방 투표를 시작했습니다!')
    expect(serialized).toContain(TARGET)
    expect(serialized).toContain('반복적인 스팸')
    expect(serialized).not.toContain(OWNER)
    expect(serialized).not.toContain('secret-vote-opener')
    expect(published).not.toHaveProperty('interaction_metadata')
    expect(published).not.toHaveProperty('interaction')
    expect(serialized).not.toContain('message_reference')
    expect(
      calls.filter((call) => call.method === 'POST' && call.route.startsWith('/webhooks/'))
    ).toEqual([])
    const privateEdit = getEdit(calls)
    expect(JSON.stringify(privateEdit)).toContain('추방 투표를 시작했어요!')
    expect(JSON.stringify(privateEdit)).not.toContain('community-kickvote:')
    await vi.advanceTimersByTimeAsync(60000)
    expect(
      calls.some((call) => call.method === 'DELETE' && call.route.startsWith('/channels/'))
    ).toBe(false)
  })

  it('does not publish when called outside the configured channel', async () => {
    manageCommunitySettings({
      action: 'update',
      guildId: GUILD,
      settings: { kickvoteChannelId: TARGET }
    })
    const calls = await launch()
    expect(getCallback(calls)).toMatchObject({ data: { flags: expect.any(Number) } })
    const callback = getCallback(calls) as { data: { flags: number } }
    expect(callback.data.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(calls.some((call) => call.route === publicRoute)).toBe(false)
  })

  it('removes state after a failed channel send so the user can retry privately', async () => {
    const calls = await launch({
      postError: (route) => (route === publicRoute ? new Error('send failed') : undefined)
    })
    expect(getCallback(calls)).toMatchObject({ type: 5, data: { flags: MessageFlags.Ephemeral } })
    expect(listStoredKeys().filter((key) => key.startsWith('community:transient:vote'))).toEqual([])
    const retry = await launch()
    expect(
      retry.filter((call) => call.method === 'POST' && call.route === publicRoute)
    ).toHaveLength(1)
  })

  it('does not discard a published poll when its private confirmation fails', async () => {
    let failed = false
    const calls = await launch({
      patchError: () => {
        if (failed) return undefined
        failed = true
        return new Error('private confirmation failed')
      }
    })
    expect(
      calls.filter((call) => call.method === 'POST' && call.route === publicRoute)
    ).toHaveLength(1)
    expect(
      listStoredKeys().filter((key) => key.startsWith('community:transient:vote:'))
    ).toHaveLength(1)
    const duplicate = await launch()
    expect(duplicate.some((call) => call.route === publicRoute)).toBe(false)
    expect(JSON.stringify(getEdit(duplicate))).toContain('이미 진행 중')
  })
})
