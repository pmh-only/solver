import { join } from 'node:path'
import { ChannelType, MessageFlags, PermissionsBitField, type Client, type Guild } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { manageCommunitySettings } from '../community-settings.js'
import { clearStoredValues, listStoredKeys } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import { clearRuntimeIssuesForTests, runtimeIssueSummary } from '../runtime-health.js'
import { KICKVOTE_BUTTON_ID } from '../commands/kickvote.js'
import {
  buttonJSON,
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
const VOTER = '666666666666666666'
const kick = vi.fn()
let voterBot = false

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
  vi.spyOn(guild.members, 'fetch').mockImplementation((async (id: string) => ({
    id,
    user: { id, bot: id !== TARGET && voterBot },
    kickable: true,
    permissions: new PermissionsBitField(),
    kick
  })) as never)
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
  clearRuntimeIssuesForTests()
  voterBot = false
  kick.mockReset().mockResolvedValue(undefined)
  manageCommunitySettings({
    action: 'update',
    guildId: GUILD,
    settings: { kickvoteChannelId: CHANNEL }
  })
})

async function startVote() {
  const calls = await launch()
  const published = calls.find((call) => call.method === 'POST' && call.route === publicRoute)!
  return (published.body as { components: unknown[] }).components
}
function vote(
  components: unknown[],
  userId = VOTER,
  extra: DispatchOptions = {},
  customId = KICKVOTE_BUTTON_ID
) {
  const user = { id: userId, username: 'voter', discriminator: '0', avatar: null }
  const raw = buttonJSON(
    components,
    customId,
    {
      guild_id: GUILD,
      channel: { id: CHANNEL },
      user,
      member: { user, permissions: '0', roles: [] }
    },
    MessageFlags.IsComponentsV2
  )
  raw.message = { ...(raw.message as Record<string, unknown>), id: PUBLIC_MESSAGE, guild_id: GUILD }
  return dispatch(raw, subs, {
    configureClient,
    postResult: (route) =>
      route === publicRoute
        ? {
            id: '1000000000000000002',
            type: 0,
            channel_id: CHANNEL,
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
    ...extra
  })
}
function notices(calls: Awaited<ReturnType<typeof dispatch>>) {
  return calls.filter((call) => call.method === 'POST' && call.route === publicRoute)
}

describe('public kickvote agreement replies', () => {
  it('separates the reason from the heading and uses an emoji-only cancellation button', async () => {
    const components = await startVote()
    const body = (components[0] as { components: Array<{ type: number; content?: string }> })
      .components
    expect(body[0]!.content).toContain('추방 투표')
    expect(body[0]!.content).not.toContain('반복적인 스팸')
    expect(body).toContainEqual(expect.objectContaining({ content: '## 추방 사유\n반복적인 스팸' }))
    expect(body.filter((component) => component.type === 14)).toHaveLength(2)
    const row = components[1] as {
      components: Array<{ custom_id: string; emoji?: { name: string }; label?: string }>
    }
    const cancel = row.components.find((component) => component.custom_id.endsWith(':cancel'))!
    expect(cancel.emoji).toEqual({ id: undefined, name: '🗑️', animated: false })
    expect(cancel).not.toHaveProperty('label')
    expect(JSON.stringify(components)).not.toContain('개설자/관리자')
  })
  it('identifies each accepted voter in a reply to the original poll without pinging anyone', async () => {
    const components = await startVote()
    expect(JSON.stringify(components)).toContain('투표 마감: <t:')
    expect(JSON.stringify(components)).not.toContain('공개 찬성')
    expect(JSON.stringify(components)).not.toContain('무기명 찬성')
    expect(JSON.stringify(components)).not.toContain('취소 불가')
    expect(JSON.stringify(components)).not.toContain('ban이 아닌 kick')
    expect(JSON.stringify(components)).not.toContain('마지막 투표 후')
    const calls = await vote(components)
    expect(getCallback(calls)).toMatchObject({ type: 6 })
    expect(JSON.stringify(getEdit(calls))).toContain('1/7')
    expect(notices(calls)).toHaveLength(1)
    const payload = notices(calls)[0]!.body
    expect(payload).toMatchObject({
      flags: MessageFlags.IsComponentsV2,
      message_reference: { message_id: PUBLIC_MESSAGE },
      allowed_mentions: { parse: [], replied_user: false }
    })
    expect(JSON.stringify(payload)).toContain(`<@${VOTER}>님이 추방에 찬성했습니다.`)
    expect(JSON.stringify(payload)).toContain('1/7표')
    expect(notices(await vote(components))).toHaveLength(0)
  })
  it('shows only the deadline label and keeps it in sync with accepted votes', async () => {
    const components = await startVote()
    const deadline = Math.floor((Date.now() + 30 * 60_000) / 1000)
    expect(JSON.stringify(components)).toContain(`투표 마감: <t:${deadline}:R>`)
    await vi.advanceTimersByTimeAsync(60_000)
    const calls = await vote(components)
    const updated = JSON.stringify(getEdit(calls))
    expect(updated).toContain(`투표 마감: <t:${deadline + 60}:R>`)
    expect(updated).toContain('1/7표')
    expect(updated).not.toContain('마지막 투표 후')
    expect(updated).not.toContain('취소 불가')
    expect(updated).not.toContain('ban이 아닌 kick')
  })
  it('announces the quorum vote and kicks once, without duplicate final announcements', async () => {
    manageCommunitySettings({ action: 'update', settings: { kickvoteThreshold: 2 } })
    const components = await startVote()
    await vote(components)
    const final = await vote(components, OWNER)
    expect(notices(final)).toHaveLength(1)
    expect(JSON.stringify(notices(final)[0]!.body)).toContain(
      `<@${OWNER}>님이 추방에 찬성했습니다. (2/2표)`
    )
    expect(kick).toHaveBeenCalledTimes(1)
    expect(notices(await vote(components, OWNER))).toHaveLength(0)
    expect(kick).toHaveBeenCalledTimes(1)
  })
  it('announces only once for overlapping duplicate clicks', async () => {
    const components = await startVote()
    const calls = await Promise.all([vote(components), vote(components)])
    expect(calls.flatMap(notices)).toHaveLength(1)
  })
  it('announces an accepted vote even if updating the poll display fails', async () => {
    const components = await startVote()
    const calls = await vote(components, VOTER, {
      patchError: () => new Error('poll edit failed')
    })
    expect(notices(calls)).toHaveLength(1)
    expect(notices(await vote(components))).toHaveLength(0)
    expect(kick).not.toHaveBeenCalled()
  })
  it('announces the final accepted vote even if the kick fails', async () => {
    manageCommunitySettings({ action: 'update', settings: { kickvoteThreshold: 2 } })
    const components = await startVote()
    await vote(components)
    kick.mockRejectedValueOnce(new Error('missing permissions'))
    const calls = await vote(components, OWNER)
    expect(notices(calls)).toHaveLength(1)
    expect(JSON.stringify(getEdit(calls))).toContain('추방에 실패')
    expect(notices(await vote(components, OWNER))).toHaveLength(0)
    expect(kick).toHaveBeenCalledTimes(1)
  })
  it('does not announce target votes, bot votes, cancellations or expired votes', async () => {
    const components = await startVote()
    expect(notices(await vote(components, TARGET))).toHaveLength(0)
    voterBot = true
    expect(notices(await vote(components))).toHaveLength(0)
    voterBot = false
    const cancelId = JSON.stringify(components).match(/community-kickvote:[a-f0-9]{32}:cancel/)![0]
    expect(notices(await vote(components, OWNER, {}, cancelId))).toHaveLength(0)
    const another = await startVote()
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(notices(await vote(another))).toHaveLength(0)
  })
  it('keeps accepted votes when a notice fails, never reannounces them or prevents quorum', async () => {
    manageCommunitySettings({ action: 'update', settings: { kickvoteThreshold: 2 } })
    const components = await startVote()
    const failNotice = {
      postError: (route: string) => (route === publicRoute ? new Error('notice failed') : undefined)
    }
    const first = await vote(components, VOTER, failNotice)
    expect(JSON.stringify(getEdit(first))).toContain('1/2')
    expect(runtimeIssueSummary()).toContain('kickvote_vote_notice')
    expect(notices(await vote(components))).toHaveLength(0)
    const final = await vote(components, OWNER, failNotice)
    expect(JSON.stringify(getEdit(final))).toContain('추방했습니다')
    expect(kick).toHaveBeenCalledTimes(1)
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
