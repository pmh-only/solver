import { join } from 'node:path'
import {
  ChannelType,
  Collection,
  GatewayIntentBits,
  IntentsBitField,
  MessageReferenceType,
  Partials,
  type Client,
  type Guild,
  type Message
} from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactionForwardHandler } from '../reaction-forward.js'
import { manageCommunitySettings } from '../community-settings.js'
import { clearStoredValues, getStoredValue, setStoredValue } from '../helpers/kv-store.js'
import { isolateStoredValues } from '../helpers/kv-store-test.js'
import { discordClientOptions } from '../discord-client-options.js'
import { dispatchMessage, commandJSON, dispatch, getCallback, makeSubcommands } from './e2e.js'
import { subcommand as list } from '../commands/list.js'

const GUILD = '333333333333333333'
const SOURCE = '777777777777777777'
const DESTINATION = '888888888888888888'
const ID = '1000000000000000001'
const FORWARDED = '1000000000000000002'
const SUMMARY = '1000000000000000003'
const AUTHOR = '555555555555555555'
const stateKey = `community:reaction-forward:${GUILD}`
const send = vi.fn()
const edit = vi.fn()
const deleteMessage = vi.fn()
const fetchChannel = vi.fn()

function reactions(counts: Array<[string, number]>) {
  return {
    cache: new Collection(
      counts.map(([emoji, count]) => [emoji, { count, emoji: { toString: () => emoji } }])
    )
  }
}
function sourceMessage(
  counts: Array<[string, number]> = [['⭐', 3]],
  overrides: Record<string, unknown> = {}
) {
  const source = {
    id: ID,
    guildId: GUILD,
    channelId: SOURCE,
    url: `https://discord.com/channels/${GUILD}/${SOURCE}/${ID}`,
    author: {
      id: AUTHOR,
      username: 'author',
      displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png'
    },
    member: { displayName: '작성자' },
    client: { channels: { fetch: fetchChannel } },
    reactions: reactions(counts),
    ...overrides
  } as unknown as Message
  source.fetch = vi.fn().mockResolvedValue(source)
  return source
}
function embedFrom(payload: unknown) {
  return JSON.parse(JSON.stringify((payload as { embeds: unknown[] }).embeds[0])) as {
    author: { name: string; url: string; icon_url: string }
    description: string
    footer: { text: string }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  isolateStoredValues(join(process.cwd(), '.tmp', 'reaction-forward.test.sqlite'))
  clearStoredValues()
  manageCommunitySettings({
    action: 'update',
    guildId: GUILD,
    settings: { reactionForward: { channelId: DESTINATION } }
  })
  send
    .mockReset()
    .mockImplementation(async (payload) => ({ id: payload.forward ? FORWARDED : SUMMARY }))
  edit.mockReset().mockResolvedValue({ id: SUMMARY })
  deleteMessage.mockReset().mockResolvedValue(undefined)
  fetchChannel.mockReset().mockResolvedValue({
    id: DESTINATION,
    guildId: GUILD,
    isSendable: () => true,
    send,
    messages: { edit, delete: deleteMessage }
  })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('reaction forwarding', () => {
  it('enables reaction events and partials for uncached messages', () => {
    expect(
      new IntentsBitField(discordClientOptions.intents).has(GatewayIntentBits.GuildMessageReactions)
    ).toBe(true)
    expect(discordClientOptions.partials).toEqual(
      expect.arrayContaining([Partials.Message, Partials.Channel, Partials.Reaction])
    )
  })
  it.each([0, 1, 2])('does not forward below the initial threshold (%s)', async (count) => {
    await createReactionForwardHandler()(sourceMessage([['⭐', count]]))
    expect(send).not.toHaveBeenCalled()
    expect(edit).not.toHaveBeenCalled()
  })
  it('sums different emoji counts, forwards natively once, then sends the author/count embed below it', async () => {
    const source = sourceMessage([
      ['⭐', 1],
      ['🔥', 2]
    ])
    await createReactionForwardHandler()(source)
    expect(source.fetch).toHaveBeenCalledWith(true)
    expect(send).toHaveBeenCalledTimes(2)
    const forward = send.mock.calls[0]![0]
    expect(forward).toMatchObject({
      forward: { message: ID, channel: SOURCE, guild: GUILD },
      allowedMentions: { parse: [], repliedUser: false },
      nonce: expect.any(String),
      enforceNonce: true
    })
    expect(forward).not.toHaveProperty('content')
    expect(forward).not.toHaveProperty('files')
    const summary = embedFrom(send.mock.calls[1]![0])
    expect(summary.author).toMatchObject({
      name: '작성자',
      url: `https://discord.com/users/${AUTHOR}`
    })
    expect(summary.description).toBe('⭐ **1**\n🔥 **2**')
    expect(summary.footer.text).toBe('총 3개 반응')
    expect(JSON.parse(getStoredValue(stateKey)!)[`${SOURCE}:${ID}`]).toMatchObject({
      channelId: DESTINATION,
      forwardedMessageId: FORWARDED,
      embedMessageId: SUMMARY
    })
  })
  it('updates above 3, freezes at 3, deletes at 2 or below, and forwards again when reactions recover', async () => {
    const handler = createReactionForwardHandler()
    const source = sourceMessage()
    await handler(source)
    source.reactions = reactions([
      ['⭐', 2],
      ['<a:dance:444444444444444444>', 3]
    ]) as never
    await handler(source)
    expect(edit).toHaveBeenCalledTimes(1)
    expect(edit).toHaveBeenLastCalledWith(
      SUMMARY,
      expect.objectContaining({ allowedMentions: { parse: [], repliedUser: false } })
    )
    expect(embedFrom(edit.mock.calls[0]![1]).description).toContain(
      '<a:dance:444444444444444444> **3**'
    )
    for (const count of [3, 2, 0]) {
      source.reactions = reactions(count ? [['🔥', count]] : []) as never
      await handler(source)
    }
    expect(edit).toHaveBeenCalledTimes(1)
    expect(deleteMessage.mock.calls.map(([id]) => id).sort()).toEqual([FORWARDED, SUMMARY].sort())
    source.reactions = reactions([['🔥', 4]]) as never
    await handler(source)
    expect(edit).toHaveBeenCalledTimes(1)
    expect(embedFrom(send.mock.calls[3]![0]).description).toBe('🔥 **4**')
    expect(send).toHaveBeenCalledTimes(4)
    expect(send.mock.calls[0]![0].nonce).not.toBe(send.mock.calls[2]![0].nonce)
  })
  it('does not edit for duplicate unchanged events and persists tracking across restarts', async () => {
    const source = sourceMessage([['⭐', 4]])
    await createReactionForwardHandler()(source)
    await createReactionForwardHandler()(source)
    expect(send).toHaveBeenCalledTimes(2)
    expect(edit).not.toHaveBeenCalled()
    source.reactions = reactions([['⭐', 5]]) as never
    await createReactionForwardHandler()(source)
    expect(send).toHaveBeenCalledTimes(2)
    expect(edit).toHaveBeenCalledTimes(1)
  })
  it.each([2, 1, 0])(
    'deletes both tracked posts at %s reactions, including after a restart',
    async (count) => {
      const source = sourceMessage()
      await createReactionForwardHandler()(source)
      source.reactions = reactions(count ? [['⭐', count]] : []) as never
      await createReactionForwardHandler()(source)
      expect(deleteMessage).toHaveBeenCalledTimes(2)
      expect(deleteMessage).toHaveBeenCalledWith(FORWARDED)
      expect(deleteMessage).toHaveBeenCalledWith(SUMMARY)
      expect(deleteMessage).not.toHaveBeenCalledWith(ID)
      expect(JSON.parse(getStoredValue(stateKey)!)[`${SOURCE}:${ID}`]).toMatchObject({
        deleted: true,
        embedMessageId: null
      })
      await createReactionForwardHandler()(source)
      expect(deleteMessage).toHaveBeenCalledTimes(2)
      source.reactions = reactions([['⭐', 3]]) as never
      await createReactionForwardHandler()(source)
      expect(send).toHaveBeenCalledTimes(4)
      expect(send.mock.calls[0]![0].nonce).not.toBe(send.mock.calls[2]![0].nonce)
      expect(JSON.parse(getStoredValue(stateKey)!)[`${SOURCE}:${ID}`]).not.toHaveProperty(
        'deleted',
        true
      )
    }
  )
  it('keeps both posts without editing or deleting at exactly 3 reactions', async () => {
    const handler = createReactionForwardHandler()
    const source = sourceMessage([['⭐', 5]])
    await handler(source)
    source.reactions = reactions([['🔥', 3]]) as never
    await handler(source)
    expect(edit).not.toHaveBeenCalled()
    expect(deleteMessage).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('treats already-deleted forwarded posts as success while still deleting the other post', async () => {
    const handler = createReactionForwardHandler()
    const source = sourceMessage()
    await handler(source)
    source.reactions = reactions([['⭐', 2]]) as never
    deleteMessage.mockRejectedValueOnce({ code: 10008 })
    await handler(source)
    expect(deleteMessage).toHaveBeenCalledTimes(2)
    expect(JSON.parse(getStoredValue(stateKey)!)[`${SOURCE}:${ID}`].deleted).toBe(true)
  })
  it('attempts both deletions and retains active tracking when one fails, then retries safely', async () => {
    const handler = createReactionForwardHandler()
    const source = sourceMessage()
    await handler(source)
    source.reactions = reactions([['⭐', 2]]) as never
    deleteMessage.mockRejectedValueOnce(new Error('missing permissions'))
    await expect(handler(source)).rejects.toThrow('missing permissions')
    expect(deleteMessage).toHaveBeenCalledTimes(2)
    expect(JSON.parse(getStoredValue(stateKey)!)[`${SOURCE}:${ID}`]).not.toHaveProperty(
      'deleted',
      true
    )
    deleteMessage.mockResolvedValueOnce(undefined).mockRejectedValueOnce({ code: 10008 })
    await handler(source)
    expect(JSON.parse(getStoredValue(stateKey)!)[`${SOURCE}:${ID}`].deleted).toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('deletes an incomplete forward if its author embed failed and reactions fall below 3', async () => {
    const handler = createReactionForwardHandler()
    const source = sourceMessage()
    send
      .mockImplementationOnce(async () => ({ id: FORWARDED }))
      .mockRejectedValueOnce(new Error('embed failed'))
    await expect(handler(source)).rejects.toThrow('embed failed')
    source.reactions = reactions([]) as never
    await handler(source)
    expect(deleteMessage).toHaveBeenCalledExactlyOnceWith(FORWARDED)
  })
  it('coalesces concurrent removals so each tracked post is deleted only once', async () => {
    const handler = createReactionForwardHandler()
    const source = sourceMessage()
    await handler(source)
    source.reactions = reactions([['⭐', 2]]) as never
    await Promise.all([handler(source), handler(source), handler(source)])
    expect(deleteMessage).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('coalesces overlapping events and refreshes the newest counts without duplicate forwards', async () => {
    let complete!: (value: { id: string }) => void
    send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const source = sourceMessage()
    const handler = createReactionForwardHandler()
    const first = handler(source)
    await vi.advanceTimersByTimeAsync(0)
    source.reactions = reactions([['🔥', 7]]) as never
    const second = handler(source)
    const third = handler(source)
    expect(second).toBe(first)
    complete({ id: FORWARDED })
    await Promise.all([first, second, third])
    expect(send).toHaveBeenCalledTimes(2)
    expect(edit).toHaveBeenCalledTimes(1)
    expect(embedFrom(edit.mock.calls[0]![1]).footer.text).toBe('총 7개 반응')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not lose tracking for different messages updating concurrently', async () => {
    const handler = createReactionForwardHandler()
    await Promise.all([
      handler(sourceMessage()),
      handler(sourceMessage([['🔥', 4]], { id: '1000000000000000009' }))
    ])
    expect(Object.keys(JSON.parse(getStoredValue(stateKey)!))).toHaveLength(2)
  })
  it('fetches an uncached partial message before reading reactions or author data', async () => {
    const full = sourceMessage()
    const partial = {
      id: ID,
      guildId: GUILD,
      channelId: SOURCE,
      partial: true,
      fetch: vi.fn().mockResolvedValue(full)
    } as unknown as Message
    await createReactionForwardHandler()(partial)
    expect(partial.fetch).toHaveBeenCalledWith(true)
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('supports bot and webhook messages as sources, not just user messages', async () => {
    const source = sourceMessage()
    Object.assign(source.author, { bot: true })
    await createReactionForwardHandler()(source)
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('ignores DMs, disabled settings and the destination channel to prevent loops', async () => {
    const handler = createReactionForwardHandler()
    const dm = sourceMessage([], { guildId: null })
    const board = sourceMessage([['⭐', 3]], { channelId: DESTINATION })
    await handler(dm)
    await handler(board)
    manageCommunitySettings({
      action: 'update',
      guildId: GUILD,
      settings: { reactionForward: null }
    })
    const disabled = sourceMessage()
    await handler(disabled)
    for (const source of [dm, board, disabled]) expect(source.fetch).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
  it('rejects a cross-guild or non-sendable destination', async () => {
    fetchChannel.mockResolvedValueOnce({ guildId: AUTHOR, isSendable: () => true })
    await expect(createReactionForwardHandler()(sourceMessage())).rejects.toThrow('same guild')
    fetchChannel.mockResolvedValueOnce({ guildId: GUILD, isSendable: () => false })
    await expect(createReactionForwardHandler()(sourceMessage())).rejects.toThrow('same guild')
    expect(send).not.toHaveBeenCalled()
  })
  it('rechecks configuration after an in-flight source fetch', async () => {
    let complete!: (value: Message) => void
    const source = sourceMessage()
    vi.mocked(source.fetch).mockReturnValueOnce(
      new Promise((resolve) => {
        complete = (value) => resolve(value as Awaited<ReturnType<Message['fetch']>>)
      })
    )
    const pending = createReactionForwardHandler()(source)
    manageCommunitySettings({
      action: 'update',
      guildId: GUILD,
      settings: { reactionForward: null }
    })
    complete(source)
    await pending
    expect(send).not.toHaveBeenCalled()
  })
  it('uses the newly configured destination without editing posts in the previous channel', async () => {
    const handler = createReactionForwardHandler()
    await handler(sourceMessage())
    manageCommunitySettings({
      action: 'update',
      guildId: GUILD,
      settings: { reactionForward: { channelId: AUTHOR } }
    })
    fetchChannel.mockResolvedValue({
      id: AUTHOR,
      guildId: GUILD,
      isSendable: () => true,
      send,
      messages: { edit }
    })
    await handler(sourceMessage())
    expect(send).toHaveBeenCalledTimes(4)
    expect(edit).not.toHaveBeenCalled()
    expect(send.mock.calls[0]![0].nonce).not.toBe(send.mock.calls[2]![0].nonce)
  })
  it('does not use stale data when source fetching fails and retries cleanly on the next event', async () => {
    const handler = createReactionForwardHandler()
    const source = sourceMessage()
    vi.mocked(source.fetch).mockRejectedValueOnce(new Error('missing permissions'))
    await expect(handler(source)).rejects.toThrow('missing permissions')
    expect(send).not.toHaveBeenCalled()
    await handler(source)
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('retries a failed forward without leaving invalid persisted state', async () => {
    send.mockRejectedValueOnce(new Error('forwarding unavailable'))
    const handler = createReactionForwardHandler()
    await expect(handler(sourceMessage())).rejects.toThrow('forwarding unavailable')
    expect(getStoredValue(stateKey)).toBeUndefined()
    await handler(sourceMessage())
    expect(send).toHaveBeenCalledTimes(3)
  })
  it('retries only the author embed if forwarding succeeded but sending the embed failed', async () => {
    send
      .mockImplementationOnce(async () => ({ id: FORWARDED }))
      .mockRejectedValueOnce(new Error('embed failed'))
    const handler = createReactionForwardHandler()
    await expect(handler(sourceMessage())).rejects.toThrow('embed failed')
    await handler(sourceMessage())
    expect(send.mock.calls.filter(([payload]) => payload.forward)).toHaveLength(1)
    expect(send).toHaveBeenCalledTimes(3)
  })
  it('does not advance the persisted signature if an embed edit failed', async () => {
    const handler = createReactionForwardHandler()
    const source = sourceMessage()
    await handler(source)
    const previous = getStoredValue(stateKey)
    source.reactions = reactions([['🔥', 5]]) as never
    edit.mockRejectedValueOnce(new Error('edit failed'))
    await expect(handler(source)).rejects.toThrow('edit failed')
    expect(getStoredValue(stateKey)).toBe(previous)
    await handler(source)
    expect(edit).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('bounds stalled source fetches and removes the in-flight job after timeout', async () => {
    const handler = createReactionForwardHandler()
    const source = sourceMessage()
    vi.mocked(source.fetch).mockReturnValueOnce(new Promise(() => {}))
    const failure = expect(handler(source)).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10000)
    await failure
    expect(vi.getTimerCount()).toBe(0)
    await handler(source)
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('fails closed on corrupt tracking and allows /a to reset tracking only', async () => {
    setStoredValue(stateKey, '{broken')
    await expect(createReactionForwardHandler()(sourceMessage())).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
    manageCommunitySettings({ action: 'reset-reaction-forwards', guildId: GUILD })
    await createReactionForwardHandler()(sourceMessage())
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('bounds retention and keeps new tracking instead of allowing unlimited records', async () => {
    const old = {
      channelId: DESTINATION,
      forwardedMessageId: FORWARDED,
      embedMessageId: SUMMARY,
      signature: '',
      updatedAt: Date.now() - 1
    }
    const records = Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [`${SOURCE}:${2000000000000000000n + BigInt(i)}`, old])
    )
    setStoredValue(stateKey, JSON.stringify(records))
    await createReactionForwardHandler()(sourceMessage())
    const stored = JSON.parse(getStoredValue(stateKey)!)
    expect(Object.keys(stored)).toHaveLength(1000)
    expect(stored[`${SOURCE}:${ID}`]).toMatchObject({ forwardedMessageId: FORWARDED })
  })
  it('keeps internal tracking hidden from /c list', async () => {
    await createReactionForwardHandler()(sourceMessage())
    const calls = await dispatch(commandJSON('list community'), makeSubcommands(list))
    expect(JSON.stringify(getCallback(calls))).not.toContain('reaction-forward:')
  })
})

describe('native Discord forwarding REST payload', () => {
  function configureClient(client: Client) {
    const guild = (client.guilds as unknown as { _add(data: unknown): Guild })._add({
      id: GUILD,
      name: 'test',
      owner_id: AUTHOR
    })
    for (const id of [SOURCE, DESTINATION]) {
      ;(client.channels as unknown as { _add(data: unknown, guild: Guild): unknown })._add(
        {
          id,
          guild_id: GUILD,
          name: 'channel',
          type: ChannelType.GuildText,
          permission_overwrites: []
        },
        guild
      )
    }
  }
  it('uses message_reference type Forward, followed by a separate embed, with mention parsing disabled', async () => {
    const handler = createReactionForwardHandler()
    let counter = 2
    const calls = await dispatchMessage(
      {
        id: ID,
        guild_id: GUILD,
        channel_id: SOURCE,
        type: 0,
        content: 'original',
        author: {
          id: AUTHOR,
          username: 'original-author',
          discriminator: '0',
          avatar: null,
          bot: false
        },
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: [],
        components: [],
        flags: 0,
        reactions: [{ emoji: { id: null, name: '⭐' }, count: 3, me: false }],
        timestamp: '2026-10-27T00:00:00Z'
      },
      {
        configureClient,
        postResult: () => ({
          id: String(1000000000000000000n + BigInt(counter++)),
          type: 0,
          channel_id: DESTINATION,
          content: '',
          embeds: [],
          components: [],
          attachments: [],
          flags: 0,
          author: {
            id: '999999999999999999',
            username: 'solver',
            discriminator: '0',
            avatar: null,
            bot: true
          }
        })
      },
      async (message) => {
        vi.spyOn(message, 'fetch').mockResolvedValue(
          message as Awaited<ReturnType<Message['fetch']>>
        )
        await handler(message)
        Object.assign(message.reactions.cache.first()!, { count: 2 })
        await handler(message)
      }
    )
    const posts = calls.filter((call) => call.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts.every((call) => call.route === `/channels/${DESTINATION}/messages`)).toBe(true)
    expect(posts[0]!.body).toMatchObject({
      message_reference: {
        type: MessageReferenceType.Forward,
        message_id: ID,
        channel_id: SOURCE,
        guild_id: GUILD
      },
      enforce_nonce: true,
      allowed_mentions: { parse: [], replied_user: false }
    })
    expect(posts[1]!.body).toMatchObject({
      embeds: [
        expect.objectContaining({
          author: expect.objectContaining({ name: 'original-author' }),
          description: '⭐ **3**'
        })
      ],
      allowed_mentions: { parse: [], replied_user: false }
    })
    expect(JSON.stringify(posts[0]!.body)).not.toContain('"content":"original"')
    const deletedRoutes = calls
      .filter((call) => call.method === 'DELETE')
      .map((call) => call.route)
      .sort()
    expect(deletedRoutes).toEqual(
      [
        `/channels/${DESTINATION}/messages/${FORWARDED}`,
        `/channels/${DESTINATION}/messages/${SUMMARY}`
      ].sort()
    )
    expect(deletedRoutes).not.toContain(`/channels/${SOURCE}/messages/${ID}`)
  })
})
